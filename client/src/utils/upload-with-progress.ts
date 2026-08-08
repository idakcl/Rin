// 带上传进度的上传器（XMLHttpRequest 版）。
//
// 为什么不用 fetch：fetch 只能监听响应体的「下载」流式，无法拿到请求体的
// 「上传」进度。要逐文件显示上传百分比，必须用 XHR 的 `xhr.upload.onprogress`。
//
// 两个上传目标：
//   - R2 存储（/api/storage）：图片走这里，视频也可走这里（Cloudflare R2）。
//   - netpan 私人网盘：视频/音乐/文件走这里。

import { endpoint } from "../config";
import { getAuthToken } from "../utils/auth";
import { NETPAN_UPLOAD_URL, NETPAN_UPLOAD_TOKEN, NETPAN_BASE_URL } from "../netpan";

export type ProgressFn = (percent: number) => void;

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// 上传到 R2（POST /api/storage），返回文件公开 URL。
export function uploadToStorageWithProgress(
  file: File,
  key: string | undefined,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${endpoint}/api/storage`);
    const token = getAuthToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    xhr.withCredentials = true;

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(clampPct((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`上传失败 (${xhr.status})`));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        const url = typeof data === "string" ? data : data?.url;
        if (!url) {
          reject(new Error("Invalid upload response"));
          return;
        }
        onProgress?.(100);
        resolve(url);
      } catch {
        reject(new Error("Invalid upload response"));
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

    const form = new FormData();
    form.append("file", file);
    if (key) form.append("key", key);
    xhr.send(form);
  });
}

// 上传到 netpan（POST NETPAN_UPLOAD_URL），返回文件公开 URL。
export function uploadToNetpanWithProgress(
  file: File,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!NETPAN_UPLOAD_TOKEN) {
      reject(
        new Error(
          "未配置 netpan 上传 Token：请在仓库 Secrets 中添加 VITE_NETPAN_UPLOAD_TOKEN（需 upload 权限），并重新运行 Build",
        ),
      );
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", NETPAN_UPLOAD_URL);
    xhr.setRequestHeader("Authorization", `Bearer ${NETPAN_UPLOAD_TOKEN}`);

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(clampPct((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = "";
        try {
          detail = xhr.responseText.slice(0, 120);
        } catch {
          /* ignore */
        }
        reject(new Error(`netpan 上传失败 (${xhr.status})${detail ? `: ${detail}` : ""}`));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        const item = Array.isArray(data) ? data[0] : data;
        const raw = item?.publicUrl || item?.src;
        if (!raw) {
          reject(new Error("netpan 返回缺少文件 URL"));
          return;
        }
        onProgress?.(100);
        resolve(raw.startsWith("http") ? raw : `${NETPAN_BASE_URL}${raw}`);
      } catch {
        reject(new Error("netpan 返回解析失败"));
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

// 判断上传错误是否由用户取消（abort）引起，便于调用方将其标记为
// 「已取消」而非「失败」。
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
