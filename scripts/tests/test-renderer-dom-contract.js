const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const htmlPath = path.join(projectRoot, 'src', 'view', 'index.html');
const viewRoot = path.join(projectRoot, 'src', 'view');

const intentionallyUnmountedIds = new Map([
  ['btn-add-to-group', 'legacy plan action without a mounted control'],
  ['btn-create-template', 'template library UI is intentionally not mounted'],
  ['btn-import-template', 'template library UI is intentionally not mounted'],
  ['save-success-notice', 'created on demand by DialogHelper'],
  ['template-library-card', 'template library UI is intentionally not mounted'],
  ['template-library-items', 'template library UI is intentionally not mounted'],
]);

function collectFiles(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [fullPath] : [];
  });
}

function collectMatches(content, pattern) {
  return Array.from(content.matchAll(pattern), match => match[1]);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const updateChannelControl = html.match(
  /<select\b[^>]*\bid=["']cfg-allow-test-updates["'][^>]*>([\s\S]*?)<\/select>/,
);
if (!updateChannelControl) {
  throw new Error('Update channel control must be a select element');
}
const updateChannelOptions = collectMatches(
  updateChannelControl[1],
  /<option\b[^>]*\bvalue=["']([^"']+)["']/g,
);
if (
  updateChannelOptions.length !== 2
  || updateChannelOptions[0] !== 'stable'
  || updateChannelOptions[1] !== 'alpha'
) {
  throw new Error(
    'Update channel control must contain stable and alpha options',
  );
}
const htmlIds = collectMatches(
  html,
  /\bid\s*=\s*["']([^"']+)["']/g,
);
const duplicateIds = htmlIds.filter(
  (id, index) => htmlIds.indexOf(id) !== index,
);
if (duplicateIds.length > 0) {
  throw new Error(
    `Duplicate renderer DOM ids: ${Array.from(new Set(duplicateIds)).join(', ')}`,
  );
}

const referencedIds = new Map();
const referencePatterns = [
  /\bgetElementById\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\b(?:element|requiredElement)\s*(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g,
  /\bquerySelector(?:All)?\s*(?:<[^>]+>)?\s*\(\s*["']#([A-Za-z][\w:.-]*)["']/g,
];

for (const filePath of collectFiles(viewRoot, '.ts')) {
  const content = fs.readFileSync(filePath, 'utf8');
  for (const pattern of referencePatterns) {
    for (const id of collectMatches(content, pattern)) {
      const locations = referencedIds.get(id) ?? [];
      locations.push(path.relative(projectRoot, filePath));
      referencedIds.set(id, locations);
    }
  }
}

const htmlIdSet = new Set(htmlIds);
const missingIds = Array.from(referencedIds)
  .filter(([id]) => !htmlIdSet.has(id) && !intentionallyUnmountedIds.has(id))
  .map(([id, files]) => `${id} (${Array.from(new Set(files)).join(', ')})`);
if (missingIds.length > 0) {
  throw new Error(`Renderer DOM references are not mounted:\n${missingIds.join('\n')}`);
}

const staleAllowlist = Array.from(intentionallyUnmountedIds)
  .filter(([id]) => htmlIdSet.has(id) || !referencedIds.has(id))
  .map(([id, reason]) => `${id} (${reason})`);
if (staleAllowlist.length > 0) {
  throw new Error(`Stale renderer DOM allowlist entries:\n${staleAllowlist.join('\n')}`);
}

console.log(
  `renderer DOM contract passed (${htmlIds.length} ids, `
  + `${referencedIds.size} static references)`,
);
