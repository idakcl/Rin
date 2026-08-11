import { useContext, useEffect, useRef, useState } from "react"
import { Helmet } from 'react-helmet'
import { Link, useSearch } from "wouter"
import { FeedCard } from "../components/feed_card"
import { Waiting } from "../components/loading"
import { ProfileContext } from "../state/profile"

import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants"
import { tryInt } from "../utils/int"
import { useTranslation } from "react-i18next";
import { client } from "../app/runtime"

type FeedType = "draft" | "unlisted" | "normal"

type FeedsData = {
    size: number,
    data: any[],
    hasNext: boolean
}

/** 计算分页器的页码窗口（最多围绕当前页展示 5 个页码） */
function getPageWindow(current: number, total: number): number[] {
    const delta = 2
    const start = Math.max(1, current - delta)
    const end = Math.min(total, current + delta)
    const range: number[] = []
    for (let i = start; i <= end; i++) range.push(i)
    return range
}

export function FeedsPage() {
    const { t } = useTranslation()
    const siteConfig = useSiteConfig();
    const query = new URLSearchParams(useSearch());
    const profile = useContext(ProfileContext);
    const type = ((query.get("type") as FeedType) || 'normal')
    const limit = tryInt(siteConfig.pageSize, query.get("limit"))
    const page = Math.max(1, tryInt(1, query.get("page")))
    const feedListClass = siteConfig.feedLayout === "masonry" ? "wauto columns-1 gap-5 md:columns-2" : "wauto flex flex-col ani-show";

    const [status, setStatus] = useState<'loading' | 'idle'>('idle')
    const [feeds, setFeeds] = useState<FeedsData>()
    const ref = useRef("")

    function fetchFeeds() {
        client.feed.list({ page, limit, type })
            .then(({ data }) => {
                if (data) {
                    setFeeds(data)
                }
                setStatus('idle')
            })
            .catch(() => {
                setStatus('idle')
            })
    }

    useEffect(() => {
        const key = `${page} ${limit} ${type}`
        if (ref.current === key) return
        setStatus('loading')
        fetchFeeds()
        ref.current = key
        // 切页后回到顶部（ScrollToTop 只在 pathname 变化时滚顶，query 变化不触发）
        window.scrollTo({ top: 0, behavior: "auto" })
    }, [page, limit, type])

    const feedData = Array.isArray(feeds?.data) ? feeds.data : [];
    const total = feeds?.size ?? 0
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const hasNext = Boolean(feeds?.hasNext)

    function pageHref(target: number) {
        const params = new URLSearchParams(query)
        params.set("page", String(target))
        return `?${params.toString()}`
    }

    const pageNumbers = getPageWindow(page, totalPages)

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
            <Waiting for={status === 'idle'}>
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
                        {feedData.map(({ id, ...feed }: any) => (
                            <FeedCard key={id} id={id} {...feed} />
                        ))}
                    </div>
                    {totalPages > 1 && (
                        <div className="wauto flex flex-wrap items-center justify-center gap-2 mt-6 ani-show">
                            {page > 1 && (
                                <Link href={pageHref(page - 1)} className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme">
                                    {t('previous')}
                                </Link>
                            )}
                            {pageNumbers.map((p) => (
                                <Link key={p} href={pageHref(p)} className={`text-sm font-normal rounded-full px-4 py-2 ${p === page ? "bg-theme text-white" : "bg-w text-theme border border-black/10 dark:border-white/10"}`}>
                                    {p}
                                </Link>
                            ))}
                            {hasNext && (
                                <Link href={pageHref(page + 1)} className="text-sm font-normal rounded-full px-4 py-2 text-white bg-theme">
                                    {t('next')}
                                </Link>
                            )}
                        </div>
                    )}
                </main>
            </Waiting>
        </>
    )
}
