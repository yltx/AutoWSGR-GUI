/** 定义键值存储契约，并封装浏览器 localStorage 实现。 */
export interface StorageStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const browserStorageStore: StorageStore = {
  get(key: string): string | null {
    return localStorage.getItem(key);
  },

  set(key: string, value: string): void {
    localStorage.setItem(key, value);
  },

  remove(key: string): void {
    localStorage.removeItem(key);
  },
};
