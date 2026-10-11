# Daisy 一次性兑换码

`/api/license/redeem` 是 Daisy 付费版首次激活接口。用户输入购买时收到的 `DAISY-RDM1-...` 兑换码后，接口将该码原子绑定到当前 `DSY1-...` 设备码，并返回 Ed25519 激活码。2.1.6 起，客户端还必须持有 `/api/license/access` 签发的有效短期凭证才能运行。

## 当前线上状态（2026-10-11 实测）

| 项目 | 值 |
| --- | --- |
| 运行平台 | **Cloudflare Pages**，项目 `daisy-voice`（Git Provider: No，直接上传部署） |
| 生产地址 | https://daisy-voice.pages.dev/api/license/redeem |
| 函数代码 | `functions/api/license/redeem.ts` + `functions/api/license/_shared/{license,ledger,encoding}.ts` |
| 账本仓库 | `SenluAi/Daisy-license-ledger`（私有）→ `redemptions.json` |
| 兑换码 | 100 个，桌面 `Daisy-redemption-codes-20261011.json` |

Netlify 只是历史残留（`netlify/functions/*` 未部署、`daisy-voice.netlify.app` 返回 404），线上真正生效的是 Cloudflare Pages 版本。

## 安全边界

- 私钥只配置为 Cloudflare Pages 生产环境密钥 `DAISY_LICENSE_PRIVATE_KEY_PEM_B64`，绝不进入 Git、安装包或客户端。
- 兑换记录仅保存在私有仓库 `Daisy-license-ledger` 的 `redemptions.json`。
- 每次绑定用 GitHub Contents API 的 `sha` 条件更新；冲突时重新读取，因此一个兑换码只能绑定一台设备。
- 同一设备可安全重试，服务会返回同一许可载荷的新签名；另一设备会收到 409“该兑换码已绑定其他设备”。
- 不记录兑换码、设备码、最终激活码或密钥到函数日志。

## 已配置的环境变量（Cloudflare Pages → Production）

| 变量 | 说明 |
| --- | --- |
| `DAISY_LICENSE_LEDGER_REPOSITORY` | `SenluAi/Daisy-license-ledger` |
| `DAISY_LICENSE_LEDGER_GITHUB_TOKEN` | 读写该私有仓库 Contents 的令牌（当前借用本机 git 凭据里的经典令牌，待换成只含该仓库权限的细粒度令牌） |
| `DAISY_LICENSE_PRIVATE_KEY_PEM_B64` | Ed25519 私钥 PEM 的 base64（本机副本见下） |

## 密钥

本机存放位置（**不在仓库内**，勿提交、勿打包）：

- 私钥：`C:\Users\Mr Li\.daisy-license\ed25519-private.pem`
- 私钥 base64：`C:\Users\Mr Li\.daisy-license\ed25519-private.pem.b64`
- 公钥：`C:\Users\Mr Li\.daisy-license\ed25519-public.pem`
- 公钥（SPKI DER base64，供客户端内置）：
  `MCowBQYDK2VwAyEAkm4PtAnV078DXFn8n3xurmY+nL1gvFuYNC1bokdr00g=`

重新生成一对（会同时失效现有私钥配置）：

```powershell
node "C:\Users\Mr Li\AppData\Local\Temp\daisy_keygen.mjs"
```

> 注意：这一对是本次新建的。客户端必须内置**与之匹配**的公钥，否则离线验签会失败。如果客户端里已有别的公钥，请把对应的私钥 base64 换进 `DAISY_LICENSE_PRIVATE_KEY_PEM_B64`。

## 部署命令

```powershell
cd "C:\Users\Mr Li\Documents\Codex\2026-08-25\alife-https-github-com-bdffzi-alife\Daisy-Voice-Agent"
node "$env:LOCALAPPDATA\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js" pages deploy website --project-name=daisy-voice --branch=main --commit-dirty=true
```

更新密钥：

```powershell
Get-Content -Raw "C:\Users\Mr Li\.daisy-license\ed25519-private.pem.b64" | node "$env:LOCALAPPDATA\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js" pages secret put DAISY_LICENSE_PRIVATE_KEY_PEM_B64 --project-name=daisy-voice
```

## 验证记录（2026-10-11）

临时测试码端到端跑通并已从账本清理，100 个待售码未受影响：

- 未登记但格式合法的码 → HTTP 400（账本读取正常，判定“兑换码无效”）
- 首次兑换 → HTTP 200，返回 442 字符激活码，公钥离线验签 **通过**，载荷设备码与请求一致
- 同一设备重试 → HTTP 200，返回同一许可的新签名
- 换另一台设备 → HTTP 409“该兑换码已绑定其他设备”
- 清理后账本恢复 100 条

## 批量生成

在作者电脑上运行（令牌只应拥有 `Daisy-license-ledger` 私有仓库的 Contents 读写权限）：

```bash
DAISY_LICENSE_LEDGER_REPOSITORY="SenluAi/Daisy-license-ledger" DAISY_LICENSE_LEDGER_GITHUB_TOKEN="..." node scripts/generate-redemption-codes.mjs --count 100 --output ~/Desktop/Daisy-redemption-codes.json
```

生成的文件含明文兑换码，仅用于逐个发给购买用户；它被 `.gitignore` 排除，发送完应移动到受保护位置。2.1.6 不再提供无限期完全离线放行；手工签发的激活码也需在服务端登记匹配的 redeemed 记录。

## 验证记录（2026-10-11 第二批，含真机端到端）

- 输入格式错误（乱输中文、字母越界、空串、非字符串、设备码格式错误）→ 统一 HTTP 400「兑换码或设备码格式不正确」（修复前会误报 503）
- 用桌面批次里第 1 个真实兑换码在本机设备码上兑换 → HTTP 200，公钥离线验签通过、绑定本机、edition=full
- 同机重复兑换 → HTTP 200，返回同一 licenseId（幂等）；换设备 → HTTP 409
- 账本同步记录为 redeemed 并写入本机设备码；测试后已复位，100 条全部 available

## 还没做完的两件事

1. ~~**客户端兑换入口**~~（已完成）：客户端已加入 `src/main/license/{device,verify,index}.ts` 与设置页授权面板，内置公钥 `MCowBQYDK2VwAyEAkm4Pt...`，并已打进 `releases/Daisy-Setup-2.1.5-x64.exe`（2026-10-11 20:51 本机打包，npmRebuild=false 使用 uiohook-napi 自带预编译）。原描述：本仓库 `src/` 里目前没有任何 `DSY1` / `activationCode` / 兑换码相关代码，即客户端还不能输入兑换码、也无法离线验签激活码。需要加“输入兑换码 → 请求接口 → 保存并验签激活码”的界面与校验逻辑。
2. **令牌收敛**：把 `DAISY_LICENSE_LEDGER_GITHUB_TOKEN` 换成只对 `Daisy-license-ledger` 有 Contents 读写权限的细粒度令牌。

## 2.1.6 七天试用与短期凭证

- 首次联网按服务器 UTC 时间登记试用。私有账本 `trials/<设备码SHA256>.json` 保存起始时间；重装或删缓存不会重置同一设备的试用。
- 七天后 HTTP 403 `TRIAL_EXPIRED`。客户端立即中止任务、ASR、TTS、快捷键、唤醒词和插件/MCP，只保留授权激活界面及退出。
- 每小时续验，Ed25519/EdDSA JWT 最长有效二十四小时，试用 JWT 不得超过七天截止。首次无凭证或离线凭证到期时必须联网。
- JWT 严格校验固定算法、公钥、签发者、应用、设备、请求随机 nonce 和时限。签名私钥仍只保留在服务端，不进入客户端。
- 本机凭证缓存由 Electron safeStorage 加密（Windows DPAPI），运行时用单调时间计时；重启检测明显回拨时要求联网。
- 完整许可续验必须匹配账本中的 licenseId、设备和 issuedAt。将兑换记录 state 改为 revoked 会在下次联网核验时拒绝；已签发的离线凭证最晚二十四小时失效，并非即时远程撤销。
- 网络暂时故障仅允许剩余有效离线凭证，不延长试用；签名失败或明确拒绝会清除缓存。激活与旧请求并发时，旧响应不覆盖新状态。
- 到期取消尚在执行的 Daisy 后台命令并关闭插件服务，但不回滚已经落地的动作，也不关闭用户的外部应用。

### 安全边界与运维

Electron 客户端运行在用户控制的电脑上，不能保证绝对不可破解。伪造本机代码、复制/模拟硬件身份、管理员读取同用户 DPAPI 数据均不属于可信客户端能彻底阻止的范围。七天试用与离线额度由服务端签名加强，但不是硬件 DRM。

现有账本令牌的权限收敛仍需作者在 GitHub 创建细粒度令牌后替换。不要把私钥或账本令牌放在源码、安装包、发布附件或日志里。试用到期不会注销兑换码；同设备可重试兑换。服务端只保存必要设备哈希、试用时间及授权绑定记录。

### 本轮验证

```powershell
node --test scripts/test-license-trial.cjs
node scripts/test-license-runtime.cjs
node --test scripts/test-wechat-foreground.cjs
```

14 项授权测试覆盖真实临时 Ed25519 签名、篡改、设备/nonce/算法绑定、24h/7d 边界、时钟回拨、损坏缓存、撤销、激活并发、首次登记 CAS 和入口守卫。完整 Electron 测试使用临时 userData 和模拟语音/LLM/插件，验证真实主进程锁定、UI 仅留授权入口、运行中的 PowerShell 被取消及激活恢复，不录制麦克风或消耗兑换码。

Cloudflare 生产 `/api/license/access` 已实测两次 HTTP 200，验签通过，试用均七天、凭证二十四小时且重复登记起始时间不变。旧兑换接口错误输入仍返回 HTTP 400。微信前台隔离测试、Space 长按、唤醒词、插件队列、后台 PowerShell、任务轮数和自动化效率回归通过。
