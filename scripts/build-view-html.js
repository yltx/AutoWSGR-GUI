const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src', 'view', 'html');
const entryPath = path.join(sourceRoot, 'index.html');
const outputPath = path.join(projectRoot, 'src', 'view', 'index.html');
const checkOnly = process.argv.includes('--check');
const includePattern = /^[ \t]*<!-- @include ([^<>]+) -->[ \t]*(?:\r?\n|$)/gm;

function render(filePath, stack = []) {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(sourceRoot, resolvedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`HTML include escapes source root: ${filePath}`);
  }
  if (stack.includes(resolvedPath)) {
    throw new Error(
      `Circular HTML include: ${[...stack, resolvedPath]
        .map(item => path.relative(sourceRoot, item))
        .join(' -> ')}`,
    );
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  return content.replace(includePattern, (_match, includePath) => (
    render(path.resolve(path.dirname(resolvedPath), includePath.trim()), [
      ...stack,
      resolvedPath,
    ])
  ));
}

const output = render(entryPath);
const current = fs.existsSync(outputPath)
  ? fs.readFileSync(outputPath, 'utf8')
  : '';

if (checkOnly) {
  if (current !== output) {
    throw new Error('src/view/index.html is stale; run npm run build:html');
  }
  console.log('renderer HTML is up to date');
} else if (current === output) {
  console.log('renderer HTML is already up to date');
} else {
  fs.writeFileSync(outputPath, output);
  console.log('generated src/view/index.html');
}
