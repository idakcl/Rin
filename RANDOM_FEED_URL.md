# Rin 随机 Feed URL 改造说明

本仓库基于 [openRin/Rin](https://github.com/openRin/Rin) 改造，目标是**让文章链接变成无序随机串，防止被顺序枚举猜测**（原版 URL 形如 `/feed/1`、`/feed/2`……可顺序遍历）。

## 改了什么

| # | 改动 | 文件 | 行为 |
|---|------|------|------|
| 1 | 发文章自动生成随机 alias | `server/src/services/feed.ts` | 新建文章时若未手动指定 `alias`，自动生成 16 位 base62 随机串（含字母，避免纯数字被误判为 id） |
| 2 | 屏蔽纯数字 id 的公网访问 | `server/src/services/feed.ts` | 普通访客用纯数字 `/feed/4` 访问直接返回 404；**管理员仍可用数字 id**（后台管理方便） |
| 3 | 订阅源链接改用 alias | `server/src/services/rss.ts` | RSS / Atom / JSON Feed 的 `id` 与 `link` 均使用随机 alias，列表里不再出现数字痕迹 |
| 4 | 前端链接统一走 alias | `client/src/components/feed_card.tsx`、`client/src/page/writing.tsx`、`client/src/page/timeline.tsx`、`client/src/components/adjacent_feed.tsx` | 卡片、时间线、上一篇/下一篇、发布/更新后跳转，全部指向 `/feed/<alias>` |

> 注：仅服务端内部 API（如 `/api/feed/<数字>`）保留数字 id，这是正常行为，不影响公网可枚举性。对外通知（Webhook 新评论提醒，`server/src/services/comments.ts`）也统一使用 alias 链接，不会泄露数字 id，且任何人可正常打开。

## 访问行为一览

| 角色 | 访问 `/feed/<随机串>` | 访问 `/feed/<数字>` |
|------|----------------------|---------------------|
| 访客（未登录/非管理员） | ✅ 正常打开 | ❌ 404 |
| 管理员 | ✅ 正常打开 | ✅ 正常打开（保留后台可用） |

订阅源（RSS/Atom/JSON Feed）中的所有条目链接均为随机 alias。

## 全新部署（Workers / Cloudflare Pages）

适用于从零部署一个**没有旧文章**的全新博客：

1. **克隆本仓库**
   ```bash
   git clone https://github.com/idakcl/rinxfeedbuddy.git
   cd rinxfeedbuddy
   ```

2. **安装依赖**（建议使用 Bun）
   ```bash
   bun install
   ```

3. **按 Rin 官方文档配置 Cloudflare 资源**
   - D1 数据库（博客数据）
   - R2 存储桶（图片等静态资源）
   - 在 `wrangler.toml` / 环境变量中填入 `JWT_SECRET`、`S3_*`、`RSS_TITLE` 等

4. **部署**
   ```bash
   bun run deploy        # 或按官方推荐的 Cloudflare Pages / Workers 流程
   ```

5. **发布第一篇文章**
   - 后台写文章并发布，系统会自动分配随机 alias；
   - 文章地址形如 `https://你的域名/feed/aZ3kPq9xY2Wn4mR7t`，无法被顺序猜测。

## 部署注意事项（避开已有资源冲突）

仓库根**没有** `wrangler.toml`，部署所需资源名由环境变量决定（见 `.github/workflows/deploy.yml`）。默认值如下，若你的 Cloudflare 账号里已有同名资源，需注意：

| 资源 | 默认名 | 覆盖变量（Actions Variables） | 说明 |
|------|--------|-------------------------------|------|
| Workers 后端 | `rin-server` | `WORKER_NAME` | 同账号内重名**不会报错**，Wrangler 会就地更新该 Worker；真正风险是**覆盖**其原有代码。想保留旧 Worker，改成新名（如 `rinx-server`） |
| D1 数据库 | `rin` | `DB_NAME` | 同名会**复用**已有库（可能带旧数据）。全新博客想要干净库，改成新名（如 `rinx`）或在控制台删掉旧库再部署 |
| R2 存储桶 | 未设置（不自动建） | `R2_BUCKET_NAME` | 设置后部署自动推导 `S3_*` 配置；建议指定新桶名避免混用 |

- **Build 阶段不会冲突**：CI 的 Build 工作流跑的是 `wrangler deploy --dry-run`，只做类型检查与构建产物，**不连接 Cloudflare**，不存在命名冲突。
- 设置方式：仓库 `Settings → Secrets and variables → Actions → Variables` 添加对应变量即可，无需改代码。

## 自定义

- **alias 长度 / 字符集**：修改 `server/src/services/feed.ts` 中的 `generateRandomAlias(len = 16)`。
- **手动指定 slug**：发文章时在 `alias` 字段填入自定义短链（如 `my-post`），会优先于自动生成的随机串。
- **放开数字 id 公网访问**：若不需要拦截，删除 `server/src/services/feed.ts` 中 `GET /:id` 路由里的
  ```ts
  if (id_num !== null && !admin) {
      return c.json({ error: 'not found' }, 404);
  }
  ```

## 测试

- 单元测试：`server/src/services/__tests__/feed.test.ts`（已全部通过，含「非管理员用数字 id 访问已发布文章返回 404」用例）。
- 订阅源（RSS/Atom/JSON Feed）的地址生成逻辑见 `server/src/services/rss.ts`，链接已统一为 alias。
