#!/bin/bash -e

worker_id=$1
config_json_file=$2

gcs_bucket_name=$(jq -r .BUCKET < $config_json_file)
ci_inbox_folder=$(jq -r .CI_INBOX_FOLDER < $config_json_file)
ci_in_progress_folder=$(jq -r .CI_IN_PROGRESS_FOLDER < $config_json_file)
ci_success_folder=$(jq -r .CI_SUCCESS_FOLDER < $config_json_file)
ci_failure_folder=$(jq -r .CI_FAILURE_FOLDER < $config_json_file)
build_log_folder=$(jq -r .BUILD_LOG_FOLDER < $config_json_file)
build_name=$(jq -r .BUILD_NAME < $config_json_file)

if [ "null" = "$gcs_bucket_name" ]; then echo "missing BUCKET config value, exiting"; exit 1; fi
if [ "null" = "$ci_inbox_folder" ]; then echo "missing CI_INBOX_FOLDER config value, exiting"; exit 1; fi
if [ "null" = "$ci_in_progress_folder" ]; then echo "missing CI_IN_PROGRESS_FOLDER config value, exiting"; exit 1; fi
if [ "null" = "$ci_success_folder" ]; then echo "missing CI_SUCCESS_FOLDER config value, exiting"; exit 1; fi
if [ "null" = "$build_log_folder" ]; then echo "missing BUILD_LOG_FOLDER config value, exiting"; exit 1; fi

gs_inbox_url="gs://$gcs_bucket_name/$ci_inbox_folder"
gs_in_progress_url="gs://$gcs_bucket_name/$ci_in_progress_folder"
gs_success_url="gs://$gcs_bucket_name/$ci_success_folder"
gs_failure_url="gs://$gcs_bucket_name/$ci_failure_folder"
gs_build_log_url="gs://$gcs_bucket_name/$build_log_folder"

shift
shift
shift
command_to_run=$*

if [ -z "$command_to_run" ]; then echo "missing command to run, exiting"; exit 1; fi

pubsub_topic="$build_name-topic"
worker_subscription="$worker_id-worker"
gcloud beta pubsub subscriptions list | grep 'name: ' | grep "$worker_subscription" 1>/dev/null || \
  gcloud alpha pubsub subscriptions create "$worker_subscription" --topic="$pubsub_topic"

gsutil_mv() {
  message=$1
  from=$2
  to=$3

  echo "$message: gsutil mv $from $to"
  gsutil mv $from $to
}

maybe_gsutil_mv() {
  message=$1
  from=$2
  to=$3

  echo "$message: gsutil mv $from $to"
  set +e
  gsutil mv $from $to
  result=$?
  set -e
}

print_waiting_for_messages() {
  printf "WAITING FOR MESSAGES [pubsub topic=$pubsub_topic subscription=$worker_subscription] ..."
}

print_waiting_for_messages
while true
do
  set +e
  next_inbox_git_sha_path=$(timeout 10 gcloud alpha pubsub subscriptions pull "$worker_subscription" --auto-ack --format='csv[no-heading](DATA)' 2>/dev/null)
  set -e
  if [ -z "$next_inbox_git_sha_path" ]; then
    printf "."
    continue
  fi

  git_sha=$(basename $next_inbox_git_sha_path)

  in_progress_git_sha_path="$gs_in_progress_url/$git_sha"
  success_git_sha_path="$gs_success_url/$git_sha"
  failure_git_sha_path="$gs_failure_url/$git_sha"
  build_log_git_sha_path="$gs_build_log_url/$git_sha.log"

  echo ""

  # TODO: for multi-worker, whenever worker gets a non-zero return here, continues.
  maybe_gsutil_mv "ATTEMPT BUILD START" "$next_inbox_git_sha_path" "$in_progress_git_sha_path"

  if [ "0" != "$result" ]; then
    echo "BUILD START ATTEMPT UNSUCCESSFUL, SKIPPING"
    print_waiting_for_messages
    continue
  fi

  echo "RUNNING: 'time GIT_SHA=$git_sha bash -c \"date; $command_to_run\"'"

  set +e
  # copied the command printed above to avoid weird bash interpolation problems...
  # NOTE: build logs are shared publicly, with no basic auth etc.
  # If the git sha is private, this url will be impossible to guess.
  # ...Suggestions for additional capabilities here are certainly welcome.
  GIT_SHA=$git_sha bash -c "date; $command_to_run" 2>&1 | gsutil -h "Content-Type:text/plain" cp -a public-read - "$build_log_git_sha_path"
  if [ "${PIPESTATUS[0]}" == "0" ]; then
    gsutil_mv "BUILD SUCCESS" "$in_progress_git_sha_path" "$success_git_sha_path"
  else
    gsutil_mv "BUILD FAILURE" "$in_progress_git_sha_path" "$failure_git_sha_path"
  fi
  set -e

  echo "DONE: $git_sha"
  print_waiting_for_messages
done
