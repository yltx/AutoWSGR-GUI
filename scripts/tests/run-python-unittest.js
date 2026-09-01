const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [suite, pattern, label] = process.argv.slice(2);
if (!suite || !pattern || !label) {
  throw new Error(
    'Usage: node run-python-unittest.js <suite> <pattern> <label>',
  );
}

const projectRoot = path.resolve(__dirname, '..', '..');
const suitePath = path.resolve(projectRoot, suite);
const candidates = [
  process.env.AUTOWSGR_PYTHON,
  path.join(projectRoot, 'python', 'python.exe'),
  process.platform === 'win32' ? 'python' : 'python3',
].filter(Boolean);

const failures = [];
for (const python of candidates) {
  const result = spawnSync(
    python,
    ['-m', 'unittest', 'discover', '-s', suitePath, '-p', pattern],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.status === 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.log(`${label} tests passed`);
    process.exit(0);
  }
  failures.push(
    `${python}:\n${result.stdout || ''}${result.stderr || result.error || ''}`,
  );
}

throw new Error(`${label} tests failed:\n${failures.join('\n')}`);
