import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  subscribeUploadProgress,
  removeAllFinished,
  countUploads,
  retryUpload,
  retryErrors,
  retryCancelled,
  cancelUpload,
  clearAll,
  type UploadItem,
} from "../utils/upload-progress-store";

// 与上传并发池上限保持一致（见 utils/concurrency.ts）。
const CONCURRENCY_LIMIT = 10;
// 全部完成后自动淡出的延迟（ms）。
const AUTO_DISMISS_MS = 2500;

// 判断 URL 是否可作缩略图预览（图片直接 <img>，视频用 <video> 取首帧）。
function thumbnailKind(url?: string, name?: string): "image" | "video" | null {
  if (!url) return null;
  const lower = (name ?? url).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(lower)) return "image";
  if (/\.(mp4|webm|ogg|mov|m4v)$/.test(lower)) return "video";
  return null;
}

export function UploadProgressLayer() {
  const { t } = useTranslation();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [cancelledExpanded, setCancelledExpanded] = useState(false);
  const dismissTimer = useRef<number | null>(null);

  useEffect(() => {
    return subscribeUploadProgress(setItems);
  }, []);

  const counts = countUploads(items);
  const active = counts.active;

  // 所有任务都结束（无上传中、无排队）且无失败、无取消项后，
  // 延迟清除已完成项，窗口自动消失。只要还有失败 / 取消项，窗口保留，
  // 等用户点「重新上传」或关闭窗口。
  useEffect(() => {
    if (dismissTimer.current) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    if (
      active === 0 &&
      counts.error === 0 &&
      counts.cancelled === 0 &&
      items.length > 0
    ) {
      dismissTimer.current = window.setTimeout(() => {
        removeAllFinished();
      }, AUTO_DISMISS_MS);
    }
    return () => {
      if (dismissTimer.current) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
    };
  }, [active, counts.error, counts.cancelled, items.length]);

  if (items.length === 0) return null;

  const uploading = items.filter((it) => it.status === "uploading");
  const done = items.filter((it) => it.status === "done");
  const errored = items.filter((it) => it.status === "error");
  const cancelled = items.filter((it) => it.status === "cancelled");
  const queued = items.filter((it) => it.status === "queued");

  const renderRow = (
    it: UploadItem,
    opts?: { cancel?: boolean; retry?: boolean },
  ) => {
    const barColor =
      it.status === "done"
        ? "bg-green-500"
        : it.status === "error" || it.status === "cancelled"
          ? "bg-red-500"
          : "bg-theme";
    const width = it.status === "error" || it.status === "cancelled" ? "100%" : `${it.pct}%`;
    const label =
      it.status === "done"
        ? "✓"
        : it.status === "error"
          ? "!"
          : it.status === "cancelled"
            ? "✕"
            : `${it.pct}%`;
    return (
      <div key={it.id} className="flex items-center gap-2 text-xs">
        <span
          className="w-24 shrink-0 truncate t-secondary"
          title={it.name}
        >
          {it.name}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
          <div
            className={`h-full rounded-full ${barColor} transition-[width] duration-200`}
            style={{ width }}
          />
        </div>
        <span
          className="w-9 shrink-0 text-right tabular-nums t-secondary"
          title={it.error}
        >
          {label}
        </span>
        {opts?.cancel && (
          <button
            type="button"
            onClick={() => cancelUpload(it.id)}
            title={t("upload.progress.cancel")}
            aria-label={t("upload.progress.cancel")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-black/[0.04] text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:bg-white/10 dark:hover:bg-red-500/20"
          >
            <span aria-hidden>✕</span>
          </button>
        )}
        {opts?.retry && (
          <button
            type="button"
            onClick={() => retryUpload(it.id)}
            title={t("upload.progress.retry")}
            aria-label={t("upload.progress.retry")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-black/[0.04] text-theme transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
          >
            <span aria-hidden>↻</span>
          </button>
        )}
      </div>
    );
  };

  // 已上传条目折叠展开后，按 url 渲染缩略图（图片 / 视频首帧）。
  const renderThumb = (it: UploadItem) => {
    const kind = thumbnailKind(it.url, it.name);
    if (!kind || !it.url) return null;
    return (
      <a
        key={it.id}
        href={it.url}
        target="_blank"
        rel="noreferrer"
        title={it.name}
        className="block w-16 overflow-hidden rounded-lg border border-black/10 bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.04]"
      >
        {kind === "image" ? (
          <img
            src={it.url}
            alt={it.name}
            loading="lazy"
            className="h-16 w-16 object-cover"
          />
        ) : (
          <video
            src={it.url}
            muted
            playsInline
            preload="metadata"
            className="h-16 w-16 object-cover"
          />
        )}
      </a>
    );
  };

  // 最小化态：右下角小胶囊。
  if (minimized) {
    const pillLabel =
      counts.error > 0
        ? t("upload.progress.failed", { count: counts.error })
        : counts.cancelled > 0
          ? t("upload.progress.cancelled_collapsed", { count: counts.cancelled })
          : t("upload.progress.minimized", { count: active });
    const pillColor =
      counts.error > 0
        ? "bg-red-500"
        : counts.cancelled > 0
          ? "bg-amber-500"
          : "bg-theme";
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-black/10 bg-w px-4 py-2 text-xs font-semibold text-theme shadow-2xl shadow-black/20 dark:border-white/10 dark:bg-neutral-900"
        aria-label={pillLabel}
      >
        <span className={`h-2 w-2 animate-pulse rounded-full ${pillColor}`} />
        {pillLabel}
      </button>
    );
  }

  const hasFailed = counts.error > 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-black/10 bg-w shadow-2xl shadow-black/20 dark:border-white/10 dark:bg-neutral-900">
      <div className="flex items-center justify-between border-b border-black/10 px-3 py-2 dark:border-white/10">
        <div className="flex items-center gap-2 text-xs font-semibold t-primary">
          <span className="text-theme">
            {t("upload.progress.uploading", { uploading: counts.uploading })}
          </span>
          {counts.queued > 0 && (
            <span className="text-neutral-400">
              {t("upload.progress.queued", { queued: counts.queued })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {hasFailed && (
            <button
              type="button"
              onClick={() => retryErrors()}
              title={t("upload.progress.retry_failed")}
              className="flex h-6 items-center gap-1 rounded-lg bg-black/[0.04] px-2 text-[11px] font-medium text-theme transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              <span aria-hidden>↻</span>
              {t("upload.progress.retry_failed")}
            </button>
          )}
          <button
            type="button"
            onClick={() => clearAll()}
            title={t("upload.progress.close")}
            aria-label={t("upload.progress.close")}
            className="flex h-6 w-6 items-center justify-center rounded-lg bg-black/[0.04] text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:bg-white/10 dark:hover:bg-red-500/20"
          >
            ✕
          </button>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            className="flex h-6 w-6 items-center justify-center rounded-lg bg-black/[0.04] text-neutral-500 transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            aria-label="最小化"
          >
            —
          </button>
        </div>
      </div>

      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto px-3 py-2">
        {uploading.map((it) => renderRow(it, { cancel: true }))}
        {errored.map((it) => renderRow(it, { retry: true }))}

        {queued.length > 0 && (
          <button
            type="button"
            onClick={() => setQueueExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-neutral-400 transition-colors hover:text-neutral-600"
          >
            <span
              className={`inline-block text-[10px] transition-transform ${queueExpanded ? "rotate-90" : ""}`}
            >
              ▸
            </span>
            {t("upload.progress.queued_collapsed", { count: queued.length })}
          </button>
        )}
        {queueExpanded && queued.map((it) => renderRow(it))}

        {done.length > 0 && (
          <button
            type="button"
            onClick={() => setDoneExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-neutral-400 transition-colors hover:text-neutral-600"
          >
            <span
              className={`inline-block text-[10px] transition-transform ${doneExpanded ? "rotate-90" : ""}`}
            >
              ▸
            </span>
            {t("upload.progress.done_collapsed", { count: done.length })}
          </button>
        )}
        {doneExpanded && (
          <div className="flex flex-wrap gap-2">
            {done.map(renderThumb)}
          </div>
        )}

        {cancelled.length > 0 && (
          <button
            type="button"
            onClick={() => setCancelledExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-neutral-400 transition-colors hover:text-neutral-600"
          >
            <span
              className={`inline-block text-[10px] transition-transform ${cancelledExpanded ? "rotate-90" : ""}`}
            >
              ▸
            </span>
            {t("upload.progress.cancelled_collapsed", { count: cancelled.length })}
          </button>
        )}
        {cancelledExpanded && (
          <div className="flex flex-col gap-2">
            {cancelled.map((it) => renderRow(it, { retry: true }))}
            <button
              type="button"
              onClick={() => retryCancelled()}
              className="flex h-7 items-center justify-center gap-1 rounded-lg bg-black/[0.04] text-[11px] font-medium text-theme transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            >
              <span aria-hidden>↻</span>
              {t("upload.progress.retry_all")}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-black/10 px-3 py-1.5 text-[11px] text-neutral-400 dark:border-white/10">
        {t("upload.progress.footer", {
          total: counts.total,
          done: counts.done,
          limit: CONCURRENCY_LIMIT,
        })}
      </div>
    </div>
  );
}
