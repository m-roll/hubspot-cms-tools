const path = require('path');
const { createModulePrompt } = require('../../lib/createModulePrompt');
const fs = require('fs-extra');
const { logger } = require('@hubspot/cli-lib/logger');

const createModule = (moduleDefinition, name, dest) => {
  const writeModuleMeta = ({ contentTypes, moduleLabel, global }, dest) => {
    const metaData = {
      label: moduleLabel,
      css_assets: [],
      external_js: [],
      global: global,
      help_text: '',
      host_template_types: contentTypes,
      js_assets: [],
      other_assets: [],
      smart_type: 'NOT_SMART',
      tags: [],
      is_available_for_new_content: false,
    };

    fs.writeJSONSync(dest, metaData, { spaces: 2 });
  };

  const moduleFileFilter = (src, dest) => {
    const emailEnabled = moduleDefinition.contentTypes.includes('EMAIL');

    switch (path.basename(src)) {
      case 'meta.json':
        writeModuleMeta(moduleDefinition, dest);
        return false;
      case 'module.js':
      case 'module.css':
        if (emailEnabled) {
          return false;
        }
        return true;
      default:
        return true;
    }
  };

  const assetPath = path.resolve(__dirname, '../../defaults/Sample.module');
  const folderName = name.endsWith('.module') ? name : `${name}.module`;
  const destPath = path.join(dest, folderName);
  if (fs.existsSync(destPath)) {
    logger.error(`The ${destPath} path already exists`);
    return;
  }
  logger.log(`Creating ${destPath}`);
  fs.mkdirp(destPath);
  logger.log(`Creating module at ${destPath}`);
  fs.copySync(assetPath, destPath, { filter: moduleFileFilter });
};

module.exports = {
  dest: ({ dest }) => dest,
  validate: ({ name }) => {
    if (!name) {
      logger.error(
        "The 'name' argument is required when creating a Custom Module."
      );
      return false;
    }

    return true;
  },
  execute: async ({ name, dest }) => {
    const moduleDefinition = await createModulePrompt();
    createModule(moduleDefinition, name, dest);
  },
};
