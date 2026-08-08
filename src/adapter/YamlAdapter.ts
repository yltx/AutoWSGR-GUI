/** 统一 YAML 编解码和结构校验。 */
import * as yaml from 'js-yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

export interface YamlCodec {
  parse<T>(content: string): T;
  stringify(value: unknown, options?: yaml.DumpOptions): string;
}

export const yamlCodec: YamlCodec = {
  parse<T>(content: string): T {
    return yaml.load(content) as T;
  },

  stringify(value: unknown, options?: yaml.DumpOptions): string {
    return yaml.dump(value, options);
  },
};

/** 解析要求根节点为对象的 YAML 文档。 */
export function parseYamlRecord(
  content: string,
  label = 'YAML 文档',
): Record<string, unknown> {
  const parsed = yamlCodec.parse<unknown>(content);
  if (!isRecord(parsed)) {
    throw new Error(`${label}根节点必须是对象`);
  }
  return parsed;
}

/** 把字符串映射格式化为设置页可编辑文本。 */
export function formatStringMap(value: Record<string, string>): string {
  if (Object.keys(value).length === 0) return '';
  return yamlCodec.stringify(
    value,
    { lineWidth: -1, noRefs: true },
  ).trim();
}

/** 解析 YAML 映射，并兼容冒号两侧没有空格的逐行格式。 */
export function parseStringMap(
  source: string,
  label: string,
): Record<string, string> {
  if (!source.trim()) return {};
  let parsed: unknown;
  try {
    parsed = yamlCodec.parse<unknown>(source);
  } catch (error) {
    return parseLineStringMap(source, label, error);
  }
  if (!isRecord(parsed)) {
    return parseLineStringMap(source, label);
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.trim() || typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label}中的键和值都必须是非空文字`);
    }
    output[key.trim()] = value.trim();
  }
  return output;
}

function parseLineStringMap(
  source: string,
  label: string,
  yamlError?: unknown,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    const key = separator >= 0 ? line.slice(0, separator).trim() : '';
    const value = separator >= 0 ? line.slice(separator + 1).trim() : '';
    if (!key || !value) {
      const detail = yamlError instanceof Error ? `：${yamlError.message}` : '';
      throw new Error(
        `${label}必须每行使用“识别名称:标准名称”的格式，冒号两侧空格可省略${detail}`,
      );
    }
    output[key] = value;
  }
  return output;
}
