# VireoWiki

VireoWiki 是 Zerexa 发起的开源、可自行部署的公共协作 Wiki，基于 [CloudWiki](https://github.com/eoeoe22/cloudwiki-public)（MIT）改造，运行在 Cloudflare Workers、D1、R2、KV 上。项目名称与任何特定社区无关；NodeLoc 登录是可选身份提供方。

## 已有能力

Markdown 页面、分类、重定向、模板引用、修订历史、Diff、回退、讨论、页面权限、编辑申请、封禁、媒体上传、全文搜索、关注列表和用户贡献记录。另支持管理员修订巡查，支持筛选待巡查编辑，且不能巡查自己的编辑。页面版本隐藏与恢复沿用上游功能。

界面以简体中文为主，默认 HTML 语言与日期格式为中文。Wiki 页面内容保留作者原文；部分高级编辑器提示和上游文档仍有韩语，欢迎继续完善翻译。

## 部署

首次安装请按 [中文详细部署教程](DEPLOYMENT.md) 操作；下面是简要步骤。

1. 安装 Node.js 并运行 `npm ci`。
2. 复制 `wrangler example.toml` 为 `wrangler.toml`，填写 D1、KV、R2 绑定和域名；设置 `WIKI_NAME`。
3. 在 Cloudflare 创建至少一个 OAuth 登录应用。默认示例为 Google/Discord；NodeLoc 参见 [NodeLoc 登录接入](NODELOC_AUTH.md)。Client Secret 通过 Workers Secret 保存。
4. 初始化 D1：按 Cloudflare Wrangler 命令执行 `migrations/schema.sql`。已有数据库在首次访问巡查列表时会自动创建 `revision_patrols` 表；也可以提前执行该表的建表语句。先在测试环境构建 `npm run build`，再部署 `npm run deploy`。
5. 验证匿名阅读、注册登录、页面编辑、历史回退、讨论、媒体上传和后台权限。自定义公开站点的服务条款与隐私政策。

`astro.config.mjs` 指向原项目的 `src/astro/pages`，用于生成静态页面。`wrangler.toml` 是环境配置，不应提交包含真实密钥的版本。

## 开源与来源

VireoWiki 当前版本采用 [Mozilla Public License 2.0](LICENSE)（MPL-2.0）；所引入 CloudWiki 代码的原始 [MIT 许可证与版权声明](LICENSE-UPSTREAM) 单独保存。此前已发布版本所授予的权利不受此次调整影响。原作者的说明保存在 [UPSTREAM_README.md](UPSTREAM_README.md)。VireoWiki 的改动包括 NodeLoc OAuth 提供方、独立项目配置与构建修复。尚未在真实 NodeLoc 账号和 Cloudflare 资源上完成端到端部署验证。

## 权限组、站点协议与 Git 编辑

最高管理员可在后台“权限组”分别配置普通用户、讨论管理员、管理员的创建、编辑、删除、恢复、移动、回退、隐藏修订、媒体及 Git 提交权限。各组独立保存，撤销普通用户权限不会改变其他组。最高管理员、后台访问资格及永久删除权限保持固定。

后台“服务条款与隐私政策”提供两份可编辑的 Markdown 初始模板，发布后作为普通 Wiki 文档保留修订历史。页脚入口为 `/terms`、`/privacy`，使用站点配置中的协议文档地址；请按本站实际服务修改模板。

文档的“更多 → Git 提交”支持使用标准 Git 客户端提交 `page.md`，详见 [Git 编辑说明](GIT_EDITING.md)。网页与 Git 共用 Wiki 权限和编辑校验，服务器拒绝所有非快进覆盖及分支删除。

统计功能在未配置 Analytics Engine 或其查询凭据时使用 D1 后备实现，成功的文档 API 读取（包括单页导航）记录访问量，编辑器读取和私有/删除页面不计入公开热门。后台统计同样可直接使用；小时汇总保留约 90 天，文档累计访问量单独保留。后备性能百分位使用响应时间直方图上界估算。历史上没有记录的访问不能补算。

生产配置默认启用 MCP（`MCP_MODE = "open"`）：公共阅读工具可连接 `/api/mcp`，编辑操作仍需有效身份及相应权限。可通过配置设为 `disabled` 关闭。


### 消歧义页面

在编辑器中勾选“消歧义页面”，或点击“生成消歧义模板”列出同名条目的不同含义。使用 `[[条目标题|显示名称]]` 添加链接与简短说明。也可从普通条目手动链接到 `[[名称（消歧义）]]`。

页面顶部会显示消歧义提示和类型徽标。类型保存在正文开头的 `<!-- vireowiki:disambiguation -->` 标记中，Git、MCP 和修订历史均能保留；取消勾选只移除标记，保留正文。消歧义页不能同时设置重定向，编辑仍遵循普通文档权限与 ACL。
