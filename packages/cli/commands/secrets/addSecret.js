const { logger } = require('@hubspot/cli-lib/logger');
const {
  logServerlessFunctionApiErrorInstance,
  ApiErrorContext,
} = require('@hubspot/cli-lib/errorHandlers');
const { addSecret } = require('@hubspot/cli-lib/api/secrets');

const { loadAndValidateOptions } = require('../../lib/validation');
const { trackCommandUsage } = require('../../lib/usageTracking');

const {
  addConfigOptions,
  addAccountOptions,
  addUseEnvironmentOptions,
  getAccountId,
} = require('../../lib/commonOpts');
const { secretValuePrompt } = require('../../lib/secretPrompt');

exports.command = 'add <name>';
exports.describe = 'Add a HubSpot secret';

exports.handler = async options => {
  const { name: secretName } = options;

  await loadAndValidateOptions(options);

  const accountId = getAccountId(options);
  trackCommandUsage('secrets-add', {}, accountId);

  try {
    const { secretValue } = await secretValuePrompt();

    await addSecret(accountId, secretName, secretValue);
    logger.log(
      `The secret "${secretName}" was added to the HubSpot account: ${accountId}`
    );
  } catch (e) {
    logger.error(`The secret "${secretName}" was not added`);
    await logServerlessFunctionApiErrorInstance(
      accountId,
      e,
      new ApiErrorContext({
        request: 'add secret',
        accountId,
      })
    );
  }
};

exports.builder = yargs => {
  addConfigOptions(yargs, true);
  addAccountOptions(yargs, true);
  addUseEnvironmentOptions(yargs, true);
  yargs.positional('name', {
    describe: 'Name of the secret',
    type: 'string',
  });
  return yargs;
};
