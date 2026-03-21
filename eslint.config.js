const path = require('path');
const baseConfig = require(path.join(
  require.resolve('expo-module-scripts/package.json'),
  '..',
  'eslint.config.base.cjs'
));

// Override react plugin settings to avoid getFilename compatibility issue with ESLint 10
module.exports = baseConfig.map((config) => {
  if (config.settings?.react) {
    return {
      ...config,
      settings: {
        ...config.settings,
        react: { ...config.settings.react, version: '18' },
      },
    };
  }
  return config;
});
