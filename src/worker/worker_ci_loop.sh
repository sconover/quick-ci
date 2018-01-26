#!/bin/bash -e

gcs_bucket_name=$1

sanity_check_cmd="gsutil stat gs://$gcs_bucket_name/inbox/"
echo "sanity check: $sanity_check_cmd"
eval $sanity_check_cmd # sanity-check listing before entering main loop

shift
shift
command_to_run=$*

while true
do
  next_inbox_git_sha_path=$(gsutil ls gs://$gcs_bucket_name/inbox/ 2> /dev/null | grep -v '/$' | head -n 1)
  if [ -z "$next_inbox_git_sha_path" ]; then
    printf "."
  else
    GIT_SHA=$(basename $next_inbox_git_sha_path) bash -c "$command_to_run"
  fi
done