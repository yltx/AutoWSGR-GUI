/** Renderer 本地偏好存储，只保存展示偏好，不保存编队业务状态。 */
export interface StorageStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStorageStore: StorageStore = {
  get(key: string): string | null {
    return window.localStorage.getItem(key);
  },

  set(key: string, value: string): void {
    window.localStorage.setItem(key, value);
  },
};
