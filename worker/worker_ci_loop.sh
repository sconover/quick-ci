#!/bin/bash -e

# unique worker id, which is incorporated into the pubsub topic subscription name
worker_id=$1

# the same config.json used ni the cloud function deployments
config_json_file=$2

# grab various config settings out of config.json with jq
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

# "folders" in the gcs bucket, representing the various build states
# so, the presence of a file named after a git sha in any of these folders implies
# that that build (represented by the file) is in that state (represented by the folder)
gs_inbox_url="gs://$gcs_bucket_name/$ci_inbox_folder"
gs_in_progress_url="gs://$gcs_bucket_name/$ci_in_progress_folder"
gs_success_url="gs://$gcs_bucket_name/$ci_success_folder"
gs_failure_url="gs://$gcs_bucket_name/$ci_failure_folder"
gs_build_log_url="gs://$gcs_bucket_name/$build_log_folder"

shift
shift
shift

# the worker script incantation ends with "-- your ci command goes here"
# "shift"-off the first three args, then use all remaining args as the ci command to run
command_to_run=$*

if [ -z "$command_to_run" ]; then echo "missing command to run, exiting"; exit 1; fi

# The topic that workers for this build stage will listen on for new messages, that
# instruct them to attempt to build.
# the pubsub topic should already have been created under https://console.cloud.google.com/cloudpubsub/topicList
pubsub_topic="$build_name-topic"

# The worker's specific topic subscription. This subscription means that if the worker
# disconnects from pubsub, messages intended for that worker will still accumulate.
worker_subscription="$worker_id-worker"
gcloud beta pubsub subscriptions list | grep 'name: ' | grep "$worker_subscription" 1>/dev/null || \
  gcloud alpha pubsub subscriptions create "$worker_subscription" --topic="$pubsub_topic"

# gcs operation to move a file, from one path to another, within the bucket
# This is not an atomic operation as is true of mv on a normal filesystem,
# instead it's a copy to the new path, followd by a remove of the old path.
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

  # Wait a brief period of time (usually several seconds) for a message to arrive.
  # If a message arrives, the command will return immediately, with the data from
  # the message. This is the data the cloud function has published to the topic -
  # is the gs:// path to where the file representing the build has been created,
  # typically in a folder having "inbox" in its name.
  #
  # In the case that there are no messages available during the waiting period
  # (the usual case), the command returns with a non-zero exit code and the
  # data will be blank.
  #
  # There is an upper bound of 10s to ensure that this never blocks for too long,
  # and so we can demonstrate that the worker is properly operating by printing
  # a "." to the console.
  set +e

  # use of gcloud tools can result in all inodes being used up https://groups.google.com/forum/#!topic/google-appengine/8jY242lvAHk
  find ~/.config/gcloud/logs -mindepth 1 -mtime +2 -delete

  next_inbox_git_sha_path=$(timeout 10 gcloud alpha pubsub subscriptions pull "$worker_subscription" --auto-ack --format='csv[no-heading](DATA)' 2>/dev/null)
  set -e

  # short-circuit the loop if there's no build to run.
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

  # This is an attempt to move the build file into the "in progress" folder,
  # which may not succeed if other workers are simultaneously trying to build
  # this sha (the "remove" operation in the mv should only succeed for a single
  # worker).
  #
  # This SHOULD allow this ci system to be safely and effciently scale to
  # any number of workers, however I have not yet shown this to work in practice,
  # by way of (say) a convincing demonstration. TODO. Don't rely on this assumption,
  # until such a test/demonstration occurs.
  maybe_gsutil_mv "ATTEMPT BUILD START" "$next_inbox_git_sha_path" "$in_progress_git_sha_path"

  # short-circuit the loop if this worker did not successfully mv the build file into the "in progress" folder
  if [ "0" != "$result" ]; then
    echo "BUILD START ATTEMPT UNSUCCESSFUL, SKIPPING"
    print_waiting_for_messages
    continue
  fi

  # run a build. The build command is under full control of the user.
  # A build script will typically look something like:
  #
  # ===================
  # #!/bin/bash -ex
  #
  # time git fetch origin
  # git checkout $GIT_SHA
  # time bazel test //...
  # ===================
  #
  # Note the use of the GIT_SHA environment variable, which is the sole
  # input provided by this worker.
  #
  # This script should be made executable, and provided as the last argument
  # in the incantation which starts this build loop.
  echo "RUNNING: 'time GIT_SHA=$git_sha bash -c \"date; $command_to_run\"'"
  echo "RUNNING: 'time GIT_SHA=$git_sha bash -c \"date; $command_to_run\"'" > /tmp/$worker_id

  set +e

  # NOTE: build logs are shared publicly, with no basic auth etc.
  # If the git sha is private, this url will be impossible to guess.
  # ...Suggestions for additional capabilities here are certainly welcome.
  GIT_SHA=$git_sha bash -c "date; $command_to_run" 2>&1 | gsutil -h "Content-Type:text/plain" cp -a public-read - "$build_log_git_sha_path"

  # Build success/failure is determined by the exit code of the build command.
  #
  # The git-sha file representing the build gets move to either the success or
  # failure folder in the gcs bucket.
  if [ "${PIPESTATUS[0]}" == "0" ]; then
    gsutil_mv "BUILD SUCCESS" "$in_progress_git_sha_path" "$success_git_sha_path"
  else
    gsutil_mv "BUILD FAILURE" "$in_progress_git_sha_path" "$failure_git_sha_path"
  fi
  set -e

  echo "DONE: $git_sha"
  print_waiting_for_messages
done
