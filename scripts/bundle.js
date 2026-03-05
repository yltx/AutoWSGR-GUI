const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'dist', 'src', 'controller', 'AppController.js')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'renderer.bundle.js'),
  platform: 'browser',
  format: 'iife',
  external: [],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log('✓ renderer.bundle.js built');
