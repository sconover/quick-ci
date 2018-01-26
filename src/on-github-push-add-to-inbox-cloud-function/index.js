const Storage = require('@google-cloud/storage')

const Storage = require('@google-cloud/storage');
const config = require('./config');

const CI_BUCKET = config.get('CI_BUCKET');

const storage = Storage({
  projectId: config.get('GCP_PROJECT')
})
const bucket = storage.bucket(CLOUD_BUCKET);

/**
 * see https://cloud.google.com/functions/docs/calling/http
 */
exports.helloHttp = function helloHttp (httpRequest, httpResponse) {
  var gitRefRegex = /.*/

  var gitSha = httpRequest.body.after

  // may be prefixed with "refs/heads/" or "refs/tags/"
  var gitRef = httpRequest.body.ref

  httpResponse.send(`ciBucket=${CI_BUCKET} gitSha=${gitSha} gitRef=${gitRef} match=${gitRef.match(gitRefRegex)}`)
}