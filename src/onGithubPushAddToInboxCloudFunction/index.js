// gcloud beta functions deploy onGithubPushAddToCiInbox --trigger-http --stage-bucket sc-cloud-functions-staging-bucket --source .
// gcloud beta functions deploy onFolderEventUpdateGithubCommitStatus --trigger-bucket raw-ci-test-bucket --stage-bucket sc-cloud-functions-staging-bucket --source .

const Storage = require('@google-cloud/storage')

const config = require('./config')

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

const GITHUB_COMMIT_STATE_PENDING = "pending"
const GITHUB_COMMIT_STATE_SUCCESS = "success"
const GITHUB_COMMIT_STATE_FAILURE = "failure"

/**
 * see https://cloud.google.com/functions/docs/calling/http
 */
exports.onGithubPushAddToCiInbox = function(httpRequest, httpResponse) {
  console.log("onGithubPushAddToCiInbox", httpRequest.body)
  const gitSha = httpRequest.body.after
  const gitRef = httpRequest.body.ref // may be prefixed with "refs/heads/" or "refs/tags/"
  const gitShaFilePath = ciInboxFolder + "/" + gitSha
  bucket.file(gitShaFilePath).save(JSON.stringify({
    "githubRepoFullName": httpRequest.body.repository.full_name
  }))

  httpResponse.send(`bucket=${BUCKET} gitShaFilePath=${gitShaFilePath} gitRef=${gitRef}`)
}

function buildLogExternalUrl(gitSha) {
  return "https://storage.googleapis.com/" + BUCKET + "/" + buildLogFolder + "/" + gitSha + ".log"
}

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
      "description": description + " [RAWCI]"
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

function readFileContent(fileName, callback) {
  var content = ""
  bucket.file(fileName).createReadStream()
  .on('data', function(data) {
    content += data
  }).on('end', function() {
    callback(content)
  })
}

function deleteFile(fileName) {
  bucket.file(fileName).delete()
}

exports.onFolderEventUpdateGithubCommitStatus = function(event, callback) {
  console.log("onFolderEventUpdateGithubCommitStatus", event)
  const file = event.data;

  if (file.resourceState == "exists") {
    readFileContent(file.name, function(rawContent) {
      const jsonContent = JSON.parse(rawContent)

      function updateGitCommitState(githubGitCommitState) {
        httpPostGitShaStatusToGithub(
          jsonContent.githubRepoFullName,
          parseGitShaFromFileName(file.name),
          githubGitCommitState,
          "http://www.google.com",
          "this is the description"
        )
      }

      if (file.name.startsWith(ciInProgressFolder + "/")) {
        updateGitCommitState(GITHUB_COMMIT_STATE_PENDING)
      } else if (file.name.startsWith(ciSuccessFolder + "/")) {
        updateGitCommitState(GITHUB_COMMIT_STATE_SUCCESS)
        deleteFile(file.name)
      } else if (file.name.startsWith(ciFailureFolder + "/")) {
        updateGitCommitState(GITHUB_COMMIT_STATE_FAILURE)
        deleteFile(file.name)
      }
      callback()
    })
  } else {
    callback()
  }
}
