/**
 * 按 AutoWSGR 主库目录同步地图，并生成 GUI 活动地图清单。
 * normal/event 转为 GUI JSON，decisive_battle 数据保持主库 YAML 原文。
 * 目标目录采用严格镜像，删除主库契约外的旧命名和重复资源。
 *
 * 用法:
 *   node scripts/sync-map-resources.js
 *   node scripts/sync-map-resources.js --backend C:\path\to\AutoWSGR
 *   node scripts/sync-map-resources.js --check
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const guiRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const backendArgIndex = args.indexOf('--backend');
const backendRoot = backendArgIndex >= 0
  ? path.resolve(args[backendArgIndex + 1] ?? '')
  : path.resolve(guiRoot, '..', 'AutoWSGR');
const checkOnly = args.includes('--check');
const sourceMapRoot = path.join(
  backendRoot,
  'autowsgr',
  'data',
  'map',
);
const sourceNormalRoot = path.join(sourceMapRoot, 'normal');
const sourceEventRoot = path.join(sourceMapRoot, 'event');
const sourceDecisiveRoot = path.join(sourceMapRoot, 'decisive_battle');
const targetMapRoot = path.join(guiRoot, 'resource', 'maps');
const targetNormalRoot = path.join(targetMapRoot, 'normal');
const targetEventRoot = path.join(targetMapRoot, 'event');
const targetDecisiveRoot = path.join(targetMapRoot, 'decisive_battle');

assert.equal(
  fs.existsSync(sourceNormalRoot)
    && fs.existsSync(sourceEventRoot)
    && fs.existsSync(sourceDecisiveRoot),
  true,
  `AutoWSGR 地图目录不完整: ${sourceMapRoot}`,
);

function writeOrCheck(filePath, content) {
  if (checkOnly) {
    assert.equal(
      fs.existsSync(filePath),
      true,
      `缺少同步文件: ${path.relative(guiRoot, filePath)}`,
    );
    assert.equal(
      fs.readFileSync(filePath, 'utf8'),
      content,
      `地图资源不是 AutoWSGR 主库最新数据: ${path.relative(guiRoot, filePath)}`,
    );
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function parseSourceFileName(fileName) {
  const oldMatch = fileName.match(/^([EH])-(\d+)\.ya?ml$/i);
  if (oldMatch) {
    return {
      chapter: oldMatch[1].toUpperCase(),
      map: oldMatch[2],
      targetName: fileName.replace(/\.ya?ml$/i, '.json'),
    };
  }

  const newMatch = fileName.match(/Ex-(\d+)-(α|β)\.ya?ml$/i);
  if (!newMatch) return null;
  const prefix = fileName.slice(0, newMatch.index);
  return {
    chapter: prefix.endsWith('H-') ? 'H' : 'E',
    map: `${newMatch[1]}${newMatch[2] === 'β' ? 'b' : 'a'}`,
    targetName: fileName.replace(/\.ya?ml$/i, '.json'),
  };
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function convertMap(source, existing) {
  const output = {};
  for (const [nodeId, rawPoint] of Object.entries(source)) {
    const positionOnly = Array.isArray(rawPoint);
    const point = (
      rawPoint
      && typeof rawPoint === 'object'
      && !positionOnly
    )
      ? rawPoint
      : {};
    const position = (
      positionOnly
        ? rawPoint
        : Array.isArray(point.position)
          ? point.position
          : [0, 0]
    ).map(Number);
    assert.equal(position.length, 2, `节点 ${nodeId} 缺少坐标`);
    assert.ok(position.every(Number.isFinite), `节点 ${nodeId} 坐标无效`);

    const previous = existing[nodeId] ?? {};
    const next = Array.isArray(point.next) ? point.next.map(String) : [];
    output[nodeId] = {
      type: typeof previous.type === 'string'
        ? previous.type
        : nodeId === '0' || nodeId === 'α' || nodeId === 'β'
          ? 'Start'
          : !positionOnly && next.length === 0
            ? 'Boss'
            : 'Normal',
      detour: previous.detour === true,
      night: previous.night === true,
      position,
      next,
    };
  }
  return output;
}

function mapSort(left, right) {
  const leftMatch = left.match(/^(\d+)([ab])?$/);
  const rightMatch = right.match(/^(\d+)([ab])?$/);
  if (!leftMatch || !rightMatch) return left.localeCompare(right);
  const stageDiff = Number(leftMatch[1]) - Number(rightMatch[1]);
  return stageDiff || (leftMatch[2] ?? '').localeCompare(rightMatch[2] ?? '');
}

function loadSourceMap(filePath) {
  const source = yaml.load(fs.readFileSync(filePath, 'utf8'));
  assert.ok(source && typeof source === 'object', `地图 YAML 无效: ${filePath}`);
  return source;
}

function syncNormalMaps() {
  let count = 0;
  const files = [];
  for (const file of fs.readdirSync(sourceNormalRoot).sort()) {
    if (!/^\d+-\d+\.ya?ml$/i.test(file)) continue;
    const targetName = file.replace(/\.ya?ml$/i, '.json');
    const targetPath = path.join(targetNormalRoot, targetName);
    const converted = convertMap(
      loadSourceMap(path.join(sourceNormalRoot, file)),
      readJson(targetPath),
    );
    writeOrCheck(targetPath, `${JSON.stringify(converted, null, 2)}\n`);
    files.push(targetPath);
    count += 1;
  }
  return { count, files };
}

function syncEventMaps() {
  const events = [];
  const targetFiles = [];
  let count = 0;
  const eventNames = fs.readdirSync(sourceEventRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{8}$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  assert.ok(eventNames.length > 0, 'AutoWSGR 主库没有活动地图数据');

  for (const eventName of eventNames) {
    const sourceDirectory = path.join(sourceEventRoot, eventName);
    const targetDirectory = path.join(targetEventRoot, eventName);
    const chapters = { E: [], H: [] };
    const files = { E: {}, H: {} };

    for (const file of fs.readdirSync(sourceDirectory).sort()) {
      const parsedName = parseSourceFileName(file);
      if (!parsedName) continue;
      const { chapter, map, targetName } = parsedName;
      assert.equal(
        files[chapter][map],
        undefined,
        `活动地图命名匹配歧义: ${eventName}/${chapter}-${map}`,
      );
      const targetPath = path.join(targetDirectory, targetName);
      const converted = convertMap(
        loadSourceMap(path.join(sourceDirectory, file)),
        readJson(targetPath),
      );
      writeOrCheck(targetPath, `${JSON.stringify(converted, null, 2)}\n`);
      targetFiles.push(targetPath);
      chapters[chapter].push(map);
      files[chapter][map] = targetName;
      count += 1;
    }

    chapters.E.sort(mapSort);
    chapters.H.sort(mapSort);
    if (chapters.E.length > 0 || chapters.H.length > 0) {
      events.push({
        event: eventName,
        chapters,
        files,
      });
    }
  }

  events.sort((left, right) => right.event.localeCompare(left.event));
  return { count, events, files: targetFiles };
}

function syncDecisiveBattleData() {
  const sourcePath = path.join(sourceDecisiveRoot, 'enemy_spec.yaml');
  const targetPath = path.join(targetDecisiveRoot, 'enemy_spec.yaml');
  assert.equal(
    fs.existsSync(sourcePath),
    true,
    `缺少决战地图数据: ${sourcePath}`,
  );
  writeOrCheck(targetPath, fs.readFileSync(sourcePath, 'utf8'));
  return targetPath;
}

function recursiveFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const value = path.join(root, entry.name);
    return entry.isDirectory() ? recursiveFiles(value) : [value];
  });
}

function recursiveDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const value = path.join(root, entry.name);
    return [value, ...recursiveDirectories(value)];
  });
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function expectedDirectories(files) {
  const directories = new Set([pathKey(targetMapRoot)]);
  for (const file of files) {
    let directory = path.dirname(file);
    while (pathKey(directory).startsWith(pathKey(targetMapRoot))) {
      directories.add(pathKey(directory));
      if (pathKey(directory) === pathKey(targetMapRoot)) break;
      directory = path.dirname(directory);
    }
  }
  return directories;
}

function cleanTarget(expectedFiles) {
  const expectedFileKeys = new Set(expectedFiles.map(pathKey));
  const extraFiles = recursiveFiles(targetMapRoot)
    .filter(file => !expectedFileKeys.has(pathKey(file)));
  const expectedDirectoryKeys = expectedDirectories(expectedFiles);
  const extraDirectories = recursiveDirectories(targetMapRoot)
    .filter(directory => !expectedDirectoryKeys.has(pathKey(directory)))
    .sort((left, right) => right.length - left.length);

  if (checkOnly) {
    assert.deepEqual(
      extraFiles.map(file => path.relative(guiRoot, file)).sort(),
      [],
      'GUI 地图目录存在主库契约外的文件',
    );
    assert.deepEqual(
      extraDirectories.map(directory => path.relative(guiRoot, directory)).sort(),
      [],
      'GUI 地图目录存在主库契约外的目录',
    );
    return { files: 0, directories: 0 };
  }

  for (const file of extraFiles) fs.rmSync(file, { force: true });
  for (const directory of extraDirectories) {
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
  }
  return {
    files: extraFiles.length,
    directories: extraDirectories.length,
  };
}

const normalResult = syncNormalMaps();
const eventResult = syncEventMaps();
const catalog = `${JSON.stringify({
  schema_version: 2,
  events: eventResult.events,
}, null, 2)}\n`;
const catalogPath = path.join(targetEventRoot, 'index.json');
writeOrCheck(catalogPath, catalog);
const decisivePath = syncDecisiveBattleData();
const cleaned = cleanTarget([
  ...normalResult.files,
  ...eventResult.files,
  catalogPath,
  decisivePath,
]);

console.log(
  `${checkOnly ? 'checked' : 'synced'} `
  + `${normalResult.count} normal maps, ${eventResult.count} event maps, `
  + 'and decisive_battle/enemy_spec.yaml; '
  + `removed ${cleaned.files} files and ${cleaned.directories} directories`,
);
