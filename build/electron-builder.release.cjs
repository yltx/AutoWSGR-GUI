const packageMetadata = require('../package.json');

const base = packageMetadata.build;
const version = process.env.AUTOWSGR_RELEASE_VERSION
  || packageMetadata.version;
const channel = /^\d+\.\d+\.\d+$/.test(version)
  ? 'latest'
  : /^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/.test(version)
    ? 'alpha'
    : null;

if (!channel) {
  throw new Error(
    `Release version ${version} must be X.Y.Z or X.Y.Z-alpha[.N]`,
  );
}

module.exports = {
  ...base,
  extraMetadata: {
    version,
  },
  directories: {
    ...base.directories,
    output: `release/${channel}`,
  },
  publish: {
    ...base.publish,
    channel,
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
