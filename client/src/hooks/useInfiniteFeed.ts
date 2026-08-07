import { useCallback, useEffect, useRef, useState } from "react"
import { client } from "../app/runtime"
import type { FeedListResponse } from "@rin/api"

export type FeedType = "draft" | "unlisted" | "normal"

interface Bucket {
  items: any[]
  nextPage: number
  hasNext: boolean
  loading: boolean
  total: number
}

/** 深链 ?page=N 预热的页数上限，避免极端深链一次性拉爆 */
export const MAX_DEEPLINK_PAGES = 5

// requestIdleCallback 在某些 TS lib 配置下不是全局类型，用安全引用兜底
const ric: ((cb: () => void) => void) | null =
  typeof window !== "undefined" && (window as any).requestIdleCallback
    ? (window as any).requestIdleCallback
    : null

/**
 * 抖音式分级滑动窗口预取 hook。
 *
 * - 即时屏（当前 + 下一页）：数据 + 媒体就绪。
 * - 预备屏（下面 2~3 页）：只提前拉取 JSON 数据存入 prefetchCache，不挂 DOM、不加载媒体。
 * - 滑动窗口靠「数据预取」而非「DOM 挂载」限制图片加载范围：预取的页未挂载，其图片不会提前请求；
 *   滚动到才挂载、才加载（FeedCard 图片保持 eager，符合用户先前回退懒加载的决定）。
 */
export function useInfiniteFeed(type: FeedType, limit: number) {
  const [bucket, setBucket] = useState<Bucket>({
    items: [],
    nextPage: 1,
    hasNext: true,
    loading: false,
    total: 0,
  })

  // 始终指向最新的 bucket，避免 loadNext 闭包捕获到过时的 nextPage/hasNext
  const bucketRef = useRef(bucket)
  bucketRef.current = bucket

  const prefetchCache = useRef<Map<number, FeedListResponse>>(new Map())
  const fetching = useRef<Set<number>>(new Set())
  const loadingRef = useRef(false)
  const mounted = useRef(true)
  // 首屏加载完成前，禁止 loadNext 触发：否则挂载期哨兵 fill 会以 nextPage=1
  // 抢跑抓取第 1 页并 append 到 loadInitial 的 SET 结果之上，导致整页文章重复。
  const bootstrappedRef = useRef(false)

  // [DEBUG] 追踪 loadInitial/loadNext 事件序列，定位重复渲染根因（定位后删除）
  ;(window as any).__diag = (window as any).__diag || []
  const D = (o: Record<string, unknown>) => { (window as any).__diag.push(o) }
  D({ ev: "mount", limit, type })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const flush = (updater: (prev: Bucket) => Bucket) => {
    if (mounted.current) setBucket(updater)
  }

  /** 后台预取某一页数据（仅 JSON），存入 prefetchCache，不挂载、不加载媒体 */
  const prefetch = useCallback(
    (page: number) => {
      if (page < 1) return
      if (prefetchCache.current.has(page) || fetching.current.has(page)) return
      fetching.current.add(page)
      const run = () => {
        client.feed
          .list({ page, limit, type })
          .then(({ data }) => {
            if (data && mounted.current) prefetchCache.current.set(page, data)
          })
          .catch(() => {})
          .finally(() => fetching.current.delete(page))
      }
      // 让出首屏绘制：空闲时再预取
      if (ric) ric(run)
      else setTimeout(run, 200)
    },
    [limit, type]
  )

  /** 追加下一页：命中 prefetchCache 则瞬时挂载，否则走网络。返回是否成功追加 */
  const loadNext = useCallback((): Promise<boolean> => {
    D({ ev: "LN_entry", boot: bootstrappedRef.current, lr: loadingRef.current, tgt: bucketRef.current.nextPage, hn: bucketRef.current.hasNext })
    if (!bootstrappedRef.current) { D({ ev: "LN_ret", why: "boot" }); return Promise.resolve(false) }
    if (loadingRef.current) { D({ ev: "LN_ret", why: "lr" }); return Promise.resolve(false) }
    const target = bucketRef.current.nextPage
    if (!bucketRef.current.hasNext) { D({ ev: "LN_ret", why: "hn" }); return Promise.resolve(false) }

    loadingRef.current = true
    flush((prev) => ({ ...prev, loading: true }))

    const cached = prefetchCache.current.get(target)
    const req = cached
      ? Promise.resolve({ data: cached })
      : client.feed.list({ page: target, limit, type })

    return req
      .then(({ data }) => {
        if (!data) {
          loadingRef.current = false
          flush((prev) => ({ ...prev, loading: false }))
          return false
        }
        const items = (data.data ?? []) as any[]
        const nextPage = target + 1
        prefetchCache.current.delete(target)
        flush((prev) => {
          D({ ev: "LN_flush", target, before: prev.items.length, after: prev.items.length + items.length })
          return {
            items: [...prev.items, ...items],
            nextPage,
            hasNext: data.hasNext,
            loading: false,
            total: data.size ?? prev.total,
          }
        })
        loadingRef.current = false
        // 挂载后，保证下面 2~3 页数据就绪（抖音式「下面几屏」）
        prefetch(nextPage)
        prefetch(nextPage + 1)
        return true
      })
      .catch(() => {
        loadingRef.current = false
        flush((prev) => ({ ...prev, loading: false }))
        return false
      })
  }, [limit, type, prefetch])

  /** 重置并加载首页（type/limit 变化时调用），返回首页请求完成的 Promise 以便深链预热串行等待 */
  const loadInitial = useCallback((): Promise<void> => {
    prefetchCache.current.clear()
    fetching.current.clear()
    loadingRef.current = false
    bootstrappedRef.current = false
    D({ ev: "LI_start", limit })
    flush(() => ({ items: [], nextPage: 1, hasNext: true, loading: true, total: 0 }))
    return client.feed
      .list({ page: 1, limit, type })
      .then(({ data }) => {
        if (!data) {
          flush(() => ({ items: [], nextPage: 1, hasNext: false, loading: false, total: 0 }))
          return
        }
        D({ ev: "LI_done", n: (data.data ?? []).length, nextPage: 2, hasNext: data.hasNext })
        flush(() => ({
          items: (data.data ?? []) as any[],
          nextPage: 2,
          hasNext: data.hasNext,
          loading: false,
          total: data.size ?? 0,
        }))
        bootstrappedRef.current = true
        prefetch(2)
        prefetch(3)
      })
      .catch(() => {
        flush(() => ({ items: [], nextPage: 1, hasNext: false, loading: false, total: 0 }))
      })
  }, [limit, type, prefetch])

  return { ...bucket, loadInitial, loadNext, MAX_DEEPLINK_PAGES }
}
