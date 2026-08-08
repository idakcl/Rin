// 全局上传进度 store —— 编辑器、头像/封面上传框等任何上传入口都往这里推进度，
// 由一个常驻右下游离窗（UploadProgressLayer）统一渲染。轻量发布订阅，无外部依赖。

export type UploadStatus = "queued" | "uploading" | "done" | "error";

export interface UploadItem {
  id: string;
  name: string;
  status: UploadStatus;
  pct: number;
  error?: string;
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

export function removeUpload(id: string): void {
  items = items.filter((it) => it.id !== id);
  retryMap.delete(id);
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

export function retryAll(): void {
  for (const fn of retryMap.values()) {
    void fn();
  }
}

// 移除所有「已完成(done)」的项（用于全部成功后自动淡出）。失败/排队/上传中
// 的项保留，尤其是失败项要留着供用户点「重新上传」。有变化才 emit，并同步
// 清理被移除项的重传回调。
export function removeAllFinished(): void {
  const next = items.filter((it) => it.status !== "done");
  if (next.length !== items.length) {
    const removedIds = new Set(
      items.filter((it) => !next.includes(it)).map((it) => it.id),
    );
    for (const rid of removedIds) retryMap.delete(rid);
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
    }
  }
  return counts;
}
