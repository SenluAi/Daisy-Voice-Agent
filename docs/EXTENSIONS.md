# Daisy 插件、技能与 MCP

## 存储与兼容性

Daisy 2.0.7 把扩展数据保存在应用的用户数据目录下的 `extensions/` 中，不会修改 `daisy.env`，也不会修改 Codex 技能。

- `catalog.json`：社区目录，按需加载并每天刷新；离线失败时保留上一次成功拉取的目录。
- `plugins.json`、`plugins/`：已安装的软件包及其启用状态。
- `skills/`、`skills/disabled.json`：个人 `SKILL.md` 技能包与已禁用的技能。
- `mcp.json`：MCP 客户端配置。其中可能包含凭据，请勿放进源码备份或安装包中分发。
- `plugin-data/`：各插件的运行时数据。

DSH 市场使用与 `dsh-plugin@1.6.2` 相同的 `plugins.zh.json` 和 `stats.json` 接口。官方社区包以依赖形式内置；Daisy 提供的是原生 Electron 市场适配器，而不是再装一个 DeepSeek Harness 应用。目录规范化遵循 MIT 许可的 DSH Plugin Hub 契约，署名信息见 `THIRD_PARTY_DSH.md`。

**这里是标准接口的兼容宿主，而不是完整的 DeepSeek Harness。** 社区标注的 `verified` 只代表目录审核过该插件，不代表它与 Daisy 兼容。依赖不支持的私有服务或 UI 提供方的插件会显示 `requires_host` 并列出缺失项。受支持的 DSH 工具、HTTP 路由、React/侧边栏面板、队列化会话提示和受限的文件 STT 都走真实 Daisy 服务；详见 `DSH_COMPATIBILITY.md`。仅 CLI 型的目录条目无法通过此宿主安装。

## 外部插件

外部包使用 Cordis 4 插件契约：`package.json` 含 `main` 或 `exports`，带 `dsh` 或 `daisy` 元数据，并导出 `apply(ctx, config)`。必须是预构建的 JavaScript。管理器不会运行生命周期脚本，也不会构建任意下载来的源码。需要原生构建脚本的依赖必须以预构建形式提供，或通过 MCP 单独接入。

每个启用的服务端插件运行在独立的 Electron utility 进程中，使用官方 `@deepseek-ai/cordis` 上下文。缺失的服务会被如实上报，而不是伪造。桥接层暴露 `ctx.daisy`：

```js
exports.name = 'example-echo';
exports.inject = ['daisy'];
exports.apply = (ctx) => {
  ctx.daisy.registerTool({
    name: 'echo',
    description: 'Echo a message',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }, async (args) => String(args.text));
};
```

`ctx.daisy.userData` 是该插件独立的持久化数据目录。工具 ID 带命名空间，并通过 `extension_list_tools` 和 `extension_call_tool` 暴露。请求带超时并支持任务取消。插件失败不会终止 Daisy 的语音进程。

**进程隔离不是安全沙箱。** 受信任的已安装插件仍拥有用户操作系统的权限。安装是显式行为：会展示来源，并在加载代码前要求确认。Daisy 的 API Key 不会被继承到插件进程中。NPM 安装使用内置 CLI、结构化参数数组、`--ignore-scripts` 和 `--no-bin-links`。内置的 npm 12 安装器通过 `--allow-git=root` 和 `--allow-remote=root` 显式允许用户确认过的直接 Git 与远程 tarball 来源；无关的传递性 Git/远程来源仍被阻止。这些设置只作用于安装器命令，不改动用户的 npm 配置。安装器把完整依赖树放在 ASAR 之外；目录里的命令字符串绝不会直接交给 shell 执行。

## 技能

技能是一个包含带 YAML frontmatter 的 `SKILL.md` 的目录：

```markdown
---
name: meeting-summary
description: Summarize a meeting and extract action items.
---
Summarize only the supplied transcript. Do not invent attendance or decisions.
```

导入时会保留技能目录下的配套资源。符号链接、路径穿越和超大技能包会被拒绝。个人技能可以编辑、启用、禁用或删除；插件自带的技能是只读的，会随其父插件一起移除。禁用插件也会同时禁用它的技能。只有已启用技能的元数据会提供给模型，正文内容按需通过 `read_skill` 加载，不会注入到每次对话中。

## MCP

客户端使用官方 `@modelcontextprotocol/sdk`，支持 stdio、Streamable HTTP 和显式 SSE。保存时会先校验完整配置，再替换已有配置。某个服务器连接失败不会影响其他服务器或语音识别。

```json
{
  "mcpServers": {
    "local-example": {
      "command": "node",
      "args": ["C:/example/server.js"],
      "env": {},
      "disabled": true
    },
    "remote-example": {
      "url": "https://example.com/mcp",
      "transport": "http",
      "headers": {},
      "disabled": true
    }
  }
}
```

上面的地址只是示例，不是内置集成。用户需要自己提供真实的服务器和凭据。保存已启用的 stdio 条目会启动指定程序；远程条目会连接配置的服务。只有在 MCP 握手成功并拿到真实 `tools/list` 响应后，才会列出工具。

## 自动执行脚本

在用户委托的任务范围内，`run_shell_command` 与 `extension_call_tool` 共用 200 轮的任务预算，没有单独的八次调用上限：调试通常需要多条不同命令，扩展调度器也代表大量不同的插件/MCP 工具。已启用的工具无需逐次批准。安装确认、禁用插件检查、破坏性操作确认、重复命令防护、卡住重规划、取消和任务级轮数上限仍然有效。成功的 `write_file`/`create_file` 会重置命令重试计数，以便用同一条命令验证修改后的脚本；写入失败不重置计数，命令未变却反复执行仍会触发循环保护。

剩余的工具额度属于 `TOOL_CALL_LIMIT_REACHED`，不是权限失败。请用户授权无法重置额度。真实的脚本错误与系统权限失败要区分开。后台 PowerShell MCP 适配器除 SDK 的安全环境外，还继承 `PATHEXT` 和 `COMSPEC`；缺少 `PATHEXT` 时，原生 Node/Python 命令会丢失捕获输出，裸 `cmd` 也无法解析。这不会把 Daisy 凭据传给插件进程。

回归检查：`node scripts/test-script-autonomy.cjs` 会验证每个调度器连续 12 次调用、编辑—重测循环、额度分类以及保留的防护。在 Windows 上加 `--real-shell` 可用无害测试脚本跑通真实后台命令执行器和 PowerShell MCP 适配器。模型与插件调度都是本地夹具，不会发起真实模型请求或写配置。`node scripts/test-background-powershell.cjs --live-mcp` 还会在不改配置的前提下检查已配置的 PowerShell MCP 连接。

## 验证

先运行 `npm run build`，再跑 `scripts/test-extension-*.cjs` 系列检查。测试使用临时用户数据目录、本地夹具和本地 MCP 服务器，不会改动已安装应用的配置，也不会安装无关的社区包。设置界面测试会检查真实目录，并验证搜索、各标签页、技能的创建/编辑/禁用/删除以及 MCP 配置错误。`node scripts/test-extension-install.cjs` 会真实执行本地 Git 与 HTTP tarball 安装，验证脚本抑制与传递来源限制。加 `--live` 还会从真实社区目录把 `lemonhall/dsh-media-dock` 装进隔离的临时配置中。安装是否成功与插件对 Harness 宿主的兼容性分开校验。
