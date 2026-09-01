const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..', '..');
const distRoot = path.join(root, 'dist');
const htmlRoot = path.join(root, 'src', 'view', 'html');
const styleRoot = path.join(root, 'src', 'view', 'styles');

function listFiles(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(target, extension);
      return entry.isFile() && entry.name.endsWith(extension)
        ? [target]
        : [];
    });
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll('\\', '/');
}

function assertSameFiles(actual, expected, label) {
  assert.deepEqual(
    [...actual].map(relative).sort(),
    [...expected].map(relative).sort(),
    `${label}存在缺失或孤立文件`,
  );
}

function assertFile(filePath, label) {
  assert.equal(
    fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
    true,
    `${label}缺失: ${relative(filePath)}`,
  );
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function collectDependencies(entryPath, sourceRoot, findDependencies) {
  const visited = new Set();
  const pending = [entryPath];
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    for (const dependency of findDependencies(filePath)) {
      const relativePath = path.relative(sourceRoot, dependency);
      assert.equal(
        !relativePath.startsWith('..') && !path.isAbsolute(relativePath),
        true,
        `构建依赖逃逸源码目录: ${relative(dependency)}`,
      );
      assertFile(dependency, '构建依赖');
      pending.push(dependency);
    }
  }
  return visited;
}

const typeScriptSources = [
  ...listFiles(path.join(root, 'electron'), '.ts'),
  ...listFiles(path.join(root, 'src'), '.ts'),
];
const expectedJavaScript = typeScriptSources.map(source => (
  path.join(
    distRoot,
    path.relative(root, source).replace(/\.ts$/, '.js'),
  )
));
const emittedJavaScript = [
  ...listFiles(path.join(distRoot, 'electron'), '.js'),
  ...listFiles(path.join(distRoot, 'src'), '.js'),
];
assertSameFiles(
  emittedJavaScript,
  expectedJavaScript,
  'TypeScript 编译产物',
);
for (const output of emittedJavaScript) {
  new vm.Script(fs.readFileSync(output, 'utf8'), {
    filename: relative(output),
  });
}

const rendererBundle = path.join(distRoot, 'renderer.bundle.js');
assertFile(rendererBundle, 'Renderer Bundle');
const rendererBundleContent = fs.readFileSync(rendererBundle);
new vm.Script(rendererBundleContent.toString('utf8'), {
  filename: relative(rendererBundle),
});

const rendererBuild = esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: [
    path.join(distRoot, 'src', 'controller', 'app', 'AppController.js'),
  ],
  bundle: true,
  outfile: rendererBundle,
  platform: 'browser',
  format: 'iife',
  external: [],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  metafile: true,
  write: false,
});
assert.equal(rendererBuild.outputFiles.length, 1);
assert.equal(
  sha256(rendererBuild.outputFiles[0].contents),
  sha256(rendererBundleContent),
  'Renderer Bundle 与当前构建配置不一致',
);

const expectedViewModules = listFiles(
  path.join(root, 'src', 'view'),
  '.ts',
).map(source => (
  path.join(distRoot, path.relative(root, source).replace(/\.ts$/, '.js'))
));
const rendererInputs = new Set(
  Object.keys(rendererBuild.metafile.inputs)
    .map(input => path.resolve(root, input)),
);
const missingViewModules = expectedViewModules
  .filter(modulePath => !rendererInputs.has(modulePath))
  .map(relative)
  .sort();
assert.deepEqual(
  missingViewModules,
  [],
  `View 未进入 Renderer Bundle:\n${missingViewModules.join('\n')}`,
);

const htmlSources = listFiles(htmlRoot, '.html');
const includePattern = /<!-- @include ([^<>]+) -->/g;
const reachableHtml = collectDependencies(
  path.join(htmlRoot, 'index.html'),
  htmlRoot,
  filePath => [...fs.readFileSync(filePath, 'utf8')
    .matchAll(includePattern)]
    .map(match => path.resolve(path.dirname(filePath), match[1].trim())),
);
assertSameFiles(reachableHtml, htmlSources, 'HTML partial');

function resolveSassDependency(importer, request) {
  const base = path.resolve(path.dirname(importer), request);
  const candidates = path.extname(base)
    ? [base]
    : [
      `${base}.scss`,
      path.join(path.dirname(base), `_${path.basename(base)}.scss`),
      path.join(base, 'index.scss'),
      path.join(base, '_index.scss'),
    ];
  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  assert.ok(resolved, `无法解析 SCSS 依赖: ${relative(importer)} -> ${request}`);
  return resolved;
}

const sassSources = listFiles(styleRoot, '.scss');
const sassUsePattern = /@(use|forward)\s+['"]([^'"]+)['"]\s*;/g;
const reachableSass = collectDependencies(
  path.join(styleRoot, 'main.scss'),
  styleRoot,
  filePath => [...fs.readFileSync(filePath, 'utf8')
    .matchAll(sassUsePattern)]
    .filter(match => !match[2].startsWith('sass:'))
    .map(match => resolveSassDependency(filePath, match[2])),
);
assertSameFiles(reachableSass, sassSources, 'SCSS partial');

const generatedHtml = fs.readFileSync(
  path.join(root, 'src', 'view', 'index.html'),
  'utf8',
);
assert.doesNotMatch(generatedHtml, /<!-- @include /);
assert.match(generatedHtml, /src="\.\.\/\.\.\/dist\/renderer\.bundle\.js"/);
assert.match(generatedHtml, /href="styles\/styles\.css"/);

const generatedCssPath = path.join(styleRoot, 'styles.css');
assertFile(generatedCssPath, 'Renderer CSS');
assert.ok(fs.statSync(generatedCssPath).size > 0, 'Renderer CSS 不能为空');

const packageJson = JSON.parse(fs.readFileSync(
  path.join(root, 'package.json'),
  'utf8',
));
assert.equal(packageJson.main, 'dist/electron/main.js');
assertFile(path.join(root, packageJson.main), 'Electron Main');
assertFile(path.join(distRoot, 'electron', 'preload.js'), 'Electron Preload');
const expectedPackagedFiles = [
  'dist/electron/**/*',
  'dist/src/shared/**/*',
  'dist/renderer.bundle.js',
  'src/view/index.html',
  'src/view/styles/styles.css',
  '!node_modules/.cache',
];
assert.deepEqual(
  packageJson.build.files,
  expectedPackagedFiles,
  '打包文件白名单必须只包含 Electron 运行产物',
);

console.log(
  'build output contract passed '
  + `(${typeScriptSources.length} TypeScript modules, `
  + `${expectedViewModules.length} bundled views, `
  + `${htmlSources.length} HTML sources, `
  + `${sassSources.length} SCSS sources)`,
);
