// see https://github.com/GoogleCloudPlatform/nodejs-getting-started/blob/master/3-binary-data/config.js

'use strict'

const nconf = module.exports = require('nconf')
const path = require('path')

nconf
  .argv()
  .file({ file: path.join(__dirname, 'config.json') })
  .defaults({})

checkConfig('BUCKET')
checkConfig('GCP_PROJECT')
checkConfig('GITHUB_ACCESS_TOKEN')
checkConfig('CI_INBOX_FOLDER')
checkConfig('CI_IN_PROGRESS_FOLDER')
checkConfig('CI_SUCCESS_FOLDER')
checkConfig('CI_FAILURE_FOLDER')
checkConfig('BUILD_LOG_FOLDER')
checkConfig('BUILD_NAME')
checkConfig('CLEAR_SHA_FILE_ON_SUCCESS')

function checkConfig (setting) {
  if (nconf.get(setting) == undefined || nconf.get(setting) == null) {
    throw new Error(`You must set ${setting} as an environment variable or in config.json!`)
  }
}