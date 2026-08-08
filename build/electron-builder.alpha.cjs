const packageMetadata = require('../package.json');

const base = packageMetadata.build;

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: 'release/alpha',
  },
  extraResources: [
    ...base.extraResources,
    {
      from: 'build/backend-distribution.json',
      to: 'backend-distribution.json',
    },
  ],
  nsis: {
    ...base.nsis,
    include: 'build/installer.nsh',
  },
};
