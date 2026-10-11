import { useCallback, useEffect, useState } from "react";
import { AlertCircle, BadgeCheck, Check, ClipboardCopy, KeyRound, LoaderCircle, RefreshCw, LogOut, Trash2 } from "lucide-react";

type LicenseStatus = Awaited<ReturnType<Window["diriAPI"]["licenseStatus"]>>;

export default function LicensePanel() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.diriAPI.licenseStatus());
    } catch {
      setMessage({ ok: false, text: "读取本机授权状态失败" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.diriAPI.onLicenseChanged(setStatus);
    const timer = window.setInterval(() => { void refresh(); }, 60000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [refresh]);

  const handleVerify = async () => {
    setBusy(true);
    try { setStatus(await window.diriAPI.licenseRefresh()); }
    catch { setMessage({ ok: false, text: "联网核验失败，请稍后重试" }); }
    finally { setBusy(false); }
  };

  const handleActivate = async () => {
    if (!redeemCode.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.diriAPI.licenseActivate(redeemCode);
      setStatus(result.status);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) setRedeemCode("");
    } catch {
      setMessage({ ok: false, text: "激活请求失败，请稍后重试" });
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await window.diriAPI.licenseClear());
      setMessage({ ok: true, text: "已清除本机激活码（服务端兑换记录未变，重新激活需联系作者）" });
    } catch {
      setMessage({ ok: false, text: "清除失败，请稍后重试" });
    } finally {
      setBusy(false);
    }
  };

  const copyDeviceCode = async () => {
    if (!status?.deviceCode) return;
    try {
      await navigator.clipboard.writeText(status.deviceCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage({ ok: false, text: "复制失败，请手动选择设备码" });
    }
  };

  const activated = Boolean(status?.activated);
  const trial = status?.accessState === "trial";
  const statusLabel = !status ? "读取中…" : status.accessState === "activated" ? "已激活 · 完整版"
    : trial ? `试用中 · 剩余 ${Math.ceil(status.remainingTrialMs / 86400000)} 天`
    : status.accessState === "expired" ? "试用已到期 · 已锁定"
    : status.accessState === "checking" ? "正在核验" : "需要联网核验 · 已锁定";

  return (
    <div className="flex-1 overflow-y-auto glass-scroll pr-2 pb-6">
      <header className="flex items-center gap-3 mb-4">
        <div className={`p-2.5 rounded-2xl ${activated ? "bg-emerald-500/12 text-emerald-600" : "bg-slate-500/10 text-slate-500"}`}>
          {activated ? <BadgeCheck className="w-5 h-5" /> : <KeyRound className="w-5 h-5" />}
        </div>
        <div>
          <h2 className="font-display font-bold text-[19px] text-slate-800">授权激活</h2>
          <p className="text-[11px] text-slate-400 mt-0.5">
            输入购买时收到的兑换码，激活码会绑定到这台设备并保存在本机
          </p>
        </div>
      </header>

      <section className="liquid-glass rounded-[22px] p-5 mb-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-slate-500">当前状态</span>
          <span className={`text-[13px] font-bold ${activated ? "text-emerald-600" : "text-slate-500"}`}>
            {statusLabel}
          </span>
        </div>

        {status && (
          <div className="mt-3 text-[12px] text-slate-600 space-y-2">
            <p role="status">{status.accessMessage}</p>
            {status.trialStartedAt && <p>试用开始：{new Date(status.trialStartedAt).toLocaleString()}</p>}
            {status.trialExpiresAt && <p>试用截止：{new Date(status.trialExpiresAt).toLocaleString()}</p>}
            {status.allowed && status.leaseExpiresAt && <p>离线凭证截止：{new Date(status.leaseExpiresAt).toLocaleString()}</p>}
            <div className="flex items-center gap-4 pt-1">
              <button type="button" onClick={handleVerify} disabled={busy} className="flex items-center gap-1.5 text-sky-700 disabled:opacity-40">
                <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />联网核验
              </button>
              {!status.allowed && <button type="button" onClick={() => window.diriAPI.quitApp()} className="flex items-center gap-1.5 text-slate-500">
                <LogOut className="w-3.5 h-3.5" />退出 Daisy
              </button>}
            </div>
          </div>
        )}

        {activated && (
          <dl className="mt-4 grid gap-2.5 text-[12px]">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-400">许可编号</dt>
              <dd className="font-mono text-slate-700 truncate">{status?.licenseId || "-"}</dd>
            </div>
            {status?.customer ? (
              <div className="flex items-center justify-between gap-4">
                <dt className="text-slate-400">购买者</dt>
                <dd className="text-slate-700 truncate">{status.customer}</dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-400">签发时间</dt>
              <dd className="text-slate-700">{status?.issuedAt ? new Date(status.issuedAt).toLocaleString() : "-"}</dd>
            </div>
          </dl>
        )}

        {status?.problem && (
          <p className="mt-4 flex items-start gap-2 rounded-2xl bg-amber-500/10 px-3.5 py-2.5 text-[11.5px] text-amber-700">
            <AlertCircle className="w-4 h-4 mt-[1px] shrink-0" />
            <span>本机保存的激活码未通过校验：{status.problem}。请重新输入兑换码激活。</span>
          </p>
        )}

        <div className="mt-4 pt-4 border-t border-white/50">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-slate-500">本机设备码</span>
            <button
              type="button"
              onClick={copyDeviceCode}
              className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-700"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <p className="mt-2 font-mono text-[11px] text-slate-600 break-all select-all">
            {status?.deviceCode || "…"}
          </p>
          <p className="mt-2 text-[11px] text-slate-400">
            联系作者人工开通时把设备码发给他即可，无需发送激活码。
          </p>
        </div>
      </section>

      <section className="liquid-glass rounded-[22px] p-5">
        <label className="block text-[12px] font-medium text-slate-500 mb-2">兑换码</label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={redeemCode}
            onChange={(event) => setRedeemCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleActivate();
            }}
            placeholder="DAISY-RDM1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            spellCheck={false}
            className="flex-1 min-w-0 rounded-2xl bg-white/70 px-4 py-2.5 font-mono text-[12px] text-slate-700 outline-none border border-white/70 focus:border-slate-300"
          />
          <button
            type="button"
            onClick={handleActivate}
            disabled={busy || !redeemCode.trim()}
            className="flex items-center gap-2 rounded-2xl bg-slate-800 px-5 py-2.5 text-[12.5px] font-medium text-white disabled:opacity-40"
          >
            {busy ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            {busy ? "处理中" : activated ? "重新激活" : "立即激活"}
          </button>
        </div>

        {message && (
          <p
            className={`mt-3.5 flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[11.5px] ${
              message.ok ? "bg-emerald-500/10 text-emerald-700" : "bg-rose-500/10 text-rose-600"
            }`}
          >
            {message.ok ? <Check className="w-4 h-4 mt-[1px] shrink-0" /> : <AlertCircle className="w-4 h-4 mt-[1px] shrink-0" />}
            <span>{message.text}</span>
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          首次联网登记后可试用七天，到期需兑换码激活。每小时联网续验，断网只能使用有效签名凭证，最长二十四小时且不超过试用截止时间。一个兑换码绑定一台设备，授权服务仅接收设备码、兑换码或激活凭证。
        </p>

        {activated && (
          <button
            type="button"
            onClick={handleClear}
            disabled={busy}
            className="mt-4 flex items-center gap-1.5 text-[11px] font-medium text-rose-500 hover:text-rose-600 disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清除本机激活码
          </button>
        )}
      </section>
    </div>
  );
}
