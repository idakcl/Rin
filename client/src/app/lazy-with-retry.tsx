import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// 把 React.lazy 工厂包一层：单次 import 失败时自动指数退避重试，
// 自愈偶发网络抖动。
//
// 背景：后台页（含写作页 / monaco）是 lazy chunk，从站点域名
// `rinx.hello.nyc.mn`（`.mn`）按需拉取。该域名实测 DNS 解析约 2.1s，
// 且 CloudFlare 偶发把路由跳到阿姆斯特丹（AMS）节点，网络波动时 chunk
// 请求会超时 / 失败，表现为「编辑框偶尔加载不出来」。
//
// 关键：React.lazy 会缓存 `factory()` 返回的 promise。本函数在内部把
// 失败的 promise 接上一个「延迟 + 递归重试」的 promise，最终成功即 resolve，
// 因此 lazy 拿到的是最终成功的 promise —— 无需 key 重置、也无需 ErrorBoundary
// 即可自愈；只有重试耗尽才抛出（此时仍由 Suspense 外层兜底）。
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  options: { retries?: number; baseDelayMs?: number } = {},
): LazyExoticComponent<T> {
  const { retries = 3, baseDelayMs = 1000 } = options;
  return lazy(() => attempt(factory, retries, baseDelayMs, 0));
}

function attempt<T>(
  factory: () => Promise<{ default: T }>,
  retries: number,
  baseDelayMs: number,
  attemptNo: number,
): Promise<{ default: T }> {
  return factory().catch((error: unknown) => {
    if (attemptNo >= retries) {
      throw error;
    }
    const delay = Math.min(baseDelayMs * 2 ** attemptNo, 8000);
    return new Promise<{ default: T }>((resolve) => setTimeout(resolve, delay)).then(
      () => attempt(factory, retries, baseDelayMs, attemptNo + 1),
    );
  });
}
