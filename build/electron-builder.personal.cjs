const packageMetadata = require('../package.json');

const base = packageMetadata.build;

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: 'release/personal',
  },
  extraResources: [
    ...base.extraResources,
    {
      from: 'build/backend-distributions/personal.json',
      to: 'backend-distribution.json',
    },
  ],
  nsis: {
    ...base.nsis,
    include: 'build/installer-personal.nsh',
    artifactName: 'AutoWSGR-GUI-Personal-Setup-${version}.${ext}',
  },
};
