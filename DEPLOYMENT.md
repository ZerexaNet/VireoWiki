# VireoWiki 中文部署教程（Cloudflare Workers）

本文适用于从零部署一个公开 Wiki。VireoWiki 使用 **Workers + D1 + KV + R2**：D1 保存用户和页面数据，KV 保存 OAuth 状态与会话缓存，R2 保存上传的媒体。至少配置一种 OAuth 登录方式，用户才能登录、编辑和进入管理后台。下文以 `wiki.example.com` 为示例域名，请替换为你实际拥有的域名。

> **已有站点升级：**不要在已有 D1 上当作全新安装执行整份建表脚本，也不要把生产数据库 ID 换成新库。先备份数据库与 R2，核对当前版本需要的迁移，再部署代码。本文的初始化命令针对**空数据库**。

## 1. 准备

- 一个已启用 Workers、D1、KV、R2 的 Cloudflare 账户；自定义域名需要在该账户的 Cloudflare Zone 中。暂时没有域名，可先用 `*.workers.dev` 地址，但 OAuth 回调地址必须与最终访问地址一致。
- 本机 Node.js **22.12.0 或更高版本**、Git 和 npm。仓库使用 Astro 6；运行 `node -v` 检查版本。
- 一个可配置回调 URI 的 OAuth 应用（NodeLoc、Google 或 Discord）。建议在配置 `SUPER_ADMIN_EMAILS` 之前确认该提供方确实返回**已验证的邮箱**。

```bash
git clone https://github.com/ZerexaNet/VireoWiki.git
cd VireoWiki
npm ci
npx wrangler login
npx wrangler whoami
```

`wrangler login` 会在浏览器里让你授权 Cloudflare。后续命令应在仓库根目录运行，且使用同一个 Cloudflare 账户。

## 2. 创建三个必需资源

下面的资源名仅为示例，可以自行更换，但配置文件中的名称和 ID 要对应。每条命令执行后，记下输出的 D1 `database_id` 和 KV `id`。

```bash
npx wrangler d1 create vireowiki-db
npx wrangler kv namespace create vireowiki-kv
npx wrangler r2 bucket create vireowiki-media
```

R2 桶无需设置为公开桶：本项目通过 Worker 的 `/media/...` 路由读取 `MEDIA` 绑定。不要把 `MEDIA_PUBLIC_URL` 写成 R2 桶的 API 地址。

## 3. 建立 `wrangler.toml`

复制仓库自带的示例：

```bash
cp 'wrangler example.toml' wrangler.toml
```

Windows PowerShell 使用：

```powershell
Copy-Item 'wrangler example.toml' wrangler.toml
```

`wrangler.toml` 已被 `.gitignore` 排除。只在其中填写普通配置；Client Secret、Turnstile 私钥等使用 Worker Secret。

确认文件顶部有 `compatibility_flags = ["nodejs_compat"]`。项目的 Web Push 依赖会引用 `node:crypto`；缺少此标志时 Wrangler 构建会给出运行时警告。仓库示例已包含该标志。

### 必需绑定

在复制得到的配置中填写以下字段，保留 `binding` 的大小写：

| 配置位置 | 要填写的值 | 示例 |
| --- | --- | --- |
| `name` | Worker 名称 | `vireowiki` |
| `[[d1_databases]]` 的 `binding` | 固定为 `DB` | `DB` |
| 同组的 `database_name`、`database_id` | 第 2 步创建的数据库名称和 ID | `vireowiki-db`、创建命令返回的 UUID |
| `[[kv_namespaces]]` 的 `binding` | 固定为 `KV` | `KV` |
| 同组的 `id` | 第 2 步返回的 KV ID | 创建命令返回的 ID |
| 第一个 `[[r2_buckets]]` 的 `binding` | 固定为 `MEDIA` | `MEDIA` |
| 同组的 `bucket_name` | 第 2 步创建的桶名 | `vireowiki-media` |

示例里还有一个 `binding = "RAG_BUCKET"` 的**第二个** R2 块、`[[analytics_engine_datasets]]` 块和 `[ai]` 块。第一次部署且不使用 AI 搜索/Analytics Engine 时，**完整删除这三个块**，不要保留空的 `bucket_name` 或 `dataset`。`[assets]`、`[build]`、`[observability]`、`[triggers]` 则按示例保留；管理员 Durable Object 块本来就是注释，首装无需启用。

### 站点变量

在 `[vars]` 中至少修改这些值（域名不要带尾部 `/`）：

```toml
WIKI_NAME = "VireoWiki"
WIKI_VISIBILITY = "open"
WIKI_PUBLIC_BASE_URL = "https://wiki.example.com"
MEDIA_PUBLIC_URL = "https://wiki.example.com/media"
SUPER_ADMIN_EMAILS = "admin@example.com"
MCP_MODE = "disabled"
RAG_SEARCH_ENABLED = "false"
ALLOW_CRAWL = "false"
```

`SUPER_ADMIN_EMAILS` 必须是你实际用于 OAuth 登录的已验证邮箱，多个邮箱用英文逗号隔开。不要保留示例中的 `test@example.com`。`WIKI_VISIBILITY = "open"` 允许匿名阅读；示例配置的 `ALLOW_CRAWL` 原值为 `true`，请在首次验收前改成 `false`，准备公开收录时再改回 `true`。`MCP_MODE = "disabled"` 是首装建议，之后需要公开 MCP 时再手动开启。

示例中的 `PRIVACY_POLICY`、`TERMS_OF_SERVICE` 和 `WIKI_SYNTAX` 是页面标题。运营前请改成你的中文标题，并在 Wiki 中创建对应页面；这些变量不会自动生成协议正文。`WIKI_HOME_PAGE` 留空时使用程序默认首页。`EDIT_REQUEST_ENABLED = "false"` 表示尚未启用编辑申请审核，不能把它当成已经开启。

`[assets]` 中的 `run_worker_first` 请保留示例配置。若以后新增动态路由，需要检查这组路径是否应先经过 Worker，尤其是与静态 HTML 同名的路径。

## 4. 配置登录（至少选择一种）

`AUTH_PROVIDERS` 是逗号分隔的标识，允许 `nodeloc`、`google`、`discord`。只填写已配置完成的提供方，例如 `AUTH_PROVIDERS = "nodeloc"`。回调 URI 的**协议、域名和路径**须与 OAuth 应用后台登记的一字不差；改域名后需同步修改 OAuth 应用和 Wrangler 配置并重新部署。不同提供方账号不会自动按相同邮箱合并。

### 方案 A：NodeLoc

1. 前往 [NodeLoc 开放登录应用页](https://www.nodeloc.com/oauth-provider/applications) 创建应用。
2. 将应用回调 URI 设为 `https://wiki.example.com/auth/nodeloc/callback`（这是 VireoWiki 的路径）。
3. 在 `[vars]` 中填写：

   ```toml
   AUTH_PROVIDERS = "nodeloc"
   NODELOC_CLIENT_ID = "应用返回的 Client ID"
   NODELOC_REDIRECT_URI = "https://wiki.example.com/auth/nodeloc/callback"
   ```

4. 在仓库根目录运行 `npx wrangler secret put NODELOC_CLIENT_SECRET`，按提示输入 Client Secret。NodeLoc 登录要求其 UserInfo 提供已验证邮箱。更多说明见 [NODELOC_AUTH.md](NODELOC_AUTH.md)。

### 方案 B：Google

在 Google Cloud 的 OAuth 客户端中登记 `https://wiki.example.com/auth/google/callback`，并在 `[vars]` 中填写 `AUTH_PROVIDERS = "google"`、`GOOGLE_CLIENT_ID`、`GOOGLE_REDIRECT_URI`；然后运行：

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 方案 C：Discord

在 Discord 应用 OAuth 设置中登记 `https://wiki.example.com/auth/discord/callback`，并在 `[vars]` 中填写 `AUTH_PROVIDERS = "discord"`、`DISCORD_CLIENT_ID`、`DISCORD_REDIRECT_URI`；然后运行：

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET
```

如需同时启用多个提供方，写成 `AUTH_PROVIDERS = "nodeloc,google,discord"`，并分别配置各自的 ID、回调和 Secret。首次配置 Secret 时 Wrangler 可能会提示创建草稿 Worker；按提示操作后，继续执行下面的正式部署。

## 5. 初始化远程 D1

**只对空数据库执行：**

```bash
npx wrangler d1 execute vireowiki-db --remote --file=./migrations/schema.sql
```

确认至少存在 `users`、`pages`、`revisions` 和 `settings`：

```bash
npx wrangler d1 execute vireowiki-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','pages','revisions','settings');"
```

`--remote` 指向 Cloudflare 上的生产 D1。`wrangler dev` 默认使用本地数据库；若要本机开发，另行执行同一 SQL 的 `--local` 命令，不要把本地初始化当作生产初始化。

## 6. 构建、发布和绑定域名

```bash
npm run typecheck
npm run typecheck:client
npm run build
npm run deploy
```

`[build]` 已设置为 `npm run build`，所以 `npm run deploy` 还会触发一次构建。部署输出中的 `*.workers.dev` 地址可用于临时检查，但 OAuth 应用的回调应与**当前实际访问地址**相同。生产环境建议绑定自定义域名：在 Cloudflare 控制台的 **Workers & Pages → 该 Worker → Settings → Domains & Routes → Add → Custom Domain** 添加 `wiki.example.com`。也可在 `wrangler.toml` 顶层配置：

```toml
[[routes]]
pattern = "wiki.example.com"
custom_domain = true
```

使用配置文件绑定后再次运行 `npm run deploy`。域名应已在同一 Cloudflare 账户的 Zone 中；完成后将 `WIKI_PUBLIC_BASE_URL`、`MEDIA_PUBLIC_URL` 以及启用的 OAuth 回调统一改为新域名，并在 OAuth 提供方后台同步登记，再部署一次。

## 7. 首次验收

1. 打开 `/` 和 `/login`；`/api/auth/providers` 应显示你启用的登录提供方。
2. 用 `SUPER_ADMIN_EMAILS` 中的邮箱完成登录，进入 `/admin`。若未获得管理员权限，核对 OAuth 提供方返回的邮箱及大小写，而不是直接修改数据库角色。
3. 新建一篇测试条目，检查 `/w/条目名`、编辑、修订历史和搜索。另用无痕窗口确认匿名阅读。
4. 以普通账号测试上传一张小图片，确认返回的 `/media/...` 图片可打开；检查 `MEDIA_PUBLIC_URL` 与站点域名、`MEDIA` 桶绑定。
5. 创建服务条款、隐私政策等页面，检查注册策略、编辑 ACL、媒体权限和管理后台的站点设置。公开编辑前再决定是否配置 Turnstile：`TURNSTILE_SITE_KEY` 在 `[vars]`，`TURNSTILE_SECRET_KEY` 用 `npx wrangler secret put TURNSTILE_SECRET_KEY` 保存。

## 8. 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 部署提示 R2 桶、Analytics 数据集或 D1 ID 无效 | 是否把示例中的空绑定留在 `wrangler.toml`；必需绑定的名称和 ID 是否填对 |
| 首页报 D1 的 `no such table` | 是否对**远程** D1 执行了 `schema.sql`；Worker 的 `DB` 是否指向同一个 `database_id` |
| `/login` 有按钮但回调失败 | `AUTH_PROVIDERS`、对应 Client ID / Secret、OAuth 应用登记的回调 URI 与站点域名是否完全一致 |
| NodeLoc 显示未验证邮箱 | NodeLoc 账号的 UserInfo 必须提供 `email_verified = true`，并与管理员邮箱一致 |
| 登录成功但 `/admin` 无权限 | `SUPER_ADMIN_EMAILS` 是否为 OAuth 实际返回的邮箱；新用户是否完成资料设置 |
| 图片上传成功却打不开 | `MEDIA_PUBLIC_URL` 是否为 `https://你的站点/media`，`MEDIA` 桶绑定是否正确 |
| 页面/静态资源被错误重定向 | `[assets]` 的目录和 `run_worker_first` 是否按仓库示例保留；部署前构建是否成功 |

排查线上 Worker 错误可运行 `npx wrangler tail vireowiki`，同时在 Cloudflare 控制台查看 Worker 日志。不要在公开 Issue 或日志中粘贴 OAuth Secret。

## 9. 升级与可选模块

- 升级前先导出 D1：`npx wrangler d1 export vireowiki-db --remote --output=./vireowiki-backup.sql`；媒体文件需另外备份 R2。不要把备份 SQL、`wrangler.toml` 或 `.dev.vars` 提交到公开仓库。
- AI 语义搜索需要单独创建 RAG 专用桶与 AI Search 实例，再按示例启用 `RAG_BUCKET`、`[ai]`、`RAG_SEARCH_ENABLED`、`RAG_AUTORAG_NAME`。基础 Wiki 不依赖这些资源。
- Analytics Engine 的 `ANALYTICS` 绑定可选；不配置时部分站点分析数据无法记录。管理员后台的批处理 Durable Object 也可留待后续单独部署。

## 官方参考

- [Cloudflare D1 Wrangler 命令](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare KV Wrangler 命令](https://developers.cloudflare.com/kv/reference/kv-commands/)
- [Cloudflare R2 Wrangler 命令](https://developers.cloudflare.com/r2/reference/wrangler-commands/)
- [Workers Secret](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers 静态资源路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
