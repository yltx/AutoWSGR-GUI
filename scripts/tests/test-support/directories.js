/**
 * 测试目录准备工具。
 *
 * 只用于在隔离临时目录中创建测试所需结构。
 */
const fs = require('node:fs');

function createDirectories(...directories) {
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

module.exports = {
  createDirectories,
};
