// 图片上传压缩的总开关偏好。
// 默认开：新上传图片默认用 WebP 重编码压缩到几百 KB，加快页面加载。
// 用 localStorage 持久化，刷新/重开浏览器都记住。

const STORAGE_KEY = "rin:image-compress-enabled";

export function isImageCompressEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // 未设置（首次）按默认开处理
    return v === null ? true : v === "1";
  } catch {
    // 隐私模式等拿不到 localStorage 时，退化为开（压缩是安全默认）
    return true;
  }
}

export function setImageCompressEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // 忽略写入失败（隐私模式等）
  }
}
