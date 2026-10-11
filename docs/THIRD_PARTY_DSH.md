# DSH Plugin Hub 署名说明

Daisy 的社区目录适配器遵循并改写了 `dshplugin/dsh-plugin-hub/src/client/logic/normalize.ts`（v1.6.2，commit `a58f4b2`）中的字段规范化逻辑，该文件以 MIT 许可分发。来源：
https://github.com/dshplugin/dsh-plugin-hub

社区目录由 https://api.dsh-plugin.org 和 https://dsh-plugin.org 提供。DSH Plugin Hub 是独立的社区项目，不是 DeepSeek 官方产品；它的社区验证并不代表 Daisy 兼容性认证。

## 接口参考

最小兼容契约是参照
https://github.com/deepseek-ai/deepseek-harness 的 commit
`d743267388641bc76f17c45ce8b4c231aed1d32c`（MIT）核对过的。Daisy 没有打包完整的 Harness 应用，也没有打包它的 agent 循环、配置管理器或账号系统。
安装器内置了 MIT 许可的官方服务包
`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-commands` 和
`@deepseek-ai/dsh-credentials`（0.2.0-rc.2），以及 Cordis 4.0.4。它们上游的 LICENSE 文件仍保留在随包依赖目录中。
单独安装的 SandBase 运行时构建自
https://github.com/sandbaseai/sandbase-harness 的 tag `v0.3.8`、commit
`dea25a2741ca2a494567aae13617f239bb542c03`；其包内保留了上游许可证。它并未嵌入 Daisy 的核心安装包。

## MIT 许可证（原文）

Copyright (c) 2026 dshplugin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
