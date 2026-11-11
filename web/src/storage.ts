/* 界面偏好的本地存储。

   站点存储被禁用时，碰 localStorage 这个全局本身就抛错。读不到按没存过处理，
   写不进当前页面照常，只是下次打开记不住。 */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不进去不影响当前页面。
  }
}
