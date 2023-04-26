const chokidar = require('chokidar');
const path = require('path');
const chalk = require('chalk');
const { default: PQueue } = require('p-queue');
const { i18n } = require('@hubspot/cli-lib/lib/lang');
const { logger } = require('@hubspot/cli-lib/logger');
const {
  isSpecifiedError,
} = require('@hubspot/cli-lib/errorHandlers/apiErrors');
const {
  logApiErrorInstance,
  ApiErrorContext,
} = require('@hubspot/cli-lib/errorHandlers');
const { ERROR_TYPES } = require('@hubspot/cli-lib/lib/constants');
const { isAllowedExtension } = require('@hubspot/cli-lib/path');
const { shouldIgnoreFile } = require('@hubspot/cli-lib/ignoreRules');
const {
  cancelStagedBuild,
  uploadFileToBuild,
  deleteFileFromBuild,
  provisionBuild,
  queueBuild,
} = require('@hubspot/cli-lib/api/dfs');
const SpinniesManager = require('./SpinniesManager');
const { EXIT_CODES } = require('./enums/exitCodes');
const { pollProjectBuildAndDeploy } = require('./projects');
const { uiAccountDescription } = require('./ui');

const i18nKey = 'cli.lib.LocalDevManager';

const BUILD_DEBOUNCE_TIME = 2000;

const WATCH_EVENTS = {
  add: 'add',
  change: 'change',
  unlink: 'unlink',
  unlinkDir: 'unlinkDir',
};

class LocalDevManager {
  constructor(options) {
    this.targetAccountId = options.targetAccountId;
    this.projectConfig = options.projectConfig;
    this.projectDir = options.projectDir;
    this.preventUploads = options.preventUploads;
    this.mockServers = options.mockServers || false;
    this.projectSourceDir = path.join(
      this.projectDir,
      this.projectConfig.srcDir
    );
    this.spinnies = null;
    this.watcher = null;
    this.uploadQueue = null;
    this.standbyChanges = [];
    this.debouncedBuild = null;
    this.currentStagedBuildId = null;

    if (!this.targetAccountId || !this.projectConfig || !this.projectDir) {
      process.exit(EXIT_CODES.ERROR);
    }
  }

  async start() {
    this.spinnies = SpinniesManager.init();

    this.watcher = chokidar.watch(this.projectSourceDir, {
      ignoreInitial: true,
      ignored: file => shouldIgnoreFile(file),
    });

    this.uploadQueue = new PQueue({ concurrency: 10 });

    if (this.debug) {
      this.uploadQueue.on('error', error => {
        logger.debug(error);
      });
    }

    this.startUploadQueue();
    await this.startServers();
    await this.startWatching();
  }

  async stop() {
    this.spinnies.removeAll();

    this.spinnies.add('cleanupMessage', {
      text: i18n(`${i18nKey}.exitingStart`),
    });

    await this.stopWatching();

    await this.cleanupServers();

    let exitCode = EXIT_CODES.SUCCESS;

    if (this.currentStagedBuildId) {
      try {
        await cancelStagedBuild(this.targetAccountId, this.projectConfig.name);
      } catch (err) {
        if (
          !isSpecifiedError(err, {
            subCategory: ERROR_TYPES.BUILD_NOT_IN_PROGRESS,
          })
        ) {
          logApiErrorInstance(
            err,
            new ApiErrorContext({
              accountId: this.targetAccountId,
              projectName: this.projectConfig.name,
            })
          );
          exitCode = EXIT_CODES.ERROR;
        }
      }
    }

    if (exitCode === EXIT_CODES.SUCCESS) {
      this.spinnies.succeed('cleanupMessage', {
        text: i18n(`${i18nKey}.exitingSucceed`),
      });
    } else {
      this.spinnies.fail('cleanupMessage', {
        text: i18n(`${i18nKey}.exitingFail`),
      });
    }

    process.exit(exitCode);
  }

  startUploadQueue() {
    this.uploadQueue.start();

    this.spinnies.removeAll();
    this.spinnies.add('devModeRunning', {
      text: i18n(`${i18nKey}.running`, {
        projectName: this.projectConfig.name,
        accountIdentifier: uiAccountDescription(this.targetAccountId),
      }),
      isParent: true,
    });
    if (this.preventUploads) {
      this.spinnies.add('preventUploadsBanner', {
        text: i18n(`${i18nKey}.preventUploadsBanner`),
        status: 'non-spinnable',
        indent: 1,
      });
    }
    this.spinnies.add('devModeStatus', {
      text: i18n(`${i18nKey}.status.clean`),
      status: 'non-spinnable',
      indent: 1,
    });
    this.spinnies.add('quitMessage', {
      text: i18n(`${i18nKey}.quitHelper`),
      status: 'non-spinnable',
      indent: 1,
    });
    this.spinnies.add('lineSeparator', {
      text: '-'.repeat(50),
      status: 'non-spinnable',
      noIndent: true,
    });
  }

  updateDevModeStatus(langKey) {
    this.spinnies.update('devModeStatus', {
      text: i18n(`${i18nKey}.status.${langKey}`),
      status: 'non-spinnable',
      noIndent: true,
    });
  }

  async pauseUploadQueue() {
    this.spinnies.removeAll();
    this.spinnies.add('uploading', {
      text: i18n(`${i18nKey}.upload.uploadingChanges`),
      isParent: true,
    });

    this.uploadQueue.pause();
    await this.uploadQueue.onIdle();
  }

  hasAnyUnsupportedStandbyChanges() {
    return this.standbyChanges.some(({ supported }) => !supported);
  }

  async createNewStagingBuild() {
    try {
      const { buildId } = await provisionBuild(
        this.targetAccountId,
        this.projectConfig.name
      );
      this.currentStagedBuildId = buildId;
    } catch (err) {
      logger.debug(err);
      if (isSpecifiedError(err, { subCategory: ERROR_TYPES.PROJECT_LOCKED })) {
        await cancelStagedBuild(this.targetAccountId, this.projectConfig.name);
        logger.log(i18n(`${i18nKey}.previousStagingBuildCancelled`));
      }
      process.exit(EXIT_CODES.ERROR);
    }
  }

  async startWatching() {
    if (!this.preventUploads) {
      await this.createNewStagingBuild();
    }

    this.watcher.on('add', async filePath => {
      this.handleWatchEvent(filePath, WATCH_EVENTS.add);
    });
    this.watcher.on('change', async filePath => {
      this.handleWatchEvent(filePath, WATCH_EVENTS.change);
    });
    this.watcher.on('unlink', async filePath => {
      this.handleWatchEvent(filePath, WATCH_EVENTS.unlink);
    });
    this.watcher.on('unlinkDir', async filePath => {
      this.handleWatchEvent(filePath, WATCH_EVENTS.unlinkDir);
    });
  }

  async handleWatchEvent(filePath, event) {
    const changeInfo = {
      event,
      filePath,
      remotePath: path.relative(this.projectSourceDir, filePath),
    };

    const isSupportedChange = await this.notifyServers(changeInfo);

    if (isSupportedChange) {
      this.updateDevModeStatus('supportedChange');
      this.addChangeToStandbyQueue({ ...changeInfo, supported: true });
      return;
    }

    if (this.preventUploads) {
      this.updateDevModeStatus('uploadPrevented');
      this.spinnies.add(filePath, {
        text: `${chalk.yellow('[WARNING]')} Upload prevented for ${
          changeInfo.remotePath
        }`,
        status: 'non-spinnable',
        indent: 1,
      });

      return;
    }

    if (this.uploadQueue.isPaused) {
      if (
        !this.standbyChanges.find(
          changeInfo => changeInfo.filePath === filePath
        )
      ) {
        this.addChangeToStandbyQueue({ ...changeInfo, supported: false });
      }
    } else {
      await this.flushStandbyChanges();

      if (!this.uploadQueue.isPaused) {
        this.debounceQueueBuild();
      }

      return this.uploadQueue.add(async () => {
        await this.sendChanges(changeInfo);
      });
    }
  }

  addChangeToStandbyQueue(changeInfo) {
    if (
      changeInfo.event === WATCH_EVENTS.add ||
      changeInfo.event === WATCH_EVENTS.change
    ) {
      if (!isAllowedExtension(changeInfo.filePath)) {
        logger.debug(`Extension not allowed: ${changeInfo.filePath}`);
        return;
      }
    }
    if (shouldIgnoreFile(changeInfo.filePath, true)) {
      logger.debug(`File ignored: ${changeInfo.filePath}`);
      return;
    }
    this.standbyChanges.push(changeInfo);
  }

  async sendChanges({ event, filePath, remotePath }) {
    this.spinnies.add(filePath, {
      text: `Uploading change for ${remotePath}`,
      status: 'non-spinnable',
      indent: 1,
    });
    try {
      if (event === WATCH_EVENTS.add || event === WATCH_EVENTS.change) {
        return uploadFileToBuild(
          this.targetAccountId,
          this.projectConfig.name,
          filePath,
          remotePath
        );
      } else if (
        event === WATCH_EVENTS.unlink ||
        event === WATCH_EVENTS.unlinkDir
      ) {
        return deleteFileFromBuild(
          this.targetAccountId,
          this.projectConfig.name,
          remotePath
        );
      }
    } catch (err) {
      logger.debug(err);
    }
  }

  debounceQueueBuild() {
    this.updateDevModeStatus('dirty');

    if (this.debouncedBuild) {
      clearTimeout(this.debouncedBuild);
    }

    this.debouncedBuild = setTimeout(async () => {
      await this.pauseUploadQueue();

      try {
        await queueBuild(this.targetAccountId, this.projectConfig.name);
      } catch (err) {
        logger.debug(err);
        if (
          isSpecifiedError(err, {
            subCategory: ERROR_TYPES.MISSING_PROJECT_PROVISION,
          })
        ) {
          logger.log(i18n(`${i18nKey}.logs.cancelledFromUI`));
          this.stop();
        } else {
          logApiErrorInstance(
            err,
            new ApiErrorContext({
              accountId: this.targetAccountId,
              projectName: this.projectConfig.name,
            })
          );
        }
        return;
      }

      await pollProjectBuildAndDeploy(
        this.targetAccountId,
        this.projectConfig,
        null,
        this.currentStagedBuildId,
        true
      );

      await this.createNewStagingBuild();

      this.startUploadQueue();

      if (this.hasAnyUnsupportedStandbyChanges()) {
        this.flushStandbyChanges();
      } else {
        this.updateDevModeStatus('clean');
      }
    }, BUILD_DEBOUNCE_TIME);
  }

  async flushStandbyChanges() {
    if (this.standbyChanges.length) {
      await this.uploadQueue.addAll(
        this.standbyChanges.map(changeInfo => {
          return async () => {
            if (!this.uploadQueue.isPaused) {
              this.debounceQueueBuild();
            }
            this.sendChanges(changeInfo);
          };
        })
      );
      this.standbyChanges = [];
    }
  }

  async stopWatching() {
    await this.watcher.close();
  }

  async startServers() {
    // TODO spin up local dev servers
    return true;
  }

  async notifyServers() {
    // TODO notify servers of the change
    return false;
  }

  async cleanupServers() {
    // TODO tell servers to cleanup
    return;
  }
}

module.exports = LocalDevManager;
