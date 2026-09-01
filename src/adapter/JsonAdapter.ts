/** 统一 JSON 序列化、解析和对象类型校验。 */
export interface JsonCodec {
  parse<T>(content: string): T;
  stringify(value: unknown): string;
}

export const jsonCodec: JsonCodec = {
  parse<T>(content: string): T {
    return JSON.parse(content) as T;
  },

  stringify(value: unknown): string {
    return JSON.stringify(value, null, 2);
  },
};
