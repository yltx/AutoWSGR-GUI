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
if (!htmlIdSet.has('cfg-ocr-gpu-mode')) {
  throw new Error('OCR acceleration mode control is not mounted');
}
if (htmlIdSet.has('cfg-ocr-gpu')) {
  throw new Error('Legacy independent OCR GPU control must not be mounted');
}
if (!htmlIdSet.has('cfg-intensify-unlimited-materials')) {
  throw new Error('Unlimited intensify material batch control is not mounted');
}
if (!/id=["']cfg-intensify-unlimited-materials["'][^>]*type=["']checkbox["']|type=["']checkbox["'][^>]*id=["']cfg-intensify-unlimited-materials["']/.test(html)) {
  throw new Error('Unlimited intensify material batch control must be an explicit checkbox');
}
const intensifyMaximumInput = html.match(
  /<input\b[^>]*id=["']cfg-intensify-max-materials["'][^>]*>/,
)?.[0];
if (!intensifyMaximumInput || /\bmax\s*=/.test(intensifyMaximumInput)) {
  throw new Error('Finite intensify material batch control must not impose a maximum');
}
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
