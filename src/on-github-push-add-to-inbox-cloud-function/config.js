// see https://github.com/GoogleCloudPlatform/nodejs-getting-started/blob/master/3-binary-data/config.js

'use strict';

const nconf = module.exports = require('nconf');
const path = require('path');

nconf
  .argv()
  .env([
    'CI_BUCKET'
  ])
  // 3. Config file
  .file({ file: path.join(__dirname, 'config.json') })
  // 4. Defaults
  .defaults({
    CI_BUCKET: '',
  });

checkConfig('CI_BUCKET');

function checkConfig (setting) {
  if (!nconf.get(setting)) {
    throw new Error(`You must set ${setting} as an environment variable or in config.json!`);
  }
}