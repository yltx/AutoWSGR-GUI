const fs = require('fs');
const path = require('path');

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'release',
  '.git',
]);

function shouldSkipFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return true;
  }

  const ext = path.extname(filePath).toLowerCase();
  const allowedExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.yaml', '.yml', '.py', '.css', '.scss', '.html', '.txt', '.bat', '.ps1', '.mjs', '.cjs'
  ]);

  if (allowedExts.has(ext)) {
    return false;
  }

  return stat.size > 1024 * 1024;
}

function countFileLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

function walk(dirPath, results) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        walk(fullPath, results);
      }
      continue;
    }

    if (!shouldSkipFile(fullPath)) {
      results.push({
        filePath: fullPath,
        lines: countFileLines(fullPath),
      });
    }
  }
}

function main() {
  const targetArg = process.argv[2] || process.cwd();
  const targetPath = path.resolve(targetArg);

  if (!fs.existsSync(targetPath)) {
    console.error(`Path not found: ${targetPath}`);
    process.exit(1);
  }

  const results = [];
  const stat = fs.statSync(targetPath);

  if (stat.isDirectory()) {
    walk(targetPath, results);
  } else if (!shouldSkipFile(targetPath)) {
    results.push({ filePath: targetPath, lines: countFileLines(targetPath) });
  }

  results.sort((a, b) => b.lines - a.lines);
  const totalLines = results.reduce((sum, item) => sum + item.lines, 0);

  console.log(`Target: ${targetPath}`);
  console.log(`Files: ${results.length}`);
  console.log(`Total lines: ${totalLines}`);

  for (const item of results) {
    console.log(`${item.lines.toString().padStart(6, ' ')}  ${path.relative(targetPath, item.filePath) || path.basename(item.filePath)}`);
  }
}

main();