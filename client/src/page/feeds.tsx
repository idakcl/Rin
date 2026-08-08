import { useContext, useEffect, useRef } from "react"
import { Helmet } from 'react-helmet'
import { Link, useSearch } from "wouter"
import { FeedCard } from "../components/feed_card"
import { Waiting } from "../components/loading"
import { ProfileContext } from "../state/profile"

import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants"
import { tryInt } from "../utils/int"
import { useTranslation } from "react-i18next";
import { useInfiniteFeed, type FeedType } from "../hooks/useInfiniteFeed";

export function FeedsPage() {
    const { t } = useTranslation()
    const siteConfig = useSiteConfig();
    const query = new URLSearchParams(useSearch());
    const profile = useContext(ProfileContext);
    const type = ((query.get("type") as FeedType) || 'normal')
    const limit = tryInt(siteConfig.pageSize, query.get("limit"))
    const feedListClass = siteConfig.feedLayout === "masonry" ? "wauto columns-1 gap-5 ani-show md:columns-2" : "wauto flex flex-col ani-show";
    const {
        items,
        hasNext,
        loading,
        total,
        loadInitial,
        loadNext,
        MAX_DEEPLINK_PAGES,
    } = useInfiniteFeed(type, limit)

    // 镜像最新 hasNext，供 fillShortPage 判定终止（避免哨兵常驻视口时死循环）
    const hasNextRef = useRef(hasNext)
    hasNextRef.current = hasNext

    const sentinelRef = useRef<HTMLDivElement>(null)
    // 永远指向最新的 loadNext，避免 IntersectionObserver 回调捕获到旧的闭包
    const loadNextRef = useRef(loadNext)
    loadNextRef.current = loadNext

    // 初始加载 + 切换 type/limit 时重置重载
    useEffect(() => {
        let cancelled = false
        const page = tryInt(1, query.get("page"))
        loadInitial().then(() => {
            if (cancelled) return
            // 普通首页（?page 缺省或 =1）不滚动，保持顶部；仅深链 ?page=N (N>1) 才预热后滚到底部
            if (page <= 1) return
            // 深链 ?page=N：串行预热到该页（上限 MAX_DEEPLINK_PAGES），再粗略定位到底部
            const target = Math.min(page, MAX_DEEPLINK_PAGES)
            let chain: Promise<unknown> = Promise.resolve()
            for (let i = 2; i <= target; i++) {
                chain = chain.then(() => loadNext())
            }
            chain.then(() => {
                if (cancelled) return
                requestAnimationFrame(() => {
                    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" })
                })
            })
        })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadInitial, query.get("page")])

    // 抖音式：底部哨兵观察 + 短首屏级联。
    // 注意：外层 <Waiting> 在 loading 翻转时会重挂载哨兵（旧节点卸载、新节点挂载），
    // 因此 observer 绝不能只观察一次（deps:[] 会盯着已卸载的旧节点，导致真实哨兵永远不触发——
    // 无限滚动在长页面上其实也一直是坏的）。这里依赖 loading，哨兵重挂载后重新观察。
    useEffect(() => {
        const el = sentinelRef.current
        if (!el || typeof IntersectionObserver === "undefined") return
        const obs = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) loadNextRef.current()
            },
            { rootMargin: "800px 0px" }
        )
        obs.observe(el)
        // 短首屏：哨兵已在「视口 + 800px 预触发区」内（页面矮到滚不动），主动级联 loadNext，
        // 直到页面变高可滚动（交给 observer）或 hasNext=false。用 rAF 确保哨兵已挂载、ref 有效。
        const fill = () => {
            if (!hasNextRef.current) return
            const rect = el.getBoundingClientRect()
            if (rect.top <= window.innerHeight + 800) {
                loadNext().then(() => requestAnimationFrame(fill))
            }
        }
        requestAnimationFrame(fill)
        return () => obs.disconnect()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading])

    return (
        <>
            <Helmet>
                <title>{`${t('article.title')} - ${siteConfig.name}`}</title>
                <meta property="og:site_name" content={siteName} />
                <meta property="og:title" content={t('article.title')} />
                <meta property="og:image" content={siteConfig.avatar} />
                <meta property="og:type" content="article" />
                <meta property="og:url" content={document.URL} />
            </Helmet>
            <Waiting for={!loading || items.length > 0}>
                <main className="w-full flex flex-col justify-center items-center mb-8">
                    <div className="wauto text-start text-black dark:text-white py-4 text-4xl font-bold">
                        <p>
                            {type === 'draft' ? t('draft_bin') : type === 'normal' ? t('article.title') : t('unlisted')}
                        </p>
                        <div className="flex flex-row justify-between">
                            <p className="text-sm mt-4 text-neutral-500 font-normal">
                                {t('article.total$count', { count: total })}
                            </p>
                            {profile?.permission &&
                                <div className="flex flex-row space-x-4">
                                    <Link href={type === 'draft' ? '/?type=normal' : '/?type=draft'} className={`text-sm mt-4 text-neutral-500 font-normal ${type === 'draft' ? "text-theme" : ""}`}>
                                        {t('draft_bin')}
                                    </Link>
                                    <Link href={type === 'unlisted' ? '/?type=normal' : '/?type=unlisted'} className={`text-sm mt-4 text-neutral-500 font-normal ${type === 'unlisted' ? "text-theme" : ""}`}>
                                        {t('unlisted')}
                                    </Link>
                                </div>
                            }
                        </div>
                    </div>
                    <div className={feedListClass}>
                        {items.map(({ id, ...feed }: any) => (
                            <FeedCard key={id} id={id} {...feed} />
                        ))}
                    </div>
                    <div className="wauto flex flex-col items-center mt-4 ani-show">
                        {/* 哨兵：进入视口附近即触发 loadNext */}
                        <div ref={sentinelRef} className="h-10 w-full" aria-hidden="true" />
                        {loading && (
                            <span className="text-sm text-neutral-500 font-normal py-2">
                                {t('loading')}
                            </span>
                        )}
                        {!hasNext && items.length > 0 && (
                            <div className="text-gray-500 pt-6">{t('no_more')}</div>
                        )}
                        {/* 不支持 IntersectionObserver 时的兜底：手动加载更多 */}
                        {hasNext && typeof IntersectionObserver === "undefined" && (
                            <button
                                onClick={() => loadNext()}
                                className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme mt-2"
                            >
                                {t('load_more')}
                            </button>
                        )}
                    </div>
                </main>
            </Waiting>
        </>
    )
}
