# Daisy 视觉代理框架移植指南

本包包含 Daisy 使用的视觉代理自动化循环。它由可复用的核心加完整的 Daisy 宿主集成组成。

## 执行循环

每个任务都遵循这样的状态流转：

1. 观察当前屏幕。
2. 让模型给出一个动作。
3. 依据最新观察校验该动作。
4. 本回合内最多执行一个会改变状态的动作。
5. 等待界面稳定，并截取一张核验截图。
6. 度量视觉变化，并把结果反馈给模型。
7. 继续、软重启、请求用户输入，或结束。

终止结果只有三种：`completed`、`needs_user` 和 `difficult`。

## 包结构

- `framework-core/automation`：任务状态、动作预留、视觉核验、稳定等待、循环检测和结构化错误。
- `framework-core/vision`：Electron 屏幕截图与图像上下文辅助。
- `framework-core/orchestration`：模型/工具循环、工具 schema、系统规则、输出修复、附件完成守卫和对话处理。
- `framework-core/execution`：桌面动作分发与平台适配器。
- `framework-core/host`：Daisy 的事件接线，用于 UI 状态、进度播报和任务结果。
- `daisy-reference/src/main`：完整可用的 Daisy 主进程源码，用来解析 import 和研究生产集成。
- `project-config`：源项目的 TypeScript/npm 配置与许可证。

## 核心契约

### 观察适配器

目标项目必须提供一个返回如下结构的截图函数：

```ts
interface ScreenCaptureResult {
  dataUrl: string;
  width: number;
  height: number;
  path?: string;
}
```

Daisy 的适配器实现在 `framework-core/vision/screenCapture.ts`。它会在截图前隐藏 Daisy 的浮层窗口，让模型观察到目标应用而不是助手 UI。

### 动作适配器

通过一个统一的分发器暴露工具，形状如下：

```ts
executeTool(name: string, argsJson: string): Promise<string>
```

改变状态的工具必须在 `VisualTaskRuntime` 中登记。坐标类工具必须带上截图尺寸，并且在屏幕自观察以来发生变化时被拒绝。

### 模型适配器

参考实现使用兼容 OpenAI 的带函数工具的流式聊天 API。替换模型时必须保留 assistant 的 tool calls、tool_call ID、工具结果，以及每回合一个动作的规则。

## 移植步骤

1. 把 `framework-core/automation` 复制进目标项目。
2. 把对 Daisy logger 的引用替换为目标项目的 logger 或空实现。
3. 为目标桌面框架实现观察适配器。
4. 为目标操作系统实现或映射动作分发器。
5. 在模型工具 schema 中注册相同的工具名。
6. 用 `beforeAction` 和 `verifyAction` 包住每一个会改变状态的工具。
7. 每次显式截图工具返回后调用 `recordObservation`。
8. 遇到 `soft_restart` 时丢弃失败的动作路径，但保留原始用户目标和当前截图。
9. 每完成三个动作就转发一次 `task_progress`。
10. 只有在可见的成功条件被核验后，才接受完成。

## 必须遵守的不变量

- 没有当前截图时绝不执行坐标动作。
- 同一个模型回合绝不执行两个会改变状态的动作。
- 屏幕变化后绝不复用坐标。
- 绝不把中间动作当作任务完成。
- 文件附件复制只是暂存；必须再粘贴、确认并核验。
- 模型格式错误以 `ErrorEnvelope` 纠正提示返回。
- 精确动作、同区域、无进展和来回往复的循环，触发一次软重启；仍不改善才进入 `difficult`。
- 风险操作必须始终处于宿主项目的确认策略之后。

## 运行时依赖

参考代码需要 Node.js、TypeScript 和 Electron。屏幕采样使用 Electron 的 `nativeImage`；屏幕截图使用 `desktopCapturer` 和 `screen`。Windows 动作适配器调用 PowerShell 和 Win32 输入 API。macOS 适配器使用 macOS 原生自动化设施。

迁移到 Tauri、.NET、Python 或其他宿主时，保持状态机和停滞策略不变，只替换截图解码、窗口排除和动作执行适配器。

## 核验清单

- 用严格的 TypeScript 检查构建目标项目。
- 测试无变化屏幕、持续变化屏幕和缓慢稳定下来的屏幕。
- 测试过期坐标和截图尺寸不匹配的情况。
- 测试重复点击、同区域点击和 A-B-A-B 动作循环。
- 测试模型输出修复：空调用、未知工具和格式错误的调用。
- 测试三种终止结果。
- 测试附件任务不能在复制到剪贴板后立刻结束。
- 在启用破坏性动作之前，先跑一个无害的端到端任务。

代码按 `project-config/LICENSE` 中的许可证提供。
