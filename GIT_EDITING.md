# 使用 Git 编辑文档

登录 Wiki，在一篇文档的“更多 → Git 提交”中获取仓库地址并生成 通用 API 令牌。每篇文档对应一个 HTTPS Git 仓库，只有 `main` 分支与 `page.md` 文件。用户名可任意填写，密码使用令牌；不要把令牌写入仓库或远程 URL。令牌只显示一次，默认 30 天有效，可选择 7/30/90/365 天、自定义到期时间或永不过期，也可随时撤销或更换。个人设置和 `/tokens` 页面也能管理令牌。

```sh
git clone https://www.nodeloc.wiki/git/pages/<文档ID>.git
cd <文档ID>
# 编辑 page.md
git add page.md
git commit -m "补充安装步骤"
git pull --rebase
git push origin main
```

服务器同时检查 `git:push`、`wiki:edit`、文档 ACL、私有文档访问权限、封禁状态和最新版本。只有密码认证的 Git 写入才会跳过浏览器 Turnstile；同样的编辑内容仍经过 Wiki 编辑器的校验、审批规则与缓存更新。需要审批的提交可在网页处理；Git 不会提前更新分支。

远端只接受当前 `main` 的线性快进提交。所有用户，包括最高管理员，都不能通过 Git 覆盖历史、删除或创建分支、写入标签、上传符号链接或提交合并节点。过期的基准会被拒绝，请先 pull/rebase。Git 协议不传递客户端的 `--force` 标志，因此服务器禁止的是它所尝试的非快进覆盖；即使带上 `--force` 也不能改写远端历史。

网页修订在 Git 访问时追加为提交，Git 原始提交及其 SHA 在仓库中保留。一次包含多个 Git 提交的推送生成一条 Wiki 修订，摘要带上最终提交 SHA，Wiki 作者始终为认证的账号。Git 的 author/email 是用户提供的信息，不代表已验证身份。

第一版限制每次推送最多 40 个提交、200 个 pack 对象、4 MiB 压缩数据，`page.md` 最大 512 KiB；服务端会进一步检查膨胀后的对象与 delta 大小。首次接入导入最多 20 条可见修订，每次读取最多 100 条提交及 8 MiB 正文，较旧历史成为 shallow 边界。只支持标准 HTTPS smart HTTP，暂不支持 SSH、客户端指定 depth、其他文件或批量新建文档。

私有页面要求相应权限，删除的页面停止提供仓库。隐藏、永久清除或已物理删除的修订会截断下载的历史，Git 对象不能通过公共媒体接口读取。已经下载到用户电脑上的内容无法远程撤回。

开发验证：`npm run test:git` 使用真实 Git CLI 验证 clone、push、网页修改后的 pull、拒绝 force/delete、权限撤销、私有访问与隐藏修订边界。


## 通用 API 和 MCP

Git、Wiki API 和 MCP 共用同一个个人令牌。API 请求使用 `Authorization: Bearer <令牌>`；Git 仍使用 HTTP Basic，令牌作为密码。现有 `git_` 令牌继续有效，新生成的令牌使用 `wiki_` 前缀。权限每次请求按当前账号与文档 ACL 检查，封禁、撤销和到期立即生效。

`GET/POST/DELETE /api/me/api-token` 用于网页登录后的管理，原 `/api/me/git-token` 保留兼容。POST JSON 可指定 `expires_at`（Unix 秒，必须为未来时间），`0` 或 `null` 表示永不过期，不传则为 30 天。令牌本身不能创建或管理令牌；生成新令牌会替换旧令牌。服务端仅保存 SHA-256 摘要。
