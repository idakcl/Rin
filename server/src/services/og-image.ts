import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";

// 允许经本代理回源的图片主机白名单：仅站点自身图床，避免成为开放代理被滥用。
// 站点主域的图片即便跨路径也同源，不会进到这里；此处只承接 netpan 等外部图床，
// 把它们以同源 URL 暴露给社交爬虫(微信/Telegram)，提升分享卡片缩略图抓取成功率。
const OG_IMAGE_ALLOWED_HOSTS = ["netpan.1234.nyc.mn"];

// 同源 OG 图代理：GET /og-image?src=<encoded-url>
// 微信等社交平台的默认分享卡片对"跨域 / 非常见 TLD"的 og:image 抓取极不稳定，
// 经常拉不到缩略图，卡片退化成纯文字或裸链接；改为同源 URL 后，爬虫从站点主域
// 直接拿到图，卡片(标题+描述+缩略图)稳定显示。Telegram/X/Discord 同理受益。
export function OgImageService(): Hono {
  const app = new Hono();

  app.get("/", async (c: AppContext) => {
    const src = c.req.query("src");
    if (!src) return c.text("missing src", 400);

    let target: URL;
    try {
      target = new URL(src);
    } catch {
      return c.text("invalid src", 400);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return c.text("invalid protocol", 400);
    }
    if (!OG_IMAGE_ALLOWED_HOSTS.includes(target.host)) {
      return c.text("host not allowed", 403);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const upstream = await fetch(target.toString(), {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RinOgBot/1.0)" },
      });
      if (!upstream.ok) {
        return c.text(`upstream ${upstream.status}`, 502);
      }
      const ct = upstream.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) {
        return c.text("not an image", 415);
      }
      const cl = upstream.headers.get("content-length");
      if (cl && Number(cl) > 8 * 1024 * 1024) {
        return c.text("image too large", 413);
      }
      const headers = new Headers();
      headers.set("Content-Type", ct);
      // 图片不可变，长缓存让微信/CDN 边缘复用，减少回源与缩略图延迟。
      headers.set("Cache-Control", "public, max-age=86400");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(upstream.body, { status: 200, headers });
    } catch (e: any) {
      return c.text(`fetch failed: ${e?.message || e}`, 502);
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}
