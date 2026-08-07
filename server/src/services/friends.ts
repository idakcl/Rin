import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext, CacheImpl, DB } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import * as schema from "../db/schema";
import { friends } from "../db/schema";
import { notify } from "../utils/webhook";
import { resolveWebhookConfig } from "./config-helpers";

// 抓取目标站点图标时使用的浏览器 UA，提高图标获取成功率
const FAVICON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 根据目标站点域名拼出可直连的兜底 favicon 服务地址（返回目标站真实图标）。
// 选用 DuckDuckGo 的 favicon 接口：实测对各站点返回真实图标（非通用默认图），
// 且为公开 CDN，国内外均可直连。
function faviconFallback(targetUrl: string): string {
    try {
        const u = new URL(targetUrl);
        return `https://icons.duckduckgo.com/ip3/${u.host}.ico`;
    } catch {
        return '';
    }
}

/**
 * 从目标站点 HTML 中提取图标地址（优先 apple-touch-icon，其次 icon/shortcut icon）。
 * 抓取失败、超时或提取不到时，回退到公共 favicon 服务的真实图标地址。
 * 整个流程包裹在 try/catch 内，绝不阻塞友链创建。
 */
async function deriveFavicon(targetUrl: string, ua: string): Promise<string> {
    const fallback = faviconFallback(targetUrl);
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(targetUrl, {
            method: 'GET',
            headers: { 'User-Agent': ua, 'Accept': 'text/html' },
            redirect: 'follow',
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok || !res.body) {
            return fallback;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let html = '';
        const LIMIT = 200000;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            html += decoder.decode(value, { stream: true });
            // 图标链接一般在 <head> 内，拿到 </head> 或读取足够长度即可停止
            if (html.length >= LIMIT || html.includes('</head>')) {
                await reader.cancel();
                break;
            }
        }
        const iconHref = extractIconHref(html, targetUrl);
        if (iconHref) {
            return iconHref;
        }
    } catch (e: any) {
        console.error('deriveFavicon failed:', e?.message || e);
    }
    return fallback;
}

function extractIconHref(html: string, base: string): string | null {
    const patterns = [
        // apple-touch-icon（高优先级，通常是高质量方形图标）
        /<link[^>]+rel=["'][^"']*\bapple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/i,
        // <link rel="icon" href="..."> 或 rel="shortcut icon"
        /<link[^>]+rel=["'][^"']*\bicon[^"']*["'][^>]*href=["']([^"']+)["']/i,
        // href 在前、rel 在后
        /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*\bicon[^"']*["']/i,
    ];
    for (const p of patterns) {
        const m = html.match(p);
        if (!m || !m[1]) continue;
        const href = m[1].trim();
        // 跳过 data: 内联垃圾值（如 "data:,"）
        if (/^data:/i.test(href)) continue;
        try {
            // 解析为绝对地址，兼容相对路径与协议相对路径（//host/x.ico）
            return new URL(href, base).href;
        } catch {
            continue;
        }
    }
    return null;
}

export function FriendService(): Hono {
    const app = new Hono();

    // GET /friend
    app.get('/', async (c: AppContext) => {
        const admin = c.get('admin');
        const uid = c.get('uid');
        const db = c.get('db');
        
        const friend_list = await profileAsync(c, 'friend_list_db', () => (admin
            ? db.query.friends.findMany({
                orderBy: (friends: any, { asc, desc }: { asc: any, desc: any }) => [
                    desc(friends.sort_order), 
                    asc(friends.createdAt)
                ]
            })
            : db.query.friends.findMany({
                where: eq(friends.accepted, 1),
                orderBy: (friends: any, { asc, desc }: { asc: any, desc: any }) => [
                    desc(friends.sort_order), 
                    asc(friends.createdAt)
                ]
            })));
            
        const apply_list = uid ? await profileAsync(c, 'friend_apply_lookup', () => db.query.friends.findFirst({ where: eq(friends.uid, uid) })) : null;
        return c.json({ friend_list, apply_list });
    });

    // POST /friend
    app.post('/', async (c: AppContext) => {
        const admin = c.get('admin');
        const uid = c.get('uid');
        const username = c.get('username');
        const db = c.get('db');
        const env = c.get('env');
        const clientConfig = c.get('clientConfig');
        const serverConfig = c.get('serverConfig');
        const body = await profileAsync(c, 'friend_create_parse', () => c.req.json());
        const { name, desc, avatar, url } = body;
        const descStr = (typeof desc === 'string') ? desc.trim() : '';
        const avatarStr = (typeof avatar === 'string') ? avatar.trim() : '';
        
        const enable = await profileAsync(c, 'friend_create_config', () => clientConfig.getOrDefault('friend_apply_enable', true));
        if (!enable && !admin) {
            return c.text('Friend Link Apply Disabled', 403);
        }
        
        if (name.length > 20 || descStr.length > 100 || avatarStr.length > 100 || url.length > 100) {
            return c.text('Invalid input', 400);
        }
        
        // 名称、网址为必填；描述、头像为选填
        if (name.length === 0 || url.length === 0) {
            return c.text('Invalid input', 400);
        }
        
        if (!uid) {
            return c.text('Unauthorized', 401);
        }
        
        if (!admin) {
            const exist = await profileAsync(c, 'friend_create_existing', () => db.query.friends.findFirst({ where: eq(friends.uid, uid) }));
            if (exist) {
                return c.text('Already sent', 400);
            }
        }
        
        // 未填写头像时，自动获取目标站点的图标（抓取失败则回退到 /favicon.ico）
        const finalAvatar = avatarStr.length > 0
            ? avatarStr
            : await deriveFavicon(url, FAVICON_UA);
        
        const accepted = admin ? 1 : 0;
        await profileAsync(c, 'friend_create_insert', () => db.insert(friends).values({
            name, desc: descStr, avatar: finalAvatar, url, uid: uid, accepted
        }));

        if (!admin) {
            const {
                webhookUrl,
                webhookMethod,
                webhookContentType,
                webhookHeaders,
                webhookBodyTemplate,
            } = await profileAsync(c, 'friend_create_webhook_config', () => resolveWebhookConfig(serverConfig, env));
            const frontendUrl = new URL(c.req.url).origin;
            const content = `${frontendUrl}/friends\n${username} 申请友链: ${name}\n${desc}\n${url}`;
            await profileAsync(c, 'friend_create_notify', () => notify(
                webhookUrl || "",
                {
                    event: "friend.created",
                    message: content,
                    title: name,
                    url: `${frontendUrl}/friends`,
                    username: username || "",
                    content: url,
                    description: desc,
                },
                {
                    method: webhookMethod,
                    contentType: webhookContentType,
                    headers: webhookHeaders,
                    bodyTemplate: webhookBodyTemplate,
                },
            ));
        }
        return c.text('OK');
    });

    // PUT /friend/:id
    app.put('/:id', async (c: AppContext) => {
        const admin = c.get('admin');
        const uid = c.get('uid');
        const username = c.get('username');
        const db = c.get('db');
        const env = c.get('env');
        const clientConfig = c.get('clientConfig');
        const serverConfig = c.get('serverConfig');
        const id = c.req.param('id');
        const body = await profileAsync(c, 'friend_update_parse', () => c.req.json());
        const { name, desc, avatar, url, accepted, sort_order } = body;
        
        const enable = await profileAsync(c, 'friend_update_config', () => clientConfig.getOrDefault('friend_apply_enable', true));
        if (!enable && !admin) {
            return c.text('Friend Link Apply Disabled', 403);
        }
        
        if (!uid) {
            return c.text('Unauthorized', 401);
        }
        
        const exist = await profileAsync(c, 'friend_update_lookup', () => db.query.friends.findFirst({ where: eq(friends.id, parseInt(id)) }));
        if (!exist) {
            return c.text('Not found', 404);
        }
        
        if (!admin && exist.uid !== uid) {
            return c.text('Permission denied', 403);
        }
        
        let finalAccepted = accepted;
        let finalSortOrder = sort_order;
        
        if (!admin) {
            finalAccepted = 0;
            finalSortOrder = undefined;
        }
        
        function wrap(s: string | undefined) {
            return s ? s.length === 0 ? undefined : s : undefined;
        }
        
        await profileAsync(c, 'friend_update_db', () => db.update(friends).set({
            name: wrap(name),
            desc: wrap(desc),
            avatar: wrap(avatar),
            url: wrap(url),
            accepted: finalAccepted === undefined ? undefined : finalAccepted,
            sort_order: finalSortOrder === undefined ? undefined : finalSortOrder,
        }).where(eq(friends.id, parseInt(id))));
        
        if (!admin) {
            const {
                webhookUrl,
                webhookMethod,
                webhookContentType,
                webhookHeaders,
                webhookBodyTemplate,
            } = await profileAsync(c, 'friend_update_webhook_config', () => resolveWebhookConfig(serverConfig, env));
            const frontendUrl = new URL(c.req.url).origin;
            const content = `${frontendUrl}/friends\n${username} 更新友链: ${name}\n${desc}\n${url}`;
            await profileAsync(c, 'friend_update_notify', () => notify(
                webhookUrl || "",
                {
                    event: "friend.updated",
                    message: content,
                    title: name,
                    url: `${frontendUrl}/friends`,
                    username: username || "",
                    content: url,
                    description: desc,
                },
                {
                    method: webhookMethod,
                    contentType: webhookContentType,
                    headers: webhookHeaders,
                    bodyTemplate: webhookBodyTemplate,
                },
            ));
        }
        return c.text('OK');
    });

    // DELETE /friend/:id
    app.delete('/:id', async (c: AppContext) => {
        const admin = c.get('admin');
        const uid = c.get('uid');
        const db = c.get('db');
        const id = c.req.param('id');
        
        if (!uid) {
            return c.text('Unauthorized', 401);
        }
        
        const exist = await profileAsync(c, 'friend_delete_lookup', () => db.query.friends.findFirst({ where: eq(friends.id, parseInt(id)) }));
        if (!exist) {
            return c.text('Not found', 404);
        }
        
        if (!admin && exist.uid !== uid) {
            return c.text('Permission denied', 403);
        }
        
        await profileAsync(c, 'friend_delete_db', () => db.delete(friends).where(eq(friends.id, parseInt(id))));
        return c.text('OK');
    });

    return app;
}

export async function friendCrontab(
    env: Env,
    ctx: ExecutionContext,
    db: DB,
    cache: CacheImpl,
    serverConfig: CacheImpl,
    clientConfig: CacheImpl
) {
    const enable = await serverConfig.getOrDefault('friend_crontab', true);
    const ua = await serverConfig.get('friend_ua') || 'Rin-Check/0.1.0';
    
    if (!enable) {
        console.info('friend crontab disabled');
        return;
    }
    
    const friend_list = await db.query.friends.findMany();
    console.info(`total friends: ${friend_list.length}`);
    
    let health = 0;
    let unhealthy = 0;
    
    for (const friend of friend_list) {
        console.info(`checking ${friend.name}: ${friend.url}`);
        try {
            const response = await fetch(new Request(friend.url, { 
                method: 'GET', 
                headers: { 'User-Agent': ua } 
            }));
            console.info(`response status: ${response.status}`);
            console.info(`response statusText: ${response.statusText}`);
            
            if (response.ok) {
                ctx.waitUntil(db.update(schema.friends).set({ health: "" }).where(eq(schema.friends.id, friend.id)));
                health++;
            } else {
                ctx.waitUntil(db.update(schema.friends).set({ health: `${response.status}` }).where(eq(schema.friends.id, friend.id)));
                unhealthy++;
            }
        } catch (e: any) {
            console.error(e.message);
            ctx.waitUntil(db.update(schema.friends).set({ health: e.message }).where(eq(schema.friends.id, friend.id)));
            unhealthy++;
        }
    }
    
    console.info(`update friends health done. Total: ${health + unhealthy}, Healthy: ${health}, Unhealthy: ${unhealthy}`);
}
