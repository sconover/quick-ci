// see https://github.com/GoogleCloudPlatform/nodejs-getting-started/blob/master/3-binary-data/config.js

'use strict';

const nconf = module.exports = require('nconf');
const path = require('path');

nconf
  .argv()
  .env([
    'BUCKET',
    'GCP_PROJECT',
    'GITHUB_ACCESS_TOKEN',
    'CI_INBOX_FOLDER'
  ])
  // 3. Config file
  .file({ file: path.join(__dirname, 'config.json') })
  // 4. Defaults
  .defaults({});

checkConfig('BUCKET');
checkConfig('GCP_PROJECT');
checkConfig('GITHUB_ACCESS_TOKEN');
checkConfig('CI_INBOX_FOLDER');
checkConfig('CI_IN_PROGRESS_FOLDER');
checkConfig('CI_SUCCESS_FOLDER');
checkConfig('CI_FAILURE_FOLDER');

function checkConfig (setting) {
  if (!nconf.get(setting)) {
    throw new Error(`You must set ${setting} as an environment variable or in config.json!`);
  }
}