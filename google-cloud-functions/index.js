// gcloud beta functions deploy ci-onGithubPushTriggerNewBuild --entry-point=onGithubPushTriggerNewBuild --trigger-http --stage-bucket my-staging-bucket --source .
// gcloud beta functions deploy ci-onFolderEventUpdateGithubCommitStatus --entry-point=onFolderEventUpdateGithubCommitStatus --trigger-bucket my-build-bucket --stage-bucket my-staging-bucket --source .
// gcloud beta functions deploy ci-onFolderEventSendSlackNotification --entry-point=onFolderEventSendSlackNotification --trigger-bucket my-build-bucket --stage-bucket my-staging-bucket --source .

const Storage = require('@google-cloud/storage')

const config = require('./config')

// load settings from the config.json which was deployed alongside this script
const BUCKET = config.get('BUCKET')
const GCP_PROJECT = config.get('GCP_PROJECT')
const GITHUB_ACCESS_TOKEN = config.get('GITHUB_ACCESS_TOKEN')

const storage = Storage({projectId: GCP_PROJECT})
const bucket = storage.bucket(BUCKET)

const ciInboxFolder = config.get('CI_INBOX_FOLDER')
const ciInProgressFolder = config.get('CI_IN_PROGRESS_FOLDER')
const ciSuccessFolder = config.get('CI_SUCCESS_FOLDER')
const ciFailureFolder = config.get('CI_FAILURE_FOLDER')
const buildLogFolder = config.get('BUILD_LOG_FOLDER')
const buildName = config.get('BUILD_NAME')
const pubsubTopicName = buildName + "-topic";
const githubStatusContext = "raw-ci/" + buildName
const notifyNextTopicOnSuccess = config.get('NOTIFY_NEXT_TOPIC_ON_SUCCESS')
const notificationMessageSettings = config.get('NOTIFICATION_MESSAGE_SETTINGS')

const GITHUB_COMMIT_STATE_PENDING = "pending"
const GITHUB_COMMIT_STATE_SUCCESS = "success"
const GITHUB_COMMIT_STATE_FAILURE = "failure"

function publishMessage(topicName, gsFilePath, callback) {
  console.log("publish", gsFilePath)

  const PubSub = require('@google-cloud/pubsub');

  new PubSub()
    .topic(topicName)
    .publisher()
    .publish(Buffer.from(gsFilePath))
    .then(results => {
      const messageId = results[0]
      console.log("publish success", messageId, gsFilePath)
      callback()
    })
    .catch(err => {
      console.log("publish error", err, gsFilePath)
    })
}

function publishMessageToThisTopic(gsFilePath, callback) {
  publishMessage(pubsubTopicName, gsFilePath, callback)
}

function publishMessageToNextTopic(gsFilePath, callback) {
  publishMessage(notifyNextTopicOnSuccess, gsFilePath, callback)
}

function fileUrl(gitShaFilePath) {
  return "gs://" + BUCKET + "/" + gitShaFilePath
}

/**
 * Cloud function intended to be http-triggerable, which is
 * meant to be invoked by a Github webhook
 * (in a Github project, see Settings -> Webhooks)
 *
 * It:
 * - extracts important information about the git commit from the webhook request payload
 * - saves this information as the body of a build file
 * - names the build file after the git sha in question
 * - saves this build file to an "inbox" folder in the bucket.
 *   - the presence of a sha file in this folder implies that it is a build we desire to run
 * - finally, publishes a message out to this build's pubsub topic,
 *   which signals to the workers that a new build is ready/waiting.
 */
exports.onGithubPushTriggerNewBuild = function(httpRequest, httpResponse) {
  console.log("onGithubPushTriggerNewBuild", httpRequest.body)
  const gitSha = httpRequest.body.after
  const gitShaFilePath = ciInboxFolder + "/" + gitSha
  const fileContents = JSON.stringify({
    "githubRepoFullName": httpRequest.body.repository.full_name,
    "githubPushWebhookTimestampMillis": new Date().getTime(), // note: other reported build times are all relative to this github "entrypoint"
    "headCommitMessage": httpRequest.body.head_commit.message,
    "headCommiterUsername": httpRequest.body.head_commit.committer.username,
    "gitRef": httpRequest.body.ref,
    "gitBaseRef":  httpRequest.body.base_ref,
    "gitShaBefore": httpRequest.body.before,
    "gitSha": httpRequest.body.after
  })
  console.log("onGithubPushTriggerNewBuild-saveFile", gitShaFilePath, fileContents)
  bucket.file(gitShaFilePath).save(fileContents)

  publishMessageToThisTopic(fileUrl(gitShaFilePath), function() {
    httpResponse.send(`bucket=${BUCKET} gitShaFilePath=${gitShaFilePath}`)
  })
}

function buildLogExternalUrl(gitSha) {
  return "https://storage.googleapis.com/" + BUCKET + "/" + buildLogFolder + "/" + gitSha + ".log"
}

// Using the github api, change the status of a commit. This is what
// causes the Github UI to display a green success check, yellow in-progress dot,
// or red X, next to a commit. If the commit is part of a pull request,
// it factors into what makes the merge button go green in the PR.
//
// see https://developer.github.com/v3/repos/statuses/
function httpPostGitShaStatusToGithub(
  githubRepoFullName,
  gitCommitSha,
  githubGitCommitState,
  detailUrl,
  description) {
  const request = require('request')
  const postContent = {
    headers: {
      'Authorization' : "token " + GITHUB_ACCESS_TOKEN,
      'User-Agent': 'some-User-Agent'}, // github requires a user agent
    url: "https://api.github.com/repos/" + githubRepoFullName + "/statuses/" + gitCommitSha,
    body: JSON.stringify({
      "state": githubGitCommitState,
      "target_url": buildLogExternalUrl(gitCommitSha),
      "description": description + " [RAWCI]",
      "context": githubStatusContext
    })
  }
  console.log("httpPostGitShaStatusToGithub", postContent.url, postContent.body)
  request.post(postContent, function(error, response, body){
    console.log(error, body)
  })
}

function parseGitShaFromFileName(fileName) {
  return fileName.substring(fileName.lastIndexOf("/")+1)
}

function readFileContent(fileName, fileGeneration, callback) {
  var content = ""
  bucket.file(fileName, {generation: fileGeneration}).createReadStream()
  .on('data', function(data) {
    content += data
  }).on('end', function() {
    callback(content)
  })
}

function deleteFile(fileName) {
  bucket.file(fileName).delete()
}

function secondsSinceReferenceTime(referenceTimeMillis) {
  return "" + Math.round(Number((new Date().getTime()-referenceTimeMillis)/1000)) + "s"
}

/**
 * Cloud function that should fire whenever a change is made to the gcs bucket
 * that contains all build state. Based on what folder the file in question
 * is being placed in, this function will update the status of the corresponding
 * commit in Github to pending, success, or failure.
 */
exports.onFolderEventUpdateGithubCommitStatus = function(event, callback) {
  console.log("onFolderEventUpdateGithubCommitStatus", event)
  const file = event.data;

  if (file.resourceState == "exists" && parseGitShaFromFileName(file.name).match(/^[a-f0-9]{40}$/i)) {
    readFileContent(file.name, file.generation, function(rawContent) {
      console.log(file.name, rawContent)
      const jsonContent = JSON.parse(rawContent)

      const gitSha = parseGitShaFromFileName(file.name)

      function updateGitCommitState(githubGitCommitState) {
        httpPostGitShaStatusToGithub(
          jsonContent.githubRepoFullName,
          gitSha,
          githubGitCommitState,
          buildLogExternalUrl(gitSha),
          secondsSinceReferenceTime(jsonContent.githubPushWebhookTimestampMillis) +
          " from initial receipt to '" + githubGitCommitState + "'"
        )
      }

      // WARNING: it's entirely possible that a race exists between this function and the slack function.
      // if the file isn't in place at the time the slack function attempts to read the json payload,
      // the slack function will fail.
      // in theory, reading the file at the proper generation number should work, but initial try at
      // this doesn't seem promising.
      // If this problem crops up again, gotta consider what to do...

      if (file.name.startsWith(ciInProgressFolder + "/")) {
        updateGitCommitState(GITHUB_COMMIT_STATE_PENDING)
        callback()
      } else if (file.name.startsWith(ciSuccessFolder + "/")) {
        updateGitCommitState(GITHUB_COMMIT_STATE_SUCCESS)
        if (notifyNextTopicOnSuccess) { // leaving the file in place makes the success folder useful as the inbox for a subsequent pipeline step.
          publishMessageToNextTopic(fileUrl(file.name), callback)
        } else {
          deleteFile(file.name)
          callback()
        }
      } else if (file.name.startsWith(ciFailureFolder + "/")) {
        updateGitCommitState(GITHUB_COMMIT_STATE_FAILURE)
        deleteFile(file.name)
        callback()
      } else {
        throw new Error(`don't know how to handle file ${file.name}`)
      }
    })
  } else {
    callback()
  }
}

// Post a message to the slack webhook, the url for which
// was provided in config.json
//
// see http://slackapi.github.io/node-slack-sdk/
// see https://cloud.google.com/container-builder/docs/configure-third-party-notifications
function sendSlackNotification(messageText, callback) {
  console.log("sendSlackNotification", messageText)
  const IncomingWebhook = require('@slack/client').IncomingWebhook
  const slackWebhookUrl = config.get('SLACK_WEBHOOK_URL')
  const webhook = new IncomingWebhook(slackWebhookUrl)
  webhook.send(messageText, callback)
}

// simple template interpolation
// template: 'a {{color}} cat'
// value map: {color: 'red'}
// ...yields: 'a red cat'
function interpolate(template, valueMap) {
  return template.replace(/\{\{(.+?)\}\}/g,
    function(original, key) {
      if (valueMap[key] == undefined) {
        throw new Error(`value for template variable '${key}' not found in '${Object.keys(valueMap)}'`)
      }
      return valueMap[key]
    }
  );
};

const BUILD_STATE = {
  IN_PROGRESS: "inProgress",
  SUCCESS: "success",
  FAILURE: "failure"
}

function githubCompareUrl(githubRepoFullName, gitShaBefore, gitSha) {
  return `https://github.com/${githubRepoFullName}/compare/${gitShaBefore}...${gitSha}`
}

function githubGitShowCompareUrl(buildFileJsonContent) {
  return githubCompareUrl(buildFileJsonContent.githubRepoFullName, buildFileJsonContent.gitShaBefore, buildFileJsonContent.gitSha)
}

function githubDiffVsMasterUrl(buildFileJsonContent) {
  return githubCompareUrl(buildFileJsonContent.githubRepoFullName, "master", buildFileJsonContent.gitSha)
}

function shortGitSha(gitSha) {
  return gitSha.substring(0,7)
}

function determineGitRef(gitRef, gitBaseRef) {
  if (gitRef != null) {
    return gitRef
  }
  if (gitBaseRef != null) {
    return gitBaseRef
  }
  throw new Error("both git refs were null, unexpectedly")
}

function niceGitRef(gitRef) {
  return gitRef.replace("refs/heads/", "").replace("refs/tags/", "")
}

function niceGitRefTruncated(gitRef) {
  const str = niceGitRef(gitRef)
  return niceGitRef(gitRef).substring(0, str.length <= 30 ? str.length + 1 : 31)
}

function secondsSinceReferenceTime(referenceTimeMillis) {
  return "" + Math.round(Number((new Date().getTime()-referenceTimeMillis)/1000)) + "s"
}

function determineEmojiForGitRef(gitRef, gitRefEmojiMatchers) {
  const validMatchers = gitRefEmojiMatchers.filter(function(m){
    return gitRef.startsWith(m.startsWith)
  })

  if (validMatchers.length == 0) {
    throw new Error(`no emoji match found for gitref '${gitRef}'`)
  }

  return validMatchers[0].emojiShortcode
}

function commitMessageTruncated(fullCommitMessage) {
  var commitMessage = fullCommitMessage.replace(/\n/g, " ")
  if (commitMessage.length > 30) {
    commitMessage = commitMessage.substring(0, 28)
    commitMessage += "..."
    return commitMessage
  } else {
    return commitMessage
  }
}

function sendCommitStatusSlackNotification(currentBuildState, buildFileJsonContent, callback) {
  console.log("sendCommitStatusSlackNotification", currentBuildState, buildFileJsonContent)
  const messageTemplate = notificationMessageSettings["messageTemplate"]
  const gitRef = determineGitRef(buildFileJsonContent.gitRef, buildFileJsonContent.gitBaseRef)
  const valueMap = {
    buildEmojiShortcode: notificationMessageSettings["buildEmojiShortcode"],
    gitRefEmojiShortcode: determineEmojiForGitRef(gitRef, notificationMessageSettings["gitRefEmojiMatchers"]),
    buildStatusEmojiShortcode: notificationMessageSettings.buildStatusEmojiShortcodes[currentBuildState],
    githubGitShowUrl: githubGitShowCompareUrl(buildFileJsonContent),
    shortGitSha: shortGitSha(buildFileJsonContent.gitSha),
    timingSeconds: secondsSinceReferenceTime(buildFileJsonContent.githubPushWebhookTimestampMillis),
    githubDiffVsMasterUrl: githubDiffVsMasterUrl(buildFileJsonContent),
    gitRefTruncated: niceGitRefTruncated(gitRef),
    headCommitMessage: commitMessageTruncated(buildFileJsonContent.headCommitMessage),
    headCommiterUsername: buildFileJsonContent.headCommiterUsername,
    buildLogUrl: buildLogExternalUrl(buildFileJsonContent.gitSha)
  }
  const messageText = interpolate(messageTemplate, valueMap)
  sendSlackNotification(messageText, callback)
}

/**
 * Cloud function that reacts to changes in the build bucket. The contents of the
 * build file in question are read, and used to construct and send a slack notification
 * message.
 */
exports.onFolderEventSendSlackNotification = function(event, callback) {
  console.log("onFolderEventSendSlackNotification", event)
  const file = event.data;

  if (file.resourceState == "exists" && parseGitShaFromFileName(file.name).match(/^[a-f0-9]{40}$/i)) {
    const gitSha = parseGitShaFromFileName(file.name)

    readFileContent(file.name, file.generation, function(rawContent) {
      console.log(file.name, rawContent)
      const buildFileJsonContent = JSON.parse(rawContent)

      function notifyOf(currentBuildState) {
        sendCommitStatusSlackNotification(currentBuildState, buildFileJsonContent, callback)
      }

      if (file.name.startsWith(ciInProgressFolder + "/")) {
        notifyOf(BUILD_STATE.IN_PROGRESS)
      } else if (file.name.startsWith(ciSuccessFolder + "/")) {
        console.log("slack-success")
        notifyOf(BUILD_STATE.SUCCESS)
      } else if (file.name.startsWith(ciFailureFolder + "/")) {
        notifyOf(BUILD_STATE.FAILURE)
      } else {
        callback()
      }
    })
  } else {
    callback()
  }
}
