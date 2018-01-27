#!/bin/bash -e

config_json_file=$1

gcs_bucket_name=$(jq -r .BUCKET < $config_json_file)
ci_inbox_folder=$(jq -r .CI_INBOX_FOLDER < $config_json_file)
ci_in_progress_folder=$(jq -r .CI_IN_PROGRESS_FOLDER < $config_json_file)
ci_success_folder=$(jq -r .CI_SUCCESS_FOLDER < $config_json_file)
ci_failure_folder=$(jq -r .CI_FAILURE_FOLDER < $config_json_file)
build_log_folder=$(jq -r .BUILD_LOG_FOLDER < $config_json_file)

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

sanity_check_cmd="gsutil ls gs://$gcs_bucket_name"
echo "sanity check: $sanity_check_cmd"
eval $sanity_check_cmd # sanity-check on bucket before entering main loop

shift
shift
command_to_run=$*

if [ -z "$command_to_run" ]; then echo "missing command to run, exiting"; exit 1; fi

gsutil_mv() {
  message=$1
  from=$2
  to=$3

  echo "$message: gsutil mv $from $to"
  gsutil mv $from $to
}

printf "POLLING $gs_inbox_url ..."
while true
do
  next_inbox_git_sha_path=$(gsutil ls $gs_inbox_url/ 2> /dev/null | grep -v '/$' | head -n 1)
  if [ -z "$next_inbox_git_sha_path" ]; then
    printf "."
  else
    echo ""
    echo "FOUND: '$next_inbox_git_sha_path'"

    git_sha=$(basename $next_inbox_git_sha_path)

    in_progress_git_sha_path="$gs_in_progress_url/$git_sha"
    success_git_sha_path="$gs_success_url/$git_sha"
    failure_git_sha_path="$gs_failure_url/$git_sha"
    build_log_git_sha_path="$gs_build_log_url/$git_sha.log"

    gsutil_mv "BUILD IN PROGRESS" "$next_inbox_git_sha_path" "$in_progress_git_sha_path"
    echo "RUNNING: 'GIT_SHA=$git_sha bash -c \"time $command_to_run\"'"

    set +e
    # copied the command printed above to avoid weird bash interpolation problems...
    # NOTE: build logs are shared publicly, with no basic auth etc.
    # If the git sha is private, this url will be impossible to guess.
    # ...Suggestions for additional capabilities here are certainly welcome.
    GIT_SHA=$git_sha bash -c "time $command_to_run" 2>&1 | gsutil -h "Content-Type:text/plain" cp -a public-read - "$build_log_git_sha_path"
    if [ "$?" == "0" ]; then
      gsutil_mv "BUILD SUCCESS" "$in_progress_git_sha_path" "$success_git_sha_path"
    else
      gsutil_mv "BUILD FAILURE" "$in_progress_git_sha_path" "$failure_git_sha_path"
    fi
    set -e

    echo "DONE: $git_sha"
    printf "POLLING $gs_inbox_url ..."
  fi
done