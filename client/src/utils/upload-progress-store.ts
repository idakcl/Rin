// 全局上传进度 store —— 编辑器、头像/封面上传框等任何上传入口都往这里推进度，
// 由一个常驻右下游离窗（UploadProgressLayer）统一渲染。轻量发布订阅，无外部依赖。

export type UploadStatus =
  | "queued"
  | "uploading"
  | "done"
  | "error"
  | "cancelled";

export interface UploadItem {
  id: string;
  name: string;
  status: UploadStatus;
  pct: number;
  error?: string;
  // 上传成功后的资源 URL，用于「已上传」折叠里渲染缩略图。
  url?: string;
}

type Listener = (items: UploadItem[]) => void;

let items: UploadItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  // 传副本，避免订阅者直接改内部数组。
  const snapshot = items.slice();
  for (const l of listeners) l(snapshot);
}

export function subscribeUploadProgress(listener: Listener): () => void {
  listeners.add(listener);
  listener(items.slice());
  return () => {
    listeners.delete(listener);
  };
}

let seq = 0;

export function addUpload(name: string): string {
  const id = `up_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  items = [...items, { id, name, status: "queued", pct: 0 }];
  emit();
  return id;
}

export function setUploadStatus(id: string, status: UploadStatus, error?: string): void {
  items = items.map((it) =>
    it.id === id ? { ...it, status, error: error ?? it.error } : it,
  );
  emit();
}

export function setUploadProgress(id: string, pct: number): void {
  items = items.map((it) =>
    it.id === id ? { ...it, pct, status: "uploading" } : it,
  );
  emit();
}

export function setUploadUrl(id: string, url: string): void {
  items = items.map((it) => (it.id === id ? { ...it, url } : it));
  emit();
}

export function removeUpload(id: string): void {
  items = items.filter((it) => it.id !== id);
  retryMap.delete(id);
  abortMap.delete(id);
  emit();
}

// 重传回调注册表：每个上传入口（编辑器 / 头像框）在上传时把「如何重传该文件」
// 的闭包注册进来；失败条目在悬浮窗点「重新上传」时回调它，从而复用原上传逻辑。
const retryMap = new Map<string, () => Promise<void>>();

export function registerRetry(id: string, fn: () => Promise<void>): void {
  retryMap.set(id, fn);
}

export function retryUpload(id: string): void {
  const fn = retryMap.get(id);
  if (fn) void fn();
}

// 重传所有「失败(error)」条目。只针对失败项，不碰已成功 / 上传中 / 排队中的条目，
// 否则会把已插入编辑器的内容重复上传再插入，造成重复。
export function retryErrors(): void {
  for (const it of items) {
    if (it.status === "error") {
      retryMap.get(it.id)?.();
    }
  }
}

// 取消（abort）回调注册表：每个上传入口在上传时把「如何中断该文件上传」的闭包
// （通常是 AbortController.abort）注册进来；点取消按钮时回调它中止 XHR。
const abortMap = new Map<string, () => void>();

export function registerAbort(id: string, fn: () => void): void {
  abortMap.set(id, fn);
}

// 取消单个上传任务（中止其 XHR，调用方捕获 AbortError 后置为 cancelled）。
export function cancelUpload(id: string): void {
  abortMap.get(id)?.();
}

// 取消所有仍在进行（上传中 / 排队中）的任务。
export function cancelAll(): void {
  for (const it of items) {
    if (it.status === "uploading" || it.status === "queued") {
      abortMap.get(it.id)?.();
    }
  }
}

// 清空全部（关闭窗口用）：中止进行中任务并移除所有条目与回调。
export function clearAll(): void {
  cancelAll();
  items = [];
  retryMap.clear();
  abortMap.clear();
  emit();
}

// 重新上传所有「已取消」的条目（复用注册的重传闭包）。
export function retryCancelled(): void {
  for (const it of items) {
    if (it.status === "cancelled") {
      retryMap.get(it.id)?.();
    }
  }
}

// 移除所有「已完成(done)」与「已取消(cancelled)」的项（用于全部结束后自动淡出）。
// 上传中 / 排队中 / 失败项保留——失败项要留着供用户点「重新上传」。
// 有变化才 emit，并同步清理被移除项的重传 / 取消回调。
export function removeAllFinished(): void {
  const next = items.filter(
    (it) => it.status === "uploading" || it.status === "queued" || it.status === "error",
  );
  if (next.length !== items.length) {
    const removedIds = new Set(
      items.filter((it) => !next.includes(it)).map((it) => it.id),
    );
    for (const rid of removedIds) {
      retryMap.delete(rid);
      abortMap.delete(rid);
    }
    items = next;
    emit();
  }
}

export interface UploadProgressCounts {
  total: number;
  uploading: number;
  queued: number;
  done: number;
  error: number;
  cancelled: number;
  // 仍在进行（上传中 + 排队中）的数量，用于悬浮窗/胶囊显示。
  active: number;
}

export function countUploads(list: UploadItem[]): UploadProgressCounts {
  const counts: UploadProgressCounts = {
    total: list.length,
    uploading: 0,
    queued: 0,
    done: 0,
    error: 0,
    cancelled: 0,
    active: 0,
  };
  for (const it of list) {
    if (it.status === "uploading") {
      counts.uploading += 1;
      counts.active += 1;
    } else if (it.status === "queued") {
      counts.queued += 1;
      counts.active += 1;
    } else if (it.status === "done") {
      counts.done += 1;
    } else if (it.status === "error") {
      counts.error += 1;
    } else if (it.status === "cancelled") {
      counts.cancelled += 1;
    }
  }
  return counts;
}
