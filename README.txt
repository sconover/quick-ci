Goals, now:

- Speed is the #1 feature
- Annotate a GH commit with status information as quickly as possible
- Simple, even simplistic: bash scripts + GCP-hosted functions/storage. Your daemon is something like screen/tmux. Like fixing a bicycle (vs a car).
- New, arbitrarily different builds are easy to set up
- One click to see build output: build logs are available via the web, linked up in notifications / GH status detail
- Decent notification options (slack etc)
- Aimed at hermetic build environments (like bazel provides), where output can be reused across builds with a high degree of confidence

Goals, later:
- Multi-worker: Use sha files in gcs as the basis of a lease,
  Use gcs write preconditions to ensure only one worker owns a
  given sha at any given time. Renew lease every N seconds (15?)
  and other workers forcibly take over a sha at ~120s.
- Some docs around making a git-based build workflow based on this system



= Setup =

Clone this repo on a build server (it's probably easiest if this server is managed by GCE)


== CONFIG.JSON ==

Under google-cloud-functions:

cp config-default.json config.json

config.json is used by the various google cloud functions and by the worker ci loop script. It should live in the google-cloud-functions directory.
It is .gitignore'd.

You'll need to fill out values custom for your environment in config.json:

BUCKET: This is the GCS bucket that will be the coordination point for the build, where build logs will live, and so on.
GCP_PROJECT: The google cloud platform project under which the bucket lives
GITHUB_ACCESS_TOKEN: A personal access token used to invoke github api functions.
  In github:
    - Go to your account Settings -> Developer Settings -> Personal access tokens
    - Make a new token, and for its scope ONLY check "repo:status"
    - Paste in the resulting random token string as the value for GITHUB_ACCESS_TOKEN
CI_*: These are subfolder names the build uses, you can leave the default names for now.
BUILD_LOG_FOLDER: Where publicly-accessible build logs will go. You probably want to just use the default value.
GITHUB_STATUS_CONTEXT: Used to distinguish multiple kinds of status updates within a single git commit in github.
  This only matters if you have multiple build stages that affect commit status. You probably will just want to use the default value.


== CLOUD FUNCTIONS ==

1a) Set up the cloud function that the github on-push-event webhook will invoke

cd google-cloud-functions
gcloud beta functions deploy someMainCIonGithubPushAddToCiInbox --entry-point=onGithubPushAddToCiInbox --trigger-http --stage-bucket your-cloud-functions-staging-bucket --source .

This operation will print the httpsTrigger to the console, for example:

httpsTrigger:
  url: https://us-central1-yourproject.cloudfunctions.net/someMainCIonGithubPushAddToCiInbox

You'll now plug this url into a github webhook.

1b) Github webhook setup

This step will make it so github invokes the someMainCIonGithubPushAddToCiInbox https endpoint upon any push event, for your github-hosted repo.

Go to your project on github:
  - Go to project Settings -> Webhooks
  - Add Webhook:
    Payload URL: the aforementioned url printed to the console
    Content type: application/json
    [TODO: Shared secret]
    Which events would you like to trigger this webhook?: Just the push event.
    Active: checked
  - Note that if you edit the webhook, and scroll to the bottom of the page, you see "recent deliveries".
    You can open up a recent delivery, and click the "Redeliver" button to test the webhook.

2) Set up the cloud function will be invoked on finle writes to the bucket

cd google-cloud-functions
gcloud beta functions deploy someMainCIonFolderEvent --entry-point=onFolderEventUpdateGithubCommitStatus --trigger-bucket your-gcs-bucket --stage-bucket your-cloud-functions-staging-bucket --source .

Note the functions are now in:
https://console.cloud.google.com/functions/list
...and in particular, that you can view log output of each function

[optional] 3) Set up the slack cloud function

cd google-cloud-functions
gcloud beta functions deploy someMainCIonFolderEventSlack --entry-point=onFolderEventSendSlackNotification --trigger-bucket your-gcs-bucket --stage-bucket your-cloud-functions-staging-bucket --source .

== WORKER CI LOOP ==

[TODO: various apt commands to install dependencies]

You will want to invoke a key project ci command, e.g. run all tests. For example, from a cloned git repo of a bazel-based project:

../raw-ci/worker/worker_ci_loop.sh ../raw-ci/google-cloud-functions/config.json -- 'git fetch origin && git checkout $GIT_SHA && time bazel test //...'

This:
  - Invokes the worker ci loop script in the raw-ci repo you cloned on the build host (sibling to the bazel-based project)
  - Points at the config.json you set up in step one - and notably, which is shared by the google cloud functions
  - Provides a ci command that fetches the git repo, checks out the $GIT_SHA commit (this is an environment variable)
    provided by the worker script), and runs all tests.

Once started, a dot will be printed for every time the ci loop checks the bucket for new build work to do, and doesn't find any.
Trigger a build using the "Redeliver" button mentioned in step one, or by pushing a change to your git repo.
There are many tricks for keeping the ci loop running outside of a given ssh session, such as screen/tmux.
