# VireoWiki

VireoWiki 是 Zerexa 发起的开源、可自行部署的公共协作 Wiki，基于 [CloudWiki](https://github.com/eoeoe22/cloudwiki-public)（MIT）改造，运行在 Cloudflare Workers、D1、R2、KV 上。项目名称与任何特定社区无关；NodeLoc 登录是可选身份提供方。

## 已有能力

Markdown 页面、分类、重定向、模板引用、修订历史、Diff、回退、讨论、页面权限、编辑申请、封禁、媒体上传、全文搜索、关注列表和用户贡献记录。本分支新增管理员修订巡查，支持筛选待巡查编辑，且不能巡查自己的编辑。页面版本隐藏与恢复沿用上游功能。

界面以简体中文为主，默认 HTML 语言与日期格式为中文。Wiki 页面内容保留作者原文；部分高级编辑器提示和上游文档仍有韩语，欢迎继续完善翻译。

## 部署

1. 安装 Node.js 并运行 `npm ci`。
2. 复制 `wrangler example.toml` 为 `wrangler.toml`，填写 D1、KV、R2 绑定和域名；设置 `WIKI_NAME`。
3. 在 Cloudflare 创建至少一个 OAuth 登录应用。默认示例为 Google/Discord；NodeLoc 参见 [NodeLoc 登录接入](NODELOC_AUTH.md)。Client Secret 通过 Workers Secret 保存。
4. 初始化 D1：按 Cloudflare Wrangler 命令执行 `migrations/schema.sql`。已有数据库在首次访问巡查列表时会自动创建 `revision_patrols` 表；也可以提前执行该表的建表语句。先在测试环境构建 `npm run build`，再部署 `npm run deploy`。
5. 验证匿名阅读、注册登录、页面编辑、历史回退、讨论、媒体上传和后台权限。自定义公开站点的服务条款与隐私政策。

`astro.config.mjs` 指向原项目的 `src/astro/pages`，用于生成静态页面。`wrangler.toml` 是环境配置，不应提交包含真实密钥的版本。

## 开源与来源

仓库保留原有的 [AGPL-3.0 许可证](LICENSE)；所引入 CloudWiki 代码的原始 [MIT 许可证与版权声明](LICENSE-UPSTREAM) 单独保存。原作者的说明保存在 [UPSTREAM_README.md](UPSTREAM_README.md)。VireoWiki 的改动包括 NodeLoc OAuth 提供方、独立项目配置与构建修复。尚未在真实 NodeLoc 账号和 Cloudflare 资源上完成端到端部署验证。
