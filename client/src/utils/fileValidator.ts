/** 视频格式白名单 */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.m4v', '.mov', '.mkv'];

/** 浏览器格式支持（用于提示） */
export const FORMAT_HINT = '支持 .mp4 / .webm / .m4v / .mov(Safari) / .mkv(Chrome/Edge)';

/** 校验文件扩展名是否在白名单内 */
export function isValidVideoFile(file: File): boolean {
  const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
  return VIDEO_EXTENSIONS.includes(ext);
}

/** 获取文件扩展名（小写，含点） */
export function getFileExtension(file: File): string {
  return '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
}
