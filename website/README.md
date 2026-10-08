# Daisy 官网（website/）

Daisy 语音助手的官方落地页源码，纯静态站点（HTML + CSS + JS），无构建步骤。

- 线上地址：<https://daisy-voice.pages.dev>
- 部署方式：Cloudflare Pages，项目名 `daisy-voice`（wrangler 直传，未接 Git 自动构建）
- 应用主仓库：<https://github.com/SenluAi/Daisy-Voice-Agent>

## 目录结构

```
website/
├── index.html     # 页面结构与文案
├── index.css      # 样式
├── index.js       # 交互脚本（导航、动效、下载按钮等）
└── assets/        # 图片、二维码等静态资源
```

页面板块顺序：首屏 Hero → 能力展示（打开应用 / 站内搜索 / 问问屏幕 / 处理小事 / 编辑 Word / 填写 PDF / 剪辑音视频 / 转换格式）→ 实时 Live 模式 → 浏览器操控 → 电脑操控 → 个性化设置（模型服务、快捷键）→ 扫码下载 → 结尾 CTA。

## 本地预览

直接双击 `index.html` 即可；或起一个静态服务（避免跨域/路径问题）：

```powershell
cd website
npx --yes serve .        # 或 python -m http.server 8080
```

## 部署到 Cloudflare Pages

用 wrangler CLI 直传部署（不需要 package.json）：

```powershell
cd website
npx --yes wrangler@4 pages deploy . --project-name=daisy-voice
```

首次执行会打开浏览器要求登录 Cloudflare 账号并授权，之后凭据缓存在本地（`.wrangler/cache/wrangler-account.json`），再部署无需重新登录。

常用命令：

```powershell
npx --yes wrangler@4 pages project list                                # 查看已有 Pages 项目
npx --yes wrangler@4 pages deployment list --project-name=daisy-voice   # 查看部署历史
```

### 更新流程

1. 修改 `index.html` / `index.css` / `index.js` 或替换 `assets/` 资源；
2. 本地双击 `index.html` 确认样式与交互正常；
3. 执行 `npx --yes wrangler@4 pages deploy . --project-name=daisy-voice`；
4. 看到 `Deployed` 与预览链接后，访问 <https://daisy-voice.pages.dev> 强制刷新（Ctrl+F5 / Cmd+Shift+R）确认线上生效。

> 每次部署都会留下一条记录，可在 Cloudflare 控制台 → Workers & Pages → `daisy-voice` → Deployments 回滚到任一历史版本。

## 备注

- 部署目录是「当前目录的内容」，`.wrangler/` 会被自动忽略，无需手动排除；请勿将其提交进仓库。
- 若要改为 Git 自动构建：在 Cloudflare 控制台把该项目关联本仓库，Root directory 填 `website`，构建命令留空，输出目录填 `/`。
- 页面上的下载按钮与二维码指向的安装包来自 [Releases](https://github.com/SenluAi/Daisy-Voice-Agent/releases)，发新版本时记得同步更新对应链接。
