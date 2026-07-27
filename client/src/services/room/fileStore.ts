/**
 * 简易文件共享存储（File 对象不可序列化，不能放路由 state）
 * 见 TECH-SPEC §9 Step 3 注意事项
 */

let sharedFile: File | null = null;

export function setSharedFile(file: File | null): void {
  sharedFile = file;
}

export function getSharedFile(): File | null {
  return sharedFile;
}
