/**
 * 用户计划批量导出服务测试。
 *
 * 使用真实临时文件验证 ZIP 目录、原始 YAML 内容、去重和路径边界。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const JSZip = require('jszip');
const yaml = require('js-yaml');
const {
  AtomicFileStore,
  fs,
  temporaryDirectory,
} = require('./test-context');
const {
  PlanExportService,
} = require('../../../dist/electron/services/PlanExportService.js');

async function testPlanExportService() {
  const root = path.join(temporaryDirectory, 'plan-export');
  const userBattleDirectory = path.join(root, 'user_battle_plans');
  const userTeamDirectory = path.join(root, 'user_team_plans');
  fs.mkdirSync(userBattleDirectory, { recursive: true });
  fs.mkdirSync(userTeamDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(userBattleDirectory, 'bettle-test.yaml'),
    [
      '# 出征测试',
      'chapter: 1',
      'map: 1',
      'fleet_presets:',
      '  - name: 舰队测试',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(userTeamDirectory, 'team-test.yaml'),
    'name: 舰队测试\n',
    'utf8',
  );

  const service = new PlanExportService(
    {
      directory: source => {
        assert.equal(source, 'user');
        return userBattleDirectory;
      },
    },
    {
      directory: source => {
        assert.equal(source, 'user');
        return userTeamDirectory;
      },
    },
    new AtomicFileStore(),
    {
      parseRoot: content => yaml.load(content),
      expandRoot: rootPlan => ({
        ...rootPlan,
        fleet_presets: [{
          name: '舰队测试',
          ships: [{
            name: '重庆',
            search_name: '重庆改',
            relaxed: true,
            candidates: [{ name: '长春', min_level: 80 }],
          }],
        }],
      }),
      serialize: rootPlan => yaml.dump(rootPlan),
      isPlainObject: value => (
        typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
      ),
    },
  );

  assert.equal(
    service.archiveFileName(new Date(2026, 7, 4)),
    '2026-08-04-plans.zip',
  );

  const archive = await service.createArchive([
    { kind: 'battle', file: 'bettle-test.yaml' },
    { kind: 'team', file: 'team-test.yaml' },
    { kind: 'team', file: 'TEAM-TEST.YAML' },
  ]);
  assert.equal(archive.count, 2);

  const zip = await JSZip.loadAsync(archive.content);
  assert.equal(zip.files['user_battle_plans/']?.dir, true);
  assert.equal(zip.files['user_team_plans/']?.dir, true);
  assert.equal(
    await zip.file(
      'user_battle_plans/bettle-test.yaml',
    ).async('string'),
    [
      '# 出征测试',
      'chapter: 1',
      'map: 1',
      'fleet_presets:',
      '  - name: 舰队测试',
      '',
    ].join('\n'),
  );
  assert.equal(
    await zip.file('user_team_plans/team-test.yaml').async('string'),
    'name: 舰队测试\n',
  );

  const legacyArchive = await service.createLegacy143Archive([
    { kind: 'battle', file: 'bettle-test.yaml' },
    { kind: 'team', file: 'team-test.yaml' },
  ]);
  assert.equal(legacyArchive.count, 1);
  const legacyZip = await JSZip.loadAsync(legacyArchive.content);
  const legacyPlan = yaml.load(
    await legacyZip.file('plans/bettle-test.yaml').async('string'),
  );
  assert.deepEqual(legacyPlan.fleet_presets, [{
    name: '舰队测试',
    ships: [{
      name: '重庆',
      priority: ['长春'],
    }],
  }]);
  assert.ok(legacyZip.file('original_2.0/user_battle_plans/bettle-test.yaml'));
  assert.match(
    await legacyZip.file('恢复说明.txt').async('string'),
    /仅用于完整备份/,
  );

  const outputPath = path.join(root, '2026-08-04-plans.zip');
  service.writeArchive(outputPath, archive);
  assert.deepEqual(fs.readFileSync(outputPath), archive.content);

  await assert.rejects(
    service.createArchive([
      { kind: 'battle', file: '../system-plan.yaml' },
    ]),
    /导出配置包含非法文件名/,
  );
  await assert.rejects(
    service.createArchive([
      { kind: 'battle', file: 'system-plan.yaml' },
    ]),
    /用户配置不存在/,
  );
  await assert.rejects(
    service.createArchive([]),
    /请至少选择一个用户配置/,
  );
}

module.exports = { testPlanExportService };
