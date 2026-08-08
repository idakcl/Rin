import { getApp } from "./app-instance";
import { extractImageWithMetadata } from "../utils/image";
import { stripMarkdown } from "../utils/markdown";

const ROOT_FEED_PATTERN = /^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/;
const APP_PUBLIC_ROUTE_PATTERN = /^\/(favicon|favicon\.ico)(?:\/|$)/;

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function rewriteApiRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

function isRootFeedRequest(pathname: string) {
  return ROOT_FEED_PATTERN.test(pathname);
}

function isAppPublicRoute(pathname: string) {
  return APP_PUBLIC_ROUTE_PATTERN.test(pathname);
}

function isStaticAssetRequest(pathname: string) {
  return /\.\w+$/.test(pathname);
}

async function tryServeAsset(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200 || (asset.status >= 300 && asset.status < 400)) {
      // 带 content-hash 的文件名天然支持长缓存：显式设为 immutable，
      // 让 CDN 边缘长期缓存、不再每次 revalidate（修复 max-age=0 导致重复下载）。
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    }
  } catch {}

  return null;
}

async function serveSpaEntry(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const url = new URL(request.url);
    const indexRequest = new Request(new URL("/", url.origin), request);
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400)) {
      return indexResponse;
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// 分享卡片(Open Graph / Twitter Card)服务端注入
// 社交爬虫基本不执行 JS，纯 SPA 空壳 HTML 显示不出预览卡片，因此必须在服务端
// 按 URL 把 og:/twitter: 元标签注入到 <head>，再返回。
// ---------------------------------------------------------------------------
type OgData = {
  type: string;
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  siteName?: string;
  twitterCard: string;
};

// 转义 HTML 属性值，防止文章字段破坏标签或注入脚本
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 仅允许 http/https 的 URL 进入属性，避免 javascript:/data: 等危险协议
function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildOgMetaTags(og: OgData): string {
  const tags: string[] = [`<meta property="og:type" content="${og.type}">`];
  if (og.title) tags.push(`<meta property="og:title" content="${og.title}">`);
  if (og.description) tags.push(`<meta property="og:description" content="${og.description}">`);
  if (og.image) tags.push(`<meta property="og:image" content="${og.image}">`);
  if (og.url) tags.push(`<meta property="og:url" content="${og.url}">`);
  if (og.siteName) tags.push(`<meta property="og:site_name" content="${og.siteName}">`);
  // Twitter Card：大图预览(summary_large_image)，微信/Telegram/X/Discord 通用
  tags.push(`<meta name="twitter:card" content="${og.twitterCard}">`);
  if (og.title) tags.push(`<meta name="twitter:title" content="${og.title}">`);
  if (og.description) tags.push(`<meta name="twitter:description" content="${og.description}">`);
  if (og.image) tags.push(`<meta name="twitter:image" content="${og.image}">`);
  return tags.join("\n    ");
}

async function injectOgIntoHtml(indexResponse: Response, og: OgData): Promise<Response> {
  const html = await indexResponse.text();
  const metas = buildOgMetaTags(og);
  const newHtml = html.replace("</head>", `    ${metas}\n</head>`);
  const headers = new Headers(indexResponse.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  // 分享卡片需服务端动态注入，且随文章/站点配置变化；若被边缘缓存，爬虫会拿到陈旧卡片。
  // no-store 让每次请求都进 Worker 重新注入，保证分享卡片永远最新(OG 爬虫请求量很小，无压力)。
  headers.set("Cache-Control", "no-store");
  return new Response(newHtml, {
    status: indexResponse.status,
    statusText: indexResponse.statusText,
    headers,
  });
}

// 文章页卡片：标题 + 正文摘要 + 第一张图
async function getArticleOg(request: Request, env: Env, id: string): Promise<OgData | null> {
  try {
    const origin = new URL(request.url).origin;
    // getApp().fetch 走 Hono 路由(不经 handleFetch 的 /api 重写)，故用已重写路径 /feed/<id>
    const ogHeaders = new Headers(request.headers);
    ogHeaders.set("x-og-preview", "1"); // 告诉 FeedService 跳过访问计数
    const apiReq = new Request(new URL(`/feed/${encodeURIComponent(id)}`, origin), {
      method: request.method,
      headers: ogHeaders,
    });
    const res = await getApp().fetch(apiReq, env);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const title = typeof data?.title === "string" ? data.title : "";
    const content = typeof data?.content === "string" ? data.content : "";
    const summaryRaw =
      data?.summary && String(data.summary).length > 0
        ? String(data.summary)
        : stripMarkdown(content);
    const description = summaryRaw.replace(/\s+/g, " ").trim().slice(0, 200);
    const image = safeUrl(extractImageWithMetadata(content));
    return {
      type: "article",
      title: escapeHtmlAttr(title),
      description: escapeHtmlAttr(description),
      image: image ? escapeHtmlAttr(image) : undefined,
      url: escapeHtmlAttr(new URL(request.url).toString()),
      twitterCard: "summary_large_image",
    };
  } catch {
    return null;
  }
}

// 站点级卡片(首页/标签页/关于等非文章页)：用站点配置
async function getSiteOg(request: Request, env: Env): Promise<OgData> {
  let name = "";
  let description = "";
  let avatar = "";
  try {
    // 站点名/描述/头像由部署时通过 wrangler [vars] 注入 Worker 环境变量，直接读取即可。
    // 不走 /config 端点：该端点需要管理员鉴权，OG 预览的内部请求会拿到 401，
    // 导致卡片只剩 og:type/og:url，缺标题/描述/封面。env vars 即站点配置来源，无需鉴权。
    const ev = env as unknown as Record<string, any>;
    name = typeof ev?.NAME === "string" ? ev.NAME : "";
    description = typeof ev?.DESCRIPTION === "string" ? ev.DESCRIPTION : "";
    avatar = typeof ev?.AVATAR === "string" ? ev.AVATAR : "";
  } catch {
    /* 取不到就用空值，文章卡片不受影响 */
  }
  const image = safeUrl(avatar);
  return {
    type: "website",
    title: escapeHtmlAttr(name),
    description: escapeHtmlAttr(description),
    image: image ? escapeHtmlAttr(image) : undefined,
    url: escapeHtmlAttr(new URL(request.url).toString()),
    twitterCard: "summary_large_image",
  };
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isRootFeedRequest(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isApiRequest(pathname)) {
    return getApp().fetch(rewriteApiRequest(request), env);
  }

  if (isAppPublicRoute(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isStaticAssetRequest(pathname)) {
    const asset = await tryServeAsset(request, env);
    if (asset) {
      return asset;
    }
  }

  const indexResponse = await serveSpaEntry(request, env);
  if (indexResponse) {
    // 注入分享卡片元标签：爬虫不执行 JS，必须在服务端 HTML 的 <head> 写入 og:/twitter:。
    // 文章页取文章数据做文章级卡片；其余页回退到站点级卡片。
    const url = new URL(request.url);
    const feedMatch = url.pathname.match(/^\/feed\/([^/]+)\/?$/);
    let og: OgData | null = null;
    if (feedMatch && feedMatch[1]) {
      og = await getArticleOg(request, env, feedMatch[1]);
    }
    if (!og) {
      og = await getSiteOg(request, env);
    }
    if (og) {
      return injectOgIntoHtml(indexResponse, og);
    }
    // 兜底：即便取不到 OG 数据，也不要透传 ASSETS 的 immutable 长缓存，
    // 否则首页 HTML 会被边缘永久缓存、Worker 再也无法接管注入。
    const fallbackHeaders = new Headers(indexResponse.headers);
    fallbackHeaders.set("Cache-Control", "no-store");
    return new Response(indexResponse.body, {
      status: indexResponse.status,
      statusText: indexResponse.statusText,
      headers: fallbackHeaders,
    });
  }

  return new Response("Hi", { status: 200 });
}
