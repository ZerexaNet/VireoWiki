# VireoWiki：NodeLoc 登录接入

VireoWiki 基于 CloudWiki，支持可选的 NodeLoc OAuth 登录。下述配置适合在 NodeLoc 社区部署公开 Wiki，但项目本身不依赖 NodeLoc。首次上线前先用测试域名验证登录和编辑流程。

## 1. 注册 NodeLoc 应用

在 https://www.nodeloc.com/oauth-provider/applications 创建应用，登记精确的回调地址：

`https://你的域名/auth/nodeloc/callback`

妥善保存 Client ID 和 Client Secret。当前 OIDC 发现文档是 https://www.nodeloc.com/oauth-provider/.well-known/openid-configuration ，不要误用早期 `conn.nodeloc.cc` 的授权端点。

## 2. 创建 Cloudflare 资源并配置

按原仓库 README 创建 D1、R2、KV，复制 `wrangler example.toml` 为 `wrangler.toml`，填写资源绑定 ID 与桶名。将 `AUTH_PROVIDERS` 改为 `"nodeloc"`；需要多种登录时可设置 `"nodeloc,google,discord"`。示例默认的 `WIKI_VISIBILITY = "open"` 和并发编辑检测适合公开 Wiki。按你的站点修改 `WIKI_NAME`。

将 `NODELOC_CLIENT_ID` 填入 `wrangler.toml`，并把 `NODELOC_REDIRECT_URI` 改成应用登记的完整地址；Client Secret 通过 `npx wrangler secret put NODELOC_CLIENT_SECRET` 存入 Worker Secret。不要把 Client Secret 提交到 Git。其他 Google、Discord 配置在仅启用 NodeLoc 时可以留空。

填好 `SUPER_ADMIN_EMAILS`，但注意管理员权限以邮箱识别。正式启用前应使用自己的 NodeLoc 账号确认 UserInfo 返回经过验证的邮箱，避免用未验证邮箱取得管理权限；应用在 `email_verified` 不是 `true` 时会拒绝登录。

根据原 README 初始化 D1 `migrations/schema.sql` 并部署。公开协作开始前，检查管理后台的注册策略、编辑 ACL、编辑申请开关、页面删除与媒体上传权限。`EDIT_REQUEST_ENABLED` 默认关闭，不能把它当成已启用的审核队列。

## 3. 验收

1. 访问 `/login`，确认显示“NodeLoc”登录入口。
2. 登录后确认新用户创建、显示名和头像；再退出并重登，确认复用同一账号。
3. 用普通账号创建或修改测试页面，检查历史、Diff、回退和讨论，并验证禁用、保护与编辑申请策略。
4. 检查不同账号和无痕窗口的公开阅读权限；检查 OAuth 错误状态及重复登录时是否意外生成账号。

已知限制：原有的 `users.email` 是全局唯一，之前用相同邮箱通过 Google/Discord 注册的 CloudWiki 账号不能自动合并到 NodeLoc；迁移老站账号要先设计身份映射，不应按邮箱直接绑定。
