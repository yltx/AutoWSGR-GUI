const packageMetadata = require('../package.json');

const base = packageMetadata.build;

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: 'release/public',
  },
  extraResources: [
    ...base.extraResources,
    {
      from: 'build/backend-distributions/public.json',
      to: 'backend-distribution.json',
    },
  ],
  nsis: {
    ...base.nsis,
    include: 'build/installer.nsh',
    artifactName: 'AutoWSGR-GUI-Public-Setup-${version}.${ext}',
  },
};
