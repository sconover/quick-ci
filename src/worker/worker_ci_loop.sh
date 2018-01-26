#!/bin/bash -e

gcs_bucket_name=$1

sanity_check_cmd="gsutil stat gs://$gcs_bucket_name/inbox/"
echo "sanity check: $sanity_check_cmd"
eval $sanity_check_cmd # sanity-check on bucket before entering main loop

shift
shift
command_to_run=$*

printf "POLLING gs://$gcs_bucket_name/inbox/ ..."
while true
do
  next_inbox_git_sha_path=$(gsutil ls gs://$gcs_bucket_name/inbox/ 2> /dev/null | grep -v '/$' | head -n 1)
  if [ -z "$next_inbox_git_sha_path" ]; then
    printf "."
  else
    echo ""
    echo "FOUND: '$next_inbox_git_sha_path'"
    echo "RUNNING: '$(basename $next_inbox_git_sha_path) time bash -c \"$command_to_run\"'"

    set +e
    # copied the command printed above to avoid weird bash interpolation problems...
    GIT_SHA=$(basename $next_inbox_git_sha_path) time bash -c "$command_to_run"
    if [ "$?" == "0" ]; then
      echo "BUILD SUCCESS"
    else
      echo "BUILD FAILURE"
    fi
    set -e

    rm_cmd="gsutil rm $next_inbox_git_sha_path"
    echo "CLEANUP: '$rm_cmd'"
    eval $rm_cmd
    printf "POLLING gs://$gcs_bucket_name/inbox/ ..."
  fi
done