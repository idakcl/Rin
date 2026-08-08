// Screen Wake Lock 封装 —— 上传（图片/视频/文件）期间保持手机屏幕常亮，
// 避免锁屏后后台节流/中断长上传。
//
// 设计要点：
// - 引用计数：多个上传并发时共享同一把锁，全部结束才真正 release。
// - 自动续锁：Wake Lock 在标签页切到后台时会被浏览器自动释放；切回前台时
//   若仍有上传在进行（refCount > 0），自动重新请求。
// - 降级：iOS < 16.4、桌面 Firefox 等不支持的环境全部静默 no-op。

let sentinel: WakeLockSentinel | null = null;
let refCount = 0;
let visibilityBound = false;

function supported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

// 切回前台时若上传仍在进行，自动重新拿锁（浏览器在后台会释放它）。
function bindVisibility() {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && refCount > 0 && !sentinel) {
      void acquireWakeLock();
    }
  });
}

export async function acquireWakeLock(): Promise<void> {
  if (!supported()) return;
  bindVisibility();
  refCount += 1;
  // 已经持有锁则直接复用，不重复请求。
  if (sentinel) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    // 锁被系统提前释放（如再次切到后台）时清掉引用，下次再请求。
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
  } catch {
    // 不支持 / 被拒绝 / 非用户手势触发 —— 忽略，不影响上传逻辑。
    refCount = Math.max(0, refCount - 1);
  }
}

export function releaseWakeLock(): void {
  if (refCount > 0) refCount -= 1;
  if (refCount === 0 && sentinel) {
    sentinel.release().catch(() => {
      /* 释放失败可忽略 */
    });
    sentinel = null;
  }
}
