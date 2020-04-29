const { ENVIRONMENTS } = require('./constants');

const getEnvUrlString = env => {
  return env === ENVIRONMENTS.QA ? ENVIRONMENTS.QA : '';
};

const getHubSpotWebsiteOrigin = env => {
  return `https://app.hubspot${getEnvUrlString(env)}.com`;
};

const getHubSpotApiOrigin = (env, useLocalHost) => {
  return `https://${useLocalHost ? 'local' : 'api'}.hubapi${getEnvUrlString(
    env
  )}.com`;
};

module.exports = {
  getHubSpotWebsiteOrigin,
  getHubSpotApiOrigin,
};
