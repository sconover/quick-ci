#!/bin/bash -e

access_token=$1
github_user=$2
github_repo=$3
git_sha=$4
sha_state=$5
sha_detail_url=$6
description=$7

exec curl -XPOST \
  -H "User-Agent: some-User-Agent" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$github_user/$github_repo/statuses/$git_sha?access_token=$access_token" \
  -d "{\"state\": \"$sha_state\", \"target_url\": \"$sha_detail_url\", \"description\": \"$description\"}"