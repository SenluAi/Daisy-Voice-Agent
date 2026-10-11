# DSH 兼容宿主

Daisy 2.0.9 把服务端插件放在独立的 Electron utility 进程中运行，把客户端面板放在无 Node 的沙箱 BrowserWindow 中。语音、麦克风、TTS 和自动化核心仍留在原有应用内。

## 已支持的契约

- Cordis 的 `apply(ctx, config)` 以及作用域化的注册/释放。
- `tools.register({ name, description, parameters, execute, output })`：
  JSON Schema 参数与输出都会校验；`output.render` 的文本部分会回传给 Daisy 真实的 `extension_call_tool` 调度器。
- `webServer.register({ kind: 'exact' | 'prefix', path, handler })`：
  handler 在插件进程中收到真实的 Node HTTP request/response 对象。
- 官方 `window.__ModuleLoader__.load({ id, factory(require) })` 客户端包、React、ReactDOM 与浏览器端 Cordis。
- `sidebarRightTabs.register`、`slots.inject/register`，支持
  `sidebar.right.pane.tab`、`sidebar.right.pane.tab.title`、`settings.section`
  和 `settings.onboarding`。区块 props 与 locale 作用域都会保留。
- 客户端 `connection.rpc.call`、服务端 `connection.rpc.handle/admit`，以及已安装面板使用的作用域化中英 `locale` 注册/绑定。
- 官方 `@deepseek-ai/dsh-llm` 的 `LlmRuntime` 和作用域化的适配器/提供方/模型发现注册。免费模型插件的真实适配器通过 Daisy 现有工具调度器暴露 `dsh_list_models` 和 `dsh_generate_text`；Daisy 的默认模型不变。
- 官方 `@deepseek-ai/dsh-commands` 的 `CommandRuntime`，用于插件自有命令的注册/发现/释放。这不会引入第二个 Daisy agent，也不暴露仅 Harness 才有的会话内部结构。
- 官方 `@deepseek-ai/dsh-credentials` 的提供方契约：引用与记录的读写、安全元数据、更新事件和串行化的读—改—写。主进程用 Electron `safeStorage` 加密各插件的 `credentials.enc`；没有明文兜底，也无法访问 Daisy 的模型/环境凭据。版本号校验会拒绝冲突写入。卸载会清除其拥有的状态。
- `connection.fetch.register`，支持精确的缓冲式 HTTP 路由和标准的客户端请求/服务端响应 RPC 封装。路由使用与其他插件 API 相同的回环认证、Origin、请求体大小和取消检查。流式/二进制 Gateway Remote 契约未实现。
- MCP 管理器的原生 RPC 会编辑一份经过校验的补丁，并应用到真实的 Daisy MCP 管理器上。连接状态和工具数量都是实时的，不是模拟的。未编辑的服务器设置会保留；并发保存会冲突。
- `sessions.retain('daisy')`、`ready`、`binding.session.prompt(content, 'queue')`
  和 `release`。被接受的请求进入有界 FIFO 队列，然后走现有的 Daisy 对话/LLM/TTS 链路，而不是模拟的聊天回复。
- JSON 插件配置、受支持的 bundle-patch 默认值和重载回滚。
- `speechToText.snapshot/resolve/transcribe` 和 `speechController.catalog`：
  真实的 Daisy Sherpa 与已配置的火山引擎 ASR 提供方、同步的提供方/规格/上限发现、可取消的 PCM16 WAV 文件转写。
- 禁用/卸载会关闭面板、移除工具/路由、取消待处理的插件提示，并释放插件进程。Windows 上发生崩溃后，进程树关闭也会终止其派生的下载/转换程序。

侧边栏的浏览器动作会打开系统浏览器，它不是内嵌的 Harness 浏览器提供方。任意 UI 插槽、配置档管理和 Harness/会话私有内部结构未实现。缺失的能力会被明确报出，而不是用假服务替代。可选的 `ctx.inject()` 特性可以保持待定而不影响插件可用的核心；强制注入失败仍会报告缺失服务。宿主布局样式做了作用域隔离，插件自己的标题栏/导航会保持自身尺寸。

## MCP 包与托管代理

仅含 MCP 的包不会被当作 Cordis 插件或 CLI 入口导入。Daisy 把它们的 patch 当数据解析，绝不求值 `!!js`，只解析已知的包内相对入口路径以及 URL/API Key 环境默认值。MCP 支持 stdio、streamable HTTP 与 SSE、取消、超时和生命周期清理。自动重连未实现，也无法被静默开启。

`managed-agents` 0.3.8 需要单独的 SandBase 服务。因为已安装的包缺少可执行的 dist 文件，所以这里是从官方 v0.3.8 源码构建的。在用户批准的 `autoStart` 配置下，Daisy 会在回环地址上用随机端口、仅进程内使用的认证密钥和专用工作区启动该运行时。真实的 MCP 桥接暴露六个工具。禁用/卸载或退出 Daisy 都会停止其拥有的服务与桥接；密钥不会写入 MCP 配置。这不会新增另一个 Daisy agent 循环，也不会复制 Daisy 的模型凭据。被委派的模型任务需要 SandBase 自己的模型配置。

`dsh-our-free-model` 2.0.0、`dsh-media-dock` 0.1.1、
`@js2hou/dsh-mcp-manager` 0.1.5 和 `managed-agents` 0.3.8 都是在其真实安装包、隔离应用状态下测试的。免费模型的上游可用性取决于网络和地区。内置的账号通道包可以挂载，其真实账号列表 RPC 和面板可用；账号登录需要用户在各提供方自行授权。该插件单独受限的 EAC 能力仍取决于作者的支持宿主策略；Daisy 不会伪造 Harness 配置档，也不会修改该策略。这并不代表与所有社区插件都兼容。

## 认证与信任

每个插件拥有一个临时回环端口和一个 256 位令牌。API 请求需要 bearer 令牌或该插件专属的 HttpOnly/SameSite Cookie。会检查 Host、Origin、fetch-site 和请求大小；浏览器写入要求同源。`/_daisy/` 宿主端点不可被插件覆盖。静态资源只限允许的类型和包内真实路径，包含符号链接检查。客户端 CSP 会阻止加载任意远程脚本/框架。

面板没有 Daisy preload、没有 Node API、没有弹窗，也没有麦克风/摄像头权限。插件面板打开的外部登录链接走系统浏览器，仅限不带内嵌凭据的 HTTP(S) URL，且必须来自插件自身源。打开外部 URL 限制为 HTTP(S)。服务端进程环境不会继承 Daisy 的模型凭据。进程隔离不是操作系统沙箱：受信任的原生插件仍能使用用户的文件系统/网络权限。插件配置和 MCP 文件可能包含密钥，不得放入公开的源码备份。

## Media Dock

`lemonhall/dsh-media-dock` 0.1.1 已对其真实公开仓库、未改动的服务端/客户端模块和 manifest 完成核验。Daisy 提供 `tools` 和 `webServer`、真实媒体面板、本地 yt-dlp/ffmpeg 路径以及专用的 `DSH_HOME`。浏览器 Cookie 访问和作者的代理默认关闭；若某站点需要登录，用户必须自行配置。

已有字幕的以及无字幕视频中的语音，都可以通过 Daisy 的真实模型来总结。STT 复用 Daisy 的 Sherpa-ONNX Paraformer 或已配置的火山引擎 ASR，而不是 SenseVoice 或交互式微信输入法。提供方遵循本地流式偏好；转写失败不会静默切换提供方。音频必须是 16 kHz 单声道 PCM16 WAV，单段最大 4 MiB、最长 120 秒。Media Dock 读取这些上限并自行切分较长音频。一个专用的可信 worker 把文件解码、云端缓冲和连接退避与实时麦克风会话隔离开。同一时间只跑一个文件任务，带队列上限、超时、取消和 30 秒空闲进程回收。只有提供方元数据会进入插件上下文；ASR 凭据始终留在受信任的 Daisy 进程中。配置更新无需重启即可刷新提供方目录。下载取决于外部访问策略和网络可用性。下载产物在卸载时保留；插件托管状态会被移除。

## 验证

```powershell
npm run build
node scripts/test-dsh-compat.cjs
node scripts/test-plugin-queue.cjs
node scripts/test-plugin-stt.cjs
node scripts/test-extension-host.cjs
node scripts/test-extension-ui.cjs
node scripts/test-plugin-contracts.cjs
node scripts/test-plugin-credentials.cjs
node scripts/test-installed-plugin-compat.cjs
node scripts/test-installed-plugin-compat.cjs --live-model
node scripts/test-dsh-compat.cjs --media --llm
node scripts/test-dsh-compat.cjs --media --stt --llm
node scripts/test-dsh-compat.cjs --media --stt --cloud-stt --llm
```

最后一个测试会在不打印密钥、不修改持久设置的前提下显式访问 GitHub 和用户配置的模型 API。它把真实社区包安装到临时配置档，用 yt-dlp 下载一段带真实 WebVTT 字幕的本地生成视频，校验工具读取和面板渲染，然后点击真实的总结按钮并检查真实的中文模型回复。它并不声称能绕过某个特定的 YouTube/抖音登录墙。把 `DAISY_EXTENSION_BUILD_ROOT` 指向打包后的 `resources/app.asar`，就可以对发布版代码及其内置安装器重复同样的测试。
STT 变体会生成一段不带字幕轨的真实中文口播视频（含三秒停顿），检查两段话在文件转写后都还在，再去请求真实的中文总结。持久化的语音/模型设置只读不改，也不会打开实时麦克风。
云端变体会显式选择已配置的火山引擎提供方，若不可用则直接失败；它不会把本地回退当作云端成功。

后续做兼容性工作时，先检查强制与可选注入，以及真实的服务端/客户端调用。只实现被实际用到的契约，然后在临时配置档中测试未改动包的面板和真实工具/API 响应。部署前对 app.asar 再跑一遍，并比对 daisy.env 的哈希。绝不要用 ready 标记替代可用服务，也不要照抄整个 Harness。
对接账号通道类插件时，还要检查异步的可选注入：主插件可能报 ready，而它的通道包仍在待定或已失败。要核验通道包自身状态、一个已认证的管理 RPC 和真实面板；缺少 `connection.fetch.register` 与缺少 `llm` 是两回事。把上游实时可用性测试与宿主契约测试分开。
`dsh-commands` 所需的对等运行时（`dsh-attachment`、`dsh-scope`、`dsh-session`）是显式的生产依赖，打包钩子会检查它们是否存在。另外要在 Daisy 停止时运行 `test-installed-startup.cjs`：它会启动真实安装的可执行文件并检查实时就绪状态，然后正常重启它。在仓库下启动的测试 Electron 二进制会从周围的 `node_modules` 解析缺失的归档依赖，所以仅靠这个测试无法证明独立安装的宿主可用。

## 后台 Shell 与持久化插件流

在 Windows 上，经过核验的 `PowerShell.MCP.Proxy.exe` 工具被适配到 Daisy 基于文件的后台执行器。`execute_command` 和 `get_current_location` 仍然可用，而创建/控制控制台的工具不再对外宣传或转发。每个脚本相互独立（没有持久变量或 cwd）；支持字面量 var1-var8、已配置的环境/cwd，以及超时/取消。其他 MCP 服务器不变。普通脚本应使用带 `shell=powershell` 的 `run_shell_command`。两条路径都使用 `windowsHide: true`、`-WindowStyle Hidden` 和非交互执行。UTF-8 BOM/输入/输出保证中文脚本不乱码。

原生 `text/event-stream` 路由对已打开的响应保持独占。不要对它们套用一元请求的 30 秒响应期限，也不要在响应已开始后写 JSON 头。旧行为曾导致定时器里出现 `ERR_HTTP_HEADERS_SENT`，并以退出码 1 终止 `dsh-our-free-model` 的 worker。部分响应出错会关闭连接，而普通挂起请求仍返回 504。
用 `test-plugin-stream-timeout.cjs`、`test-background-powershell.cjs
--live-mcp` 和 `test-installed-startup.cjs --soak` 校验。安装版浸泡测试会让真实插件面板保持打开 35 秒；仅靠启动就绪检测不出随后的流式超时崩溃。
