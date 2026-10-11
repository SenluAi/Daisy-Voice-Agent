import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  Sparkles,
  Mic,
  Globe,
  Volume2,
  TrendingDown,
  BarChart3,
  Music2,
  TrendingUp,
  AudioLines,
  Zap,
  Keyboard,
  Settings,
  RefreshCw,
  Download,
  Check,
  AlertCircle,
  X,
  Power,
  History,
  ExternalLink,
  Send,
  ListTodo,
  FileText,
  SquareTerminal,
  Brain,
  Trash2,
  Search,
  Puzzle,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IdleOrb } from "./components/IdleOrb";
import ExtensionsPanel from "./ExtensionsPanel";
import LicensePanel from "./LicensePanel";
import { KeyRound as LicenseIcon } from "lucide-react";

interface SettingsState {
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  VOLCENGINE_API_KEY: string;
  VOLCENGINE_APP_ID: string;
  VOLCENGINE_ACCESS_TOKEN: string;
  VOLCENGINE_RESOURCE_ID: string;
  ASR_PRIMARY_PROVIDER: "wechat" | "sherpa" | "volcengine";
  ASR_LOCAL_SHERPA_FIRST: boolean;
  FIRECRAWL_API_KEY: string;
  EDGE_TTS_VOICE: string;
  EDGE_TTS_RATE: number;
  EDGE_TTS_PITCH: number;
  EDGE_TTS_STYLE: string;
  WAKE_WORD_ENABLED: boolean;
  MICROPHONE_SENSITIVITY: number;
  WECHAT_SPEECH_RMS_THRESHOLD: number;
  WAKE_START_LISTENING_TIMEOUT_MS: number;
  SHERPA_ONNX_MODEL: string;
  SHERPA_ONNX_NUM_THREADS: number;
  SHERPA_ONNX_BLOCK_SIZE: number;
  GLOBAL_SHORTCUT_DISPLAY: string;
  AUTO_LAUNCH: boolean;
  SHOW_DOCK_ICON: boolean;
}

interface ChatEntry {
  sender: "user" | "daisy";
  text: string;
  timestamp: number;
}

const isWindows = navigator.userAgent.includes("Windows");
const DEFAULT_GLOBAL_SHORTCUT = isWindows ? "Space" : "RightOption";

const MODEL_CONFIG_TABS = [
  { id: "llm", label: "推理模型", icon: Sparkles },
  { id: "search", label: "联网搜索", icon: Globe },
  { id: "asr", label: "语音识别", icon: Mic },
  { id: "wake", label: "语音唤醒", icon: Zap },
] as const;

const DEFAULT_SETTINGS: SettingsState = {
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-flash",
  VOLCENGINE_API_KEY: "",
  VOLCENGINE_APP_ID: "",
  VOLCENGINE_ACCESS_TOKEN: "",
  VOLCENGINE_RESOURCE_ID: "volc.seedasr.sauc.duration",
  ASR_PRIMARY_PROVIDER: isWindows ? "wechat" : "sherpa",
  ASR_LOCAL_SHERPA_FIRST: true,
  FIRECRAWL_API_KEY: "",
  EDGE_TTS_VOICE: "zh-CN-XiaoxiaoNeural",
  EDGE_TTS_RATE: 20,
  EDGE_TTS_PITCH: 0,
  EDGE_TTS_STYLE: "general",
  WAKE_WORD_ENABLED: true,
  MICROPHONE_SENSITIVITY: 35,
  WECHAT_SPEECH_RMS_THRESHOLD: 260,
  WAKE_START_LISTENING_TIMEOUT_MS: 90000,
  SHERPA_ONNX_MODEL: "sherpa-onnx-streaming-paraformer-bilingual-zh-en",
  SHERPA_ONNX_NUM_THREADS: 4,
  SHERPA_ONNX_BLOCK_SIZE: 160,
  GLOBAL_SHORTCUT_DISPLAY: DEFAULT_GLOBAL_SHORTCUT,
  AUTO_LAUNCH: false,
  SHOW_DOCK_ICON: true,
};

function rateToStr(n: number): string {
  return (n >= 0 ? "+" : "") + n + "%";
}
function rateFromStr(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 20 : Math.max(-50, Math.min(50, n));
}

interface TaskActivitySnapshot {
  updatedAt: number;
  tasks: Array<{
    request: string;
    status: "pending" | "completed" | "blocked";
    result?: string;
    updatedAt: number;
  }>;
  files: string[];
  applications: string[];
  pages: string[];
  preferences: string[];
  logs: string[];
}

const EMPTY_TASK_ACTIVITY: TaskActivitySnapshot = {
  updatedAt: 0,
  tasks: [],
  files: [],
  applications: [],
  pages: [],
  preferences: [],
  logs: [],
};

type MemoryCategory = "profile" | "preference" | "task";
type TaskActivityView = "recent" | "pending" | "logs";

interface LongTermMemorySnapshot {
  retentionDays: 30;
  entries: Array<{
    id: string;
    category: MemoryCategory;
    text: string;
    status: "active";
    createdAt: number;
    updatedAt: number;
  }>;
  counts: Record<MemoryCategory, number>;
}

const EMPTY_LONG_TERM_MEMORY: LongTermMemorySnapshot = {
  retentionDays: 30,
  entries: [],
  counts: { profile: 0, preference: 0, task: 0 },
};

function pitchToStr(n: number): string {
  return (n >= 0 ? "+" : "") + n + "Hz";
}
function pitchFromStr(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : Math.max(-50, Math.min(50, n));
}

const pitchPresets = [
  { value: -50, label: "低音", Icon: TrendingDown },
  { value: -25, label: "偏低", Icon: BarChart3 },
  { value: 0, label: "标准", Icon: Music2 },
  { value: 25, label: "偏高", Icon: TrendingUp },
  { value: 50, label: "高音", Icon: AudioLines },
];

const ttsStyleOptions = [
  { value: "general", label: "通用风格", icon: "🎭" },
  { value: "assistant", label: "智能助手", icon: "🤖" },
  { value: "chat", label: "聊天对话", icon: "💬" },
  { value: "customerservice", label: "客服专业", icon: "📞" },
  { value: "newscast", label: "新闻播报", icon: "📺" },
  { value: "affectionate", label: "亲切温暖", icon: "💞" },
  { value: "calm", label: "平静舒缓", icon: "😌" },
  { value: "cheerful", label: "愉快欢乐", icon: "😊" },
  { value: "gentle", label: "温和柔美", icon: "🌸" },
  { value: "lyrical", label: "抒情诗意", icon: "🎼" },
  { value: "serious", label: "严肃正式", icon: "🎯" },
];

function ChatHistoryDialog({
  chatHistory,
  onClear,
  onClose,
  draggableHeader = false,
}: {
  chatHistory: ChatEntry[];
  onClear: () => void;
  onClose: () => void;
  draggableHeader?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chatHistory.length]);

  const submitDraft = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    window.diriAPI.sendText(text);
    setDraft("");
  };

  return (
    <motion.div
      initial={{ scale: 0.92, opacity: 0, y: 15 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.92, opacity: 0, y: 15 }}
      transition={{ type: "spring", stiffness: 350, damping: 28, mass: 0.8 }}
      className="history-space-panel w-[520px] max-h-[620px] p-6 rounded-[30px] flex flex-col">
      <div className={`history-space-header flex items-center justify-between pb-4 mb-4 ${draggableHeader ? "history-dialog-header" : ""}`}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-sky-400 to-emerald-400 flex items-center justify-center shadow-md">
            <History className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="history-space-title font-semibold text-sm">Daisy · 对话历史</h3>
            <p className="history-space-subtitle text-[10px] font-medium">最近 20 次交互记录</p>
          </div>
        </div>
        <div className="flex items-center gap-2 history-dialog-action">
          {chatHistory.length > 0 && (
            <button onClick={onClear}
              className="history-clear-button text-[11px] px-2 py-1 rounded-lg transition-all font-medium cursor-pointer mr-1">
              清空历史
            </button>
          )}
          <button onClick={onClose}
            className="history-close-button w-7 h-7 rounded-full flex items-center justify-center transition-colors cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="history-space-copyable flex-1 overflow-y-auto mb-4 space-y-3.5 pr-1 glass-scroll min-h-[220px] max-h-[420px]">
        {chatHistory.length === 0 ? (
          <div className="history-space-empty flex flex-col items-center justify-center h-full text-center py-12">
            <History className="w-8 h-8 mb-3 opacity-30" />
            <p className="text-[13px] font-medium">暂无对话历史</p>
            <p className="text-[11px] mt-1">通过快捷键或唤醒词与 Daisy 对话后，记录会显示在这里</p>
          </div>
        ) : (
          chatHistory.map((chat, idx) => (
            <div key={idx} className={`flex flex-col ${chat.sender === "user" ? "items-end" : "items-start"}`}>
              <div className={`history-copy-text px-4 py-2.5 rounded-2xl text-[12px] leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                chat.sender === "user"
                  ? "history-space-message-user rounded-tr-none font-medium"
                  : "history-space-message-daisy rounded-tl-none"}`}>
                {chat.text}
              </div>
            </div>
          ))
        )}
      </div>
      <form onSubmit={submitDraft} className="history-dialog-action history-input-shell flex items-center gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入文字，按回车发送"
          className="history-chat-input"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="history-send-button"
          title="发送"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </motion.div>
  );
}

export default function App() {
  const isHistoryOnlyWindow = new URLSearchParams(window.location.search).get("mode") === "history";
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [configLoaded, setConfigLoaded] = useState(false);

  const [activeSection, setActiveSection] = useState<string>("llm");
  const [licenseAccess, setLicenseAccess] = useState<Awaited<ReturnType<Window["diriAPI"]["licenseStatus"]>> | null>(null);
  const licenseAllowed = licenseAccess?.allowed === true;
  const [sherpaInstalled, setSherpaInstalled] = useState<boolean>(false);
  const [wechatInstalled, setWechatInstalled] = useState<boolean>(false);
  const [sherpaModelStatus, setSherpaModelStatus] = useState<
    "not_downloaded" | "downloading" | "downloaded"
  >("not_downloaded");
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [shortcutCaptureTarget, setShortcutCaptureTarget] = useState<"wake" | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: "success" | "error" | "info" | "";
  }>({ text: "", type: "" });

  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [isQuitConfirmOpen, setIsQuitConfirmOpen] = useState<boolean>(false);
  const [taskActivity, setTaskActivity] = useState<TaskActivitySnapshot>(EMPTY_TASK_ACTIVITY);
  const [taskActivityLoading, setTaskActivityLoading] = useState(false);
  const [taskActivityView, setTaskActivityView] = useState<TaskActivityView>("recent");
  const [longTermMemory, setLongTermMemory] = useState<LongTermMemorySnapshot>(EMPTY_LONG_TERM_MEMORY);
  const [memoryCategory, setMemoryCategory] = useState<"all" | MemoryCategory>("all");
  const [memorySearch, setMemorySearch] = useState("");
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<Set<string>>(new Set());
  const [longTermMemoryLoading, setLongTermMemoryLoading] = useState(false);

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "downloading" | "ready" | "upToDate" | "error">("idle");
  const [updateMessage, setUpdateMessage] = useState<string>("");
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number>(0);

  const isLLMActive = licenseAllowed && settings.DEEPSEEK_API_KEY.trim().length > 5;
  const isSherpaActive = licenseAllowed && sherpaInstalled && sherpaModelStatus === "downloaded";
  const isAsrActive = licenseAllowed && (settings.ASR_LOCAL_SHERPA_FIRST
    ? (settings.ASR_PRIMARY_PROVIDER === "wechat" ? wechatInstalled : isSherpaActive)
    : settings.VOLCENGINE_API_KEY.trim().length > 5);
  const isFirecrawlActive = licenseAllowed && settings.FIRECRAWL_API_KEY.trim().length > 0;

  const statusTimerRef = useRef<number | null>(null);
  const showTemporaryStatus = (text: string, type: "success" | "error" | "info") => {
    setStatusMessage({ text, type });
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage({ text: "", type: "" });
    }, 4000);
  };

  useEffect(() => window.diriAPI.onSettingsNavigate((section) => {
    setActiveSection(licenseAllowed ? section : "license");
  }), [licenseAllowed]);

  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    const apply = (status: NonNullable<typeof licenseAccess>) => {
      if (disposed) return;
      setLicenseAccess(status);
      if (!status.allowed) {
        setActiveSection("license");
        setIsHistoryOpen(false);
      }
    };
    const unsubscribe = window.diriAPI.onLicenseChanged(status => { receivedEvent = true; apply(status); });
    void window.diriAPI.licenseStatus().then(status => { if (!receivedEvent) apply(status); });
    return () => { disposed = true; unsubscribe(); };
  }, []);

  // ==================== 加载配置 ====================
  useEffect(() => {
    (async () => {
      try {
        if (!window.diriAPI) {
          /*
          showTemporaryStatus("Preload 未加载，请联系开发者", "error");
          */
          return;
        }
        const cfg = await window.diriAPI.getConfig();
        const merged: SettingsState = { ...DEFAULT_SETTINGS };
        if (cfg.DEEPSEEK_API_KEY !== undefined) merged.DEEPSEEK_API_KEY = cfg.DEEPSEEK_API_KEY;
        if (cfg.DEEPSEEK_BASE_URL !== undefined) merged.DEEPSEEK_BASE_URL = cfg.DEEPSEEK_BASE_URL;
        if (cfg.DEEPSEEK_MODEL !== undefined) merged.DEEPSEEK_MODEL = cfg.DEEPSEEK_MODEL;
        if (cfg.VOLCENGINE_API_KEY !== undefined) merged.VOLCENGINE_API_KEY = cfg.VOLCENGINE_API_KEY;
        if (cfg.VOLCENGINE_APP_ID !== undefined) merged.VOLCENGINE_APP_ID = cfg.VOLCENGINE_APP_ID;
        if (cfg.VOLCENGINE_ACCESS_TOKEN !== undefined) merged.VOLCENGINE_ACCESS_TOKEN = cfg.VOLCENGINE_ACCESS_TOKEN;
        if (cfg.VOLCENGINE_RESOURCE_ID !== undefined) merged.VOLCENGINE_RESOURCE_ID = cfg.VOLCENGINE_RESOURCE_ID;
        if (["wechat", "sherpa", "volcengine"].includes(cfg.ASR_PRIMARY_PROVIDER)) {
          merged.ASR_PRIMARY_PROVIDER = cfg.ASR_PRIMARY_PROVIDER as SettingsState["ASR_PRIMARY_PROVIDER"];
        }
        if (cfg.ASR_LOCAL_SHERPA_FIRST !== undefined) merged.ASR_LOCAL_SHERPA_FIRST = cfg.ASR_LOCAL_SHERPA_FIRST !== "false";
        if (cfg.FIRECRAWL_API_KEY !== undefined) merged.FIRECRAWL_API_KEY = cfg.FIRECRAWL_API_KEY;
        if (cfg.EDGE_TTS_VOICE !== undefined) merged.EDGE_TTS_VOICE = cfg.EDGE_TTS_VOICE;
        if (cfg.EDGE_TTS_RATE !== undefined) merged.EDGE_TTS_RATE = rateFromStr(cfg.EDGE_TTS_RATE);
        if (cfg.EDGE_TTS_PITCH !== undefined) merged.EDGE_TTS_PITCH = pitchFromStr(cfg.EDGE_TTS_PITCH);
        if (cfg.EDGE_TTS_STYLE !== undefined) merged.EDGE_TTS_STYLE = cfg.EDGE_TTS_STYLE || "general";
        if (cfg.WAKE_WORD_ENABLED !== undefined) merged.WAKE_WORD_ENABLED = cfg.WAKE_WORD_ENABLED === "true";
        if (cfg.MICROPHONE_SENSITIVITY !== undefined) {
          const sensitivity = parseInt(cfg.MICROPHONE_SENSITIVITY, 10);
          if (!isNaN(sensitivity) && sensitivity > 0) {
            merged.MICROPHONE_SENSITIVITY = Math.min(100, Math.max(1, sensitivity));
          }
        }
        if (cfg.WECHAT_SPEECH_RMS_THRESHOLD !== undefined) {
          const threshold = parseInt(cfg.WECHAT_SPEECH_RMS_THRESHOLD, 10);
          if (!isNaN(threshold) && threshold > 0) {
            merged.WECHAT_SPEECH_RMS_THRESHOLD = Math.min(2000, Math.max(50, threshold));
          }
        }
        if (cfg.WAKE_START_LISTENING_TIMEOUT_MS !== undefined) {
          const timeoutMs = parseInt(cfg.WAKE_START_LISTENING_TIMEOUT_MS, 10);
          if (!isNaN(timeoutMs) && timeoutMs > 0) merged.WAKE_START_LISTENING_TIMEOUT_MS = timeoutMs;
        }
        if (cfg.SHERPA_ONNX_MODEL !== undefined) merged.SHERPA_ONNX_MODEL = cfg.SHERPA_ONNX_MODEL;
        if (cfg.SHERPA_ONNX_NUM_THREADS !== undefined) {
          const numThreads = parseInt(cfg.SHERPA_ONNX_NUM_THREADS, 10);
          if (!isNaN(numThreads) && numThreads > 0) merged.SHERPA_ONNX_NUM_THREADS = Math.min(32, Math.max(1, numThreads));
        }
        if (cfg.SHERPA_ONNX_BLOCK_SIZE !== undefined) {
          const blockSize = parseInt(cfg.SHERPA_ONNX_BLOCK_SIZE, 10);
          if (!isNaN(blockSize) && blockSize >= 160) merged.SHERPA_ONNX_BLOCK_SIZE = blockSize;
        }
        if (cfg.GLOBAL_SHORTCUT !== undefined) merged.GLOBAL_SHORTCUT_DISPLAY = cfg.GLOBAL_SHORTCUT || DEFAULT_GLOBAL_SHORTCUT;
        if (cfg.AUTO_LAUNCH !== undefined) merged.AUTO_LAUNCH = cfg.AUTO_LAUNCH === "true";
        if (cfg.SHOW_DOCK_ICON !== undefined) merged.SHOW_DOCK_ICON = cfg.SHOW_DOCK_ICON !== "false";
        try {
          merged.AUTO_LAUNCH = await window.diriAPI.getAutoLaunch();
        } catch {}
        setSettings(merged);
        setConfigLoaded(true);
        await refreshSherpaStatus();
      } catch (err: any) {
        /*
        showTemporaryStatus("加载配置失败：" + (err?.message || err), "error");
        */
      }
    })();
  }, []);

  const refreshSherpaStatus = async () => {
    try {
      const status = await window.diriAPI.getSherpaStatus();
      setSherpaInstalled(status.installed);
      setWechatInstalled(status.wechatInstalled);
      setSherpaModelStatus(status.modelReady ? "downloaded" : "not_downloaded");
    } catch {
      setSherpaInstalled(false);
      setWechatInstalled(false);
      setSherpaModelStatus("not_downloaded");
    }
  };

  // ==================== 应用版本 + 下载进度 ====================
  useEffect(() => {
    (async () => {
      try {
        const v = await window.diriAPI.getAppVersion();
        setCurrentVersion(v);
      } catch { /* ignore */ }
    })();
    const off = window.diriAPI.onUpdateDownloadProgress((p) => {
      setUpdateDownloadPercent(p.percent);
      if (p.percent >= 100) {
        setUpdateStatus("ready");
        showTemporaryStatus("✓ 新版本已下载完成，点击重启安装", "success");
      }
    });
    return () => off();
  }, []);

  const handleInputChange = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // ==================== 快捷键捕获 ====================
  useEffect(() => {
    if (!shortcutCaptureTarget) return;
    const target = shortcutCaptureTarget;
    const off = window.diriAPI.onShortcutCaptured((payload) => {
      if (payload.cancelled) {
        setShortcutCaptureTarget(null);
        showTemporaryStatus("已取消快捷键设置", "info");
        return;
      }
      if (payload.keyName) {
        handleInputChange("GLOBAL_SHORTCUT_DISPLAY", payload.keyName);
        setShortcutCaptureTarget(null);
        showTemporaryStatus(`快捷键已设置为：${payload.keyName}（保存后生效）`, "success");
      }
    });
    window.diriAPI.captureShortcut("single");
    return () => off();
  }, [shortcutCaptureTarget]);

  // The native listener owns global shortcuts.  Capture inside this focused
  // settings window as a fallback too, so a temporarily unavailable native
  // listener (for example, while Windows is scanning its helper process) does
  // not make the “设置快捷键” buttons appear broken.
  useEffect(() => {
    if (!shortcutCaptureTarget) return;

    const pressed = new Set<string>();
    const order: string[] = [];
    const labelFor = (event: KeyboardEvent): string => {
      const labels: Record<string, string> = {
        AltLeft: "LeftAlt", AltRight: "RightAlt",
        ControlLeft: "LeftControl", ControlRight: "RightControl",
        ShiftLeft: "LeftShift", ShiftRight: "RightShift",
        MetaLeft: "LeftWin", MetaRight: "RightWin",
        Space: "Space", Enter: "Return", Escape: "Escape",
        Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
      };
      return labels[event.code] || event.key;
    };
    const apply = (keyName: string) => {
      handleInputChange("GLOBAL_SHORTCUT_DISPLAY", keyName);
      window.diriAPI.cancelShortcutCapture();
      setShortcutCaptureTarget(null);
      showTemporaryStatus(`快捷键已设置为：${keyName}（保存后生效）`, "success");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = labelFor(event);
      if (shortcutCaptureTarget === "wake") {
        apply(key);
        return;
      }
      if (!pressed.has(key)) {
        pressed.add(key);
        order.push(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pressed.delete(labelFor(event));
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [shortcutCaptureTarget]);

  // ==================== Sherpa-ONNX 下载进度 ====================
  useEffect(() => {
    const off = window.diriAPI.onSherpaDownloadProgress((p) => {
      setDownloadProgress(p.percent);
      if (p.percent >= 100) {
        if (p.status === "下载完成" || p.status === "已存在") {
          setSherpaModelStatus("downloaded");
          showTemporaryStatus("✓ Sherpa-ONNX 模型下载完成", "success");
        } else if (p.status.startsWith("下载失败")) {
          setSherpaModelStatus("not_downloaded");
          showTemporaryStatus(p.status, "error");
        }
        setTimeout(() => refreshSherpaStatus(), 500);
      }
    });
    return () => off();
  }, []);

  useEffect(() => {
    if (activeSection !== "tasks") return;
    let active = true;
    const refresh = async (showLoading = false) => {
      if (showLoading) setTaskActivityLoading(true);
      try {
        const snapshot = await window.diriAPI.getTaskActivity();
        if (active) setTaskActivity(snapshot);
      } catch {
        if (active) showTemporaryStatus("读取任务动态失败", "error");
      } finally {
        if (active && showLoading) setTaskActivityLoading(false);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeSection]);

  useEffect(() => {
    if (activeSection !== "memory") return;
    let active = true;
    const refresh = async (showLoading = false) => {
      if (showLoading) setLongTermMemoryLoading(true);
      try {
        const snapshot = await window.diriAPI.getLongTermMemory();
        if (!active) return;
        setLongTermMemory(snapshot);
        setSelectedMemoryIds((previous) => new Set([...previous].filter((id) => snapshot.entries.some((entry) => entry.id === id))));
      } catch {
        if (active) showTemporaryStatus("读取长期记忆失败", "error");
      } finally {
        if (active && showLoading) setLongTermMemoryLoading(false);
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeSection]);

  const deleteMemoryEntries = async (ids: string[]) => {
    if (ids.length === 0) return;
    const deleted = await window.diriAPI.deleteLongTermMemories(ids);
    const snapshot = await window.diriAPI.getLongTermMemory();
    setLongTermMemory(snapshot);
    setSelectedMemoryIds(new Set());
    showTemporaryStatus(`已删除 ${deleted} 条长期记忆`, "success");
  };

  // ==================== 保存设置 ====================
  const handleSaveSettings = async () => {
    if (!configLoaded) {
      showTemporaryStatus("配置正在加载，请稍候…", "error");
      return;
    }
    const payload: Record<string, string> = {
      DEEPSEEK_API_KEY: settings.DEEPSEEK_API_KEY.trim(),
      DEEPSEEK_BASE_URL: settings.DEEPSEEK_BASE_URL.trim(),
      DEEPSEEK_MODEL: settings.DEEPSEEK_MODEL.trim(),
      VOLCENGINE_API_KEY: settings.VOLCENGINE_API_KEY.trim(),
      ASR_PRIMARY_PROVIDER: settings.ASR_PRIMARY_PROVIDER,
      ASR_LOCAL_SHERPA_FIRST: String(settings.ASR_LOCAL_SHERPA_FIRST),
      FIRECRAWL_API_KEY: settings.FIRECRAWL_API_KEY.trim(),
      EDGE_TTS_VOICE: settings.EDGE_TTS_VOICE,
      EDGE_TTS_RATE: rateToStr(settings.EDGE_TTS_RATE),
      EDGE_TTS_PITCH: pitchToStr(settings.EDGE_TTS_PITCH),
      EDGE_TTS_STYLE: settings.EDGE_TTS_STYLE,
      WAKE_WORD_ENABLED: String(settings.WAKE_WORD_ENABLED),
      MICROPHONE_SENSITIVITY: String(settings.MICROPHONE_SENSITIVITY),
      WECHAT_SPEECH_RMS_THRESHOLD: String(settings.WECHAT_SPEECH_RMS_THRESHOLD),
      WAKE_START_LISTENING_TIMEOUT_MS: String(settings.WAKE_START_LISTENING_TIMEOUT_MS),
      CONTINUOUS_CONVERSATION_WINDOW_MS: String(settings.WAKE_START_LISTENING_TIMEOUT_MS),
      SHERPA_ONNX_MODEL: settings.SHERPA_ONNX_MODEL,
      SHERPA_ONNX_NUM_THREADS: String(settings.SHERPA_ONNX_NUM_THREADS),
      SHERPA_ONNX_BLOCK_SIZE: String(settings.SHERPA_ONNX_BLOCK_SIZE),
      GLOBAL_SHORTCUT: settings.GLOBAL_SHORTCUT_DISPLAY,
      AUTO_LAUNCH: String(settings.AUTO_LAUNCH),
      SHOW_DOCK_ICON: String(settings.SHOW_DOCK_ICON),
    };
    try {
      const ok = await window.diriAPI.updateConfig(payload);
      if (ok) {
        showTemporaryStatus("✓ 保存成功，已同步到 daisy.env", "success");
        await refreshSherpaStatus();
      } else {
        showTemporaryStatus("保存失败：主进程写入 daisy.env 出错", "error");
      }
    } catch (err: any) {
      showTemporaryStatus("保存失败：" + (err?.message || err), "error");
    }
  };

  // ==================== Sherpa-ONNX 操作 ====================
  const handleRefreshSherpa = async () => {
    showTemporaryStatus("正在检查本地 Sherpa-ONNX 状态…", "info");
    await refreshSherpaStatus();
    showTemporaryStatus("✓ Sherpa-ONNX 状态已刷新", "success");
  };

  const handleDownloadModel = () => {
    if (sherpaModelStatus === "downloaded" || sherpaModelStatus === "downloading") return;
    setSherpaModelStatus("downloading");
    setDownloadProgress(0);
    window.diriAPI.downloadSherpaModel();
    showTemporaryStatus("开始下载 sherpa-onnx Paraformer INT8 模型…", "info");
  };

  // ==================== 对话历史 ====================
  const loadChatHistory = async () => {
    try {
      const history = await window.diriAPI.getChatHistory();
      setChatHistory(history);
    } catch {
      setChatHistory([]);
    }
  };

  const handleClearHistory = async () => {
    try {
      await window.diriAPI.clearChatHistory();
      setChatHistory([]);
      showTemporaryStatus("对话历史已清空", "info");
    } catch {}
  };

  const handleOpenHistory = () => {
    loadChatHistory();
    setIsHistoryOpen(true);
  };

  const handleCloseHistory = () => {
    if (isHistoryOnlyWindow) {
      window.diriAPI.closeHistory();
      return;
    }
    setIsHistoryOpen(false);
  };

  useEffect(() => {
    const shouldLiveRefresh = isHistoryOnlyWindow || isHistoryOpen;
    if (!shouldLiveRefresh || !window.diriAPI?.onChatHistoryUpdated) return;
    loadChatHistory();
    const offHistory = window.diriAPI.onChatHistoryUpdated((history) => {
      setChatHistory(history);
    });
    return () => offHistory();
  }, [isHistoryOnlyWindow, isHistoryOpen]);

  useEffect(() => {
    if (!isHistoryOnlyWindow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.diriAPI.closeHistory();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHistoryOnlyWindow]);

  // ==================== 退出 ====================
  const handleConfirmQuit = () => {
    setIsQuitConfirmOpen(false);
    window.diriAPI.quitApp();
  };

  // ==================== 检查更新 ====================
  const handleCheckUpdate = async () => {
    if (updateStatus === "checking" || updateStatus === "downloading") return;
    try {
      setUpdateStatus("checking");
      setUpdateMessage("");
      setUpdateDownloadPercent(0);
      const result = await window.diriAPI.checkForUpdate();
      if (result.error) {
        setUpdateStatus("error");
        setUpdateMessage(result.error);
        showTemporaryStatus(`检查更新失败：${result.error}`, "error");
        return;
      }
      if (!result.updateAvailable) {
        setUpdateStatus("upToDate");
        setUpdateMessage(result.currentVersion);
        showTemporaryStatus("✓ 已是最新版本", "success");
        return;
      }
      setUpdateStatus("available");
      setUpdateMessage(`${result.currentVersion} → ${result.latestVersion}`);
      // 检查到更新后，自动开始下载
      try {
        const dl = await window.diriAPI.downloadUpdate();
        if (!dl.success) {
          setUpdateStatus("error");
          setUpdateMessage(dl.error || "下载失败");
          showTemporaryStatus(`下载失败：${dl.error || "未知错误"}`, "error");
          return;
        }
        setUpdateStatus("downloading");
        showTemporaryStatus(`正在下载新版本 ${result.latestVersion}…`, "info");
      } catch (err: any) {
        setUpdateStatus("error");
        setUpdateMessage(err?.message || String(err));
        showTemporaryStatus("下载失败：" + (err?.message || err), "error");
      }
    } catch (err: any) {
      setUpdateStatus("error");
      setUpdateMessage(err?.message || String(err));
      showTemporaryStatus("检查更新失败：" + (err?.message || err), "error");
    }
  };

  const handleInstallUpdate = () => {
    window.diriAPI.installUpdate();
  };

  if (isHistoryOnlyWindow) {
    return (
      <div className="history-only-body min-h-screen text-slate-800 selection:bg-sky-100 flex items-center justify-center p-5">
        <ChatHistoryDialog
          chatHistory={chatHistory}
          onClear={handleClearHistory}
          onClose={handleCloseHistory}
          draggableHeader
        />
      </div>
    );
  }

  return (
    <div className="settings-body min-h-screen text-slate-800 p-0 relative selection:bg-sky-100 flex items-center justify-center">
      <div className="bg-ambient-glow">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
      </div>

      <div className="w-[1000px] h-[660px] min-h-0 overflow-hidden relative z-10 grid grid-cols-[240px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-6 p-6">
        {/* Sidebar */}
        <aside className="liquid-glass flex flex-col h-full rounded-[28px] overflow-hidden p-5">
          <div className="flex items-center gap-[18px] pb-5 mb-5 border-b border-white/50 relative">
            <IdleOrb />
            <div>
              <h1 className="font-display font-bold text-[21px] tracking-wide text-slate-800">Daisy</h1>
              <p className="text-[11px] font-medium text-slate-400 mt-0.5">智能助理</p>
            </div>
          </div>

          <nav className="flex-1 flex flex-col gap-3.5 overflow-y-auto pr-1 pb-5 glass-scroll">
            {[
              { id: "model", label: "模型配置", icon: Sparkles },
              { id: "tasks", label: "任务动态", icon: ListTodo },
              { id: "extensions", label: "插件技能", icon: Puzzle },
              { id: "tts", label: "语音播报", icon: Volume2 },
              { id: "memory", label: "长期记忆", icon: Brain },
              { id: "system", label: "系统设置", icon: Settings },
              { id: "license", label: "授权激活", icon: LicenseIcon },
            ].filter(tab => licenseAllowed || tab.id === "license").map((tab) => {
              const IconComp = tab.icon;
              const isModelTab = tab.id === "model";
              const isActive = isModelTab
                ? MODEL_CONFIG_TABS.some((item) => item.id === activeSection)
                : activeSection === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveSection(isModelTab ? "llm" : tab.id)}
                  className={`nav-item-3d ${isActive ? "active" : ""}`}>
                  <IconComp className={`w-4 h-4 ml-1.5 ${isActive ? "text-white" : "text-slate-500"}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="pt-4 mt-4 border-t border-white/50 flex flex-col gap-2.5">
            {[
              { label: "推理模型", active: isLLMActive },
              { label: "语音识别", active: isAsrActive },
              { label: "Firecrawl", active: isFirecrawlActive },
            ].map((st, i) => (
              <div key={i} className="flex items-center justify-between text-[11px] px-1">
                <span className="text-slate-400 font-medium">{st.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-mono text-[10px]">
                    {st.active ? "在线" : "未就绪"}
                  </span>
                  <div className={`glass-indicator-dot ${st.active ? "ok" : "warn"}`}></div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="relative flex flex-col h-full min-h-0 overflow-hidden pb-2">
          <main className="settings-page-scroll h-0 flex-1 min-h-0 overflow-y-auto pb-4 pr-3">
            <div key={activeSection} className="flex flex-col gap-5">
                {activeSection === "tasks" && statusMessage.type === "error" && statusMessage.text && (
                  <p role="alert" className="text-[12px] font-medium text-rose-500">{statusMessage.text}</p>
                )}
                {activeSection === "extensions" && <ExtensionsPanel />}
            {activeSection === "license" && <LicensePanel />}
                {MODEL_CONFIG_TABS.some((item) => item.id === activeSection) && (
                  <div className="flex flex-col gap-3">
                    <div className="px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">模型配置</h2>
                      <p className="text-[12px] text-slate-400 mt-1">选择需要配置的模型与识别能力</p>
                    </div>
                    <div className="liquid-glass model-config-menu">
                      {MODEL_CONFIG_TABS.map((item) => {
                        const IconComp = item.icon;
                        const isActive = activeSection === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setActiveSection(item.id)}
                            className={`model-config-item ${isActive ? "active" : ""}`}
                          >
                            <IconComp className="w-[18px] h-[18px] shrink-0" />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* LLM */}
                {activeSection === "llm" && (
                  <div className="flex flex-col gap-3.5">
                    <div>
                      <div className="mb-1.5 px-1 flex items-baseline justify-between">
                        <h2 className="font-display font-semibold text-[13px] tracking-tight text-slate-800">推理模型</h2>
                        <p className="text-[11px] text-slate-400 flex items-center gap-1">
                          <span>配置推理模型</span>
                          <span className="text-slate-300 select-none">•</span>
                          <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline">
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>获取</span>
                          </a>
                        </p>
                      </div>
                      <div className="liquid-glass py-2.5 px-4 rounded-[16px] flex flex-col gap-2.5">
                        <div className="flex flex-col gap-1">
                          <label className="text-[11px] font-semibold text-slate-500 ml-1">Base URL</label>
                          <input type="url" value={settings.DEEPSEEK_BASE_URL}
                            onChange={(e) => handleInputChange("DEEPSEEK_BASE_URL", e.target.value)}
                            placeholder="https://api.deepseek.com" className="glass-input !py-1.5 !px-3 text-[12px]" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[11px] font-semibold text-slate-500 ml-1">API Key</label>
                          <input type="password" value={settings.DEEPSEEK_API_KEY}
                            onChange={(e) => handleInputChange("DEEPSEEK_API_KEY", e.target.value)}
                            placeholder="sk-..." className="glass-input !py-1.5 !px-3 text-[12px]" autoComplete="off" />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[11px] font-semibold text-slate-500 ml-1">模型 (Model)</label>
                          <input type="text" value={settings.DEEPSEEK_MODEL}
                            onChange={(e) => handleInputChange("DEEPSEEK_MODEL", e.target.value)}
                            placeholder="deepseek-flash" className="glass-input !py-1.5 !px-3 text-[12px]" />
                        </div>
                      </div>
                    </div>

                  </div>
                )}

                {/* ASR */}
                {activeSection === "asr" && (
                  <div className="flex flex-col gap-5">
                    <div>
                     <div className="mb-5 px-1">
                        <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音识别</h2>
                        <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                          <span>火山引擎 / 豆包 Seed ASR，用于将语音转成文字</span>
                          <span className="text-slate-300 select-none">•</span>
                          <a
                            href="https://console.volcengine.com/speech/service/10038"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>获取</span>
                          </a>
                        </p>
                      </div>
                      <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">API Key（新版控制台）</label>
                          <input type="password" value={settings.VOLCENGINE_API_KEY}
                            onChange={(e) => handleInputChange("VOLCENGINE_API_KEY", e.target.value)}
                            placeholder="VOLCENGINE_API_KEY" className="glass-input" autoComplete="off" />
                        </div>
                      </div>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">本地流式识别</h4>
                        <p className="text-[11px] text-slate-400">开启后使用语音唤醒页选择的本地依赖模型；关闭后使用火山 ASR</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.ASR_LOCAL_SHERPA_FIRST}
                          onChange={(e) => handleInputChange("ASR_LOCAL_SHERPA_FIRST", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                  </div>
                )}

                {/* Search */}
                {activeSection === "search" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">联网搜索</h2>
                      <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                        <span>Firecrawl 提供的网页智能搜索与实时爬取能力</span>
                        <span className="text-slate-300 select-none">•</span>
                        <a
                          href="https://www.firecrawl.dev/app/api-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>获取</span>
                        </a>
                      </p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">API Key</label>
                        <input type="password" value={settings.FIRECRAWL_API_KEY}
                          onChange={(e) => handleInputChange("FIRECRAWL_API_KEY", e.target.value)}
                          placeholder="fc-..." className="glass-input" autoComplete="off" />
                      </div>
                    </div>
                  </div>
                )}

                {/* TTS */}
                {activeSection === "tts" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音播报</h2>
                      <p className="text-[12px] text-slate-400 mt-1">Edge TTS 高自然语音合成</p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-6">
                      <div className="flex items-center gap-4">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1 w-20 shrink-0">播报音色</label>
                        <div className="select-container flex-1 min-w-0">
                          <select value={settings.EDGE_TTS_VOICE}
                            onChange={(e) => handleInputChange("EDGE_TTS_VOICE", e.target.value)}
                            className="glass-select">
                            <optgroup label="女声">
                              <option value="zh-CN-XiaoxiaoNeural">晓晓 (默认, 温暖自然)</option>
                              <option value="zh-CN-XiaoyiNeural">晓伊 (活泼灵动)</option>
                            </optgroup>
                            <optgroup label="男声">
                              <option value="zh-CN-YunxiNeural">云希 (极富磁性)</option>
                              <option value="zh-CN-YunyangNeural">云扬 (新闻播报风格)</option>
                              <option value="zh-CN-YunjianNeural">云健 (浑厚有力)</option>
                            </optgroup>
                            <optgroup label="特色方言">
                              <option value="zh-CN-liaoning-XiaobeiNeural">晓贝 (爽朗东北话)</option>
                              <option value="zh-CN-shaanxi-XiaoniNeural">晓妮 (朴实陕西话)</option>
                              <option value="zh-TW-HsiaoChenNeural">曉臻 (嗲雅台湾腔)</option>
                              <option value="zh-HK-HiuMaanNeural">曉曼 (粤语女声)</option>
                            </optgroup>
                          </select>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1 w-20 shrink-0">语音风格</label>
                        <div className="select-container flex-1 min-w-0">
                          <select
                            value={settings.EDGE_TTS_STYLE}
                            onChange={(e) => handleInputChange("EDGE_TTS_STYLE", e.target.value)}
                            className="glass-select"
                          >
                            {ttsStyleOptions.map((style) => (
                              <option key={style.value} value={style.value}>{style.icon} {style.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between ml-1">
                          <label className="text-[12px] font-semibold text-slate-500">语速调整</label>
                          <span className="text-[11px] font-bold font-mono text-sky-600 bg-sky-50/70 border border-sky-200/50 px-2 py-0.5 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                            {rateToStr(settings.EDGE_TTS_RATE)}
                          </span>
                        </div>
                        <div className="pt-2">
                          <input type="range" min="-50" max="50" step="5"
                            value={settings.EDGE_TTS_RATE}
                            onChange={(e) => handleInputChange("EDGE_TTS_RATE", parseInt(e.target.value, 10))}
                            className="tone-slider" />
                          <div className="flex items-center justify-between mt-2">
                            <span className="tts-slider-mark">-50%</span>
                            <span className="tts-slider-mark">{rateToStr(settings.EDGE_TTS_RATE)}</span>
                            <span className="tts-slider-mark">+50%</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between ml-1">
                          <label className="text-[12px] font-semibold text-slate-500">音调高低</label>
                          <span className="text-[11px] font-bold font-mono text-sky-600 bg-sky-50/70 border border-sky-200/50 px-2 py-0.5 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                            {pitchToStr(settings.EDGE_TTS_PITCH)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {pitchPresets.map(({ value, label, Icon }) => {
                            const active = settings.EDGE_TTS_PITCH === value;
                            return (
                              <button
                                key={value}
                                type="button"
                                title={label}
                                aria-label={label}
                                onClick={() => handleInputChange("EDGE_TTS_PITCH", value)}
                                className={`tts-pitch-preset ${active ? "active" : ""}`}
                              >
                                <Icon className="w-4 h-4" />
                              </button>
                            );
                          })}
                        </div>
                        <div className="pt-1">
                          <input
                            type="range"
                            min="-50"
                            max="50"
                            step="5"
                            value={settings.EDGE_TTS_PITCH}
                            onChange={(e) => handleInputChange("EDGE_TTS_PITCH", parseInt(e.target.value, 10))}
                            className="tone-slider"
                          />
                          <div className="flex items-center justify-between mt-2">
                            <span className="tts-slider-mark">-50Hz</span>
                            <span className="tts-slider-mark">{pitchToStr(settings.EDGE_TTS_PITCH)}</span>
                            <span className="tts-slider-mark">+50Hz</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Wake */}
                {activeSection === "wake" && (
                  <div className="flex flex-col gap-5">
                    <div>
                      <div className="mb-5 px-1">
                        <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音唤醒</h2>
                        <p className="text-[12px] text-slate-400 mt-1">Sherpa 本地监听唤醒词，唤醒后默认由微信输入法识别对话</p>
                      </div>
                      <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                        <div className="flex flex-col gap-1 pr-4">
                          <h4 className="text-sm font-semibold text-slate-800">启用语音唤醒</h4>
                          <p className="text-[11px] text-slate-400">
                            对着麦克风说出 <strong className="font-semibold text-[14px] text-slate-800 bg-slate-100/80 px-1.5 py-0.5 rounded-[4px] mx-1">"嘿 Daisy"</strong> 或 <strong className="font-semibold text-[14px] text-slate-800 bg-slate-100/80 px-1.5 py-0.5 rounded-[4px] mx-1">"你好 Daisy"</strong> 即可唤醒助理
                          </p>
                        </div>
                        <label className="glass-switch-container">
                          <input type="checkbox" checked={settings.WAKE_WORD_ENABLED}
                            onChange={(e) => handleInputChange("WAKE_WORD_ENABLED", e.target.checked)} />
                          <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                        </label>
                      </div>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-4.5">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-1">
                        <span className="text-[13px] font-semibold text-slate-700">
                          {settings.ASR_PRIMARY_PROVIDER === "wechat" ? "微信输入法语音识别" : "sherpa-onnx-paraformer"}
                        </span>
                        {(settings.ASR_PRIMARY_PROVIDER === "wechat" ? wechatInstalled : sherpaInstalled) ? (
                          <span className="text-[12px] font-bold text-emerald-500 flex items-center gap-1">
                            <Check className="w-4 h-4" /> 已安装
                          </span>
                        ) : (
                          <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> 未安装
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-700">依赖模型</span>
                        <div className="select-container w-52">
                          <select value={settings.ASR_PRIMARY_PROVIDER}
                            onChange={(e) => {
                              const provider = e.target.value as SettingsState["ASR_PRIMARY_PROVIDER"];
                              handleInputChange("ASR_PRIMARY_PROVIDER", provider);
                              if (provider === "sherpa") handleInputChange("ASR_LOCAL_SHERPA_FIRST", true);
                              setTimeout(() => refreshSherpaStatus(), 150);
                            }}
                            className="glass-select py-1.5 text-[12px] font-semibold pr-8">
                            <option value="wechat">微信输入法识别（默认）</option>
                            <option value="sherpa">Sherpa-onnx-Paraformer</option>
                          </select>
                        </div>
                      </div>
                      {settings.ASR_PRIMARY_PROVIDER !== "wechat" && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-[13px] font-semibold text-slate-700">运行线程</span>
                        <div className="w-52 flex items-center justify-end gap-2">
                          <input
                            type="number"
                            min="1"
                            max="32"
                            step="1"
                            value={settings.SHERPA_ONNX_NUM_THREADS}
                            onChange={(e) => {
                              const parsed = parseInt(e.target.value || "4", 10);
                              handleInputChange("SHERPA_ONNX_NUM_THREADS", Math.min(32, Math.max(1, isNaN(parsed) ? 4 : parsed)));
                            }}
                            className="glass-input w-24 h-11 py-1.5 text-[12px] text-center"
                          />
                          <span className="w-4" aria-hidden="true" />
                        </div>
                      </div>
                      )}
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-[13px] font-semibold text-slate-700">麦克风灵敏度</span>
                        <div className="w-52 flex items-center justify-end gap-3">
                          <input
                            type="range"
                            min="1"
                            max="100"
                            step="1"
                            title="数值越低，越不容易被环境噪音触发"
                            value={settings.MICROPHONE_SENSITIVITY}
                            onChange={(e) => handleInputChange("MICROPHONE_SENSITIVITY", parseInt(e.target.value, 10))}
                            className="tone-slider flex-1"
                          />
                          <span className="w-10 text-right text-[12px] font-bold font-mono text-sky-600">
                            {settings.MICROPHONE_SENSITIVITY}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-[13px] font-semibold text-slate-700">静音检测语音阈值</span>
                        <div className="w-52 flex items-center justify-end gap-2">
                          <input
                            type="number"
                            min="50"
                            max="2000"
                            step="10"
                            value={settings.WECHAT_SPEECH_RMS_THRESHOLD}
                            onChange={(e) => {
                              const parsed = parseInt(e.target.value || "260", 10);
                              const threshold = Math.max(50, Math.min(2000, isNaN(parsed) ? 260 : parsed));
                              handleInputChange("WECHAT_SPEECH_RMS_THRESHOLD", threshold);
                            }}
                            className="glass-input w-24 h-11 py-1.5 text-[12px] text-center"
                          />
                          <span className="w-4 text-[12px] font-medium text-slate-400">RMS</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-[13px] font-semibold text-slate-700">唤醒后等待说话</span>
                        <div className="w-52 flex items-center justify-end gap-2">
                          <input
                            type="number"
                            min="5"
                            max="180"
                            step="5"
                            value={Math.round(settings.WAKE_START_LISTENING_TIMEOUT_MS / 1000)}
                            onChange={(e) => {
                              const parsed = parseInt(e.target.value || "90", 10);
                              const seconds = Math.max(5, Math.min(180, isNaN(parsed) ? 90 : parsed));
                              handleInputChange("WAKE_START_LISTENING_TIMEOUT_MS", seconds * 1000);
                            }}
                            className="glass-input w-24 h-11 py-1.5 text-[12px] text-center"
                          />
                          <span className="w-4 text-[12px] font-medium text-slate-400">秒</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-700">模型状态</span>
                        {settings.ASR_PRIMARY_PROVIDER === "wechat" ? (
                          wechatInstalled ? (
                            <span className="text-[12px] font-bold text-emerald-500">✓ 已就绪 (微信输入法)</span>
                          ) : (
                            <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                              <AlertCircle className="w-3.5 h-3.5" /> 未检测到微信输入法
                            </span>
                          )
                        ) : sherpaModelStatus === "downloaded" ? (
                          <span className="text-[12px] font-bold text-emerald-500">✓ 已就绪 (本地缓存)</span>
                        ) : sherpaModelStatus === "downloading" ? (
                          <span className="text-[12px] font-bold text-sky-500 animate-pulse">↓ 正在下载 ({downloadProgress}%)</span>
                        ) : (
                          <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> ✗ 未下载 (需安装)
                          </span>
                        )}
                      </div>
                      {settings.ASR_PRIMARY_PROVIDER !== "wechat" && sherpaModelStatus === "downloading" && (
                        <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden shadow-inner border border-white">
                          <div className="bg-gradient-to-r from-emerald-400 to-teal-400 h-full rounded-full transition-all duration-200"
                            style={{ width: `${downloadProgress}%` }} />
                        </div>
                      )}
                      {settings.ASR_PRIMARY_PROVIDER !== "wechat" && (
                      <div className="flex gap-3 pt-2">
                        <button onClick={handleRefreshSherpa}
                          className="flex-1 py-2.5 rounded-full btn-glass-clear cursor-pointer text-[12px] flex items-center justify-center gap-1.5">
                          <RefreshCw className="w-3.5 h-3.5" /><span>刷新状态</span>
                        </button>
                        <button onClick={handleDownloadModel}
                          disabled={sherpaModelStatus === "downloaded" || sherpaModelStatus === "downloading"}
                          className={`flex-1 py-2.5 rounded-full cursor-pointer text-[12px] flex items-center justify-center gap-1.5 ${
                            sherpaModelStatus === "downloaded"
                              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                              : "btn-glass-blue text-white"}`}>
                          <Download className="w-3.5 h-3.5" />
                          <span>{sherpaModelStatus === "downloaded" ? "模型已下载" : "下载模型"}</span>
                        </button>
                      </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Task activity */}
                {activeSection === "tasks" && (() => {
                  const pendingTasks = taskActivity.tasks.filter((task) => task.status !== "completed");
                  const statusView = {
                    pending: { label: "进行中", className: "text-sky-600 bg-sky-50 border-sky-100" },
                    completed: { label: "已完成", className: "text-emerald-600 bg-emerald-50 border-emerald-100" },
                    blocked: { label: "未完成", className: "text-rose-600 bg-rose-50 border-rose-100" },
                  } as const;
                  return (
                    <div className="flex flex-col gap-4">
                      <div className="px-1 flex items-end justify-between gap-4">
                        <div>
                          <h2 className="font-display font-semibold text-2xl text-slate-800">任务动态</h2>
                          <p className="text-[12px] text-slate-400 mt-1">最近任务、未完成事项与 Daisy 运行日志</p>
                        </div>
                        <button
                          type="button"
                          title="刷新任务动态"
                          onClick={async () => {
                            setTaskActivityLoading(true);
                            try { setTaskActivity(await window.diriAPI.getTaskActivity()); }
                            finally { setTaskActivityLoading(false); }
                          }}
                          className="w-10 h-10 shrink-0 rounded-full btn-glass-clear cursor-pointer flex items-center justify-center"
                        >
                          <RefreshCw className={`w-4 h-4 text-slate-500 ${taskActivityLoading ? "animate-spin" : ""}`} />
                        </button>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { id: "recent" as const, label: "最近任务", value: taskActivity.tasks.length, Icon: FileText, color: "text-sky-600" },
                          { id: "pending" as const, label: "未完成", value: pendingTasks.length, Icon: AlertCircle, color: "text-rose-600" },
                          { id: "logs" as const, label: "运行日志", value: taskActivity.logs.length, Icon: SquareTerminal, color: "text-violet-600" },
                        ].map((item) => {
                          const active = taskActivityView === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setTaskActivityView(item.id)}
                              aria-pressed={active}
                              className={`min-h-[72px] rounded-[18px] px-4 py-3 text-left transition-all cursor-pointer border ${active
                                ? "bg-white/80 border-orange-300 shadow-[0_8px_24px_rgba(251,146,60,0.16)]"
                                : "liquid-glass border-white/50 hover:bg-white/60"}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className={`text-xl font-semibold ${item.color}`}>{item.value}</div>
                                <item.Icon className={`w-4 h-4 ${active ? item.color : "text-slate-400"}`} />
                              </div>
                              <div className={`text-[11px] mt-0.5 ${active ? "text-slate-700 font-semibold" : "text-slate-400"}`}>{item.label}</div>
                            </button>
                          );
                        })}
                      </div>

                      {taskActivityView === "pending" && (
                        <section className="liquid-glass rounded-[20px] p-4 h-[480px]">
                          <div className="flex items-center gap-2 mb-3">
                            <AlertCircle className="w-4 h-4 text-amber-500" />
                            <h3 className="text-[13px] font-semibold text-slate-700">未完成事项</h3>
                          </div>
                          <div className="flex flex-col gap-2 h-[412px] overflow-y-auto pr-1 glass-scroll">
                            {pendingTasks.length === 0 ? (
                              <div className="text-[12px] text-slate-400 py-8 text-center">暂无未完成事项</div>
                            ) : pendingTasks.slice().reverse().map((task, index) => (
                              <div key={`${task.updatedAt}-${index}`} className="border-b border-white/60 last:border-0 pb-2 last:pb-0">
                                <div className="text-[12px] text-slate-700 leading-relaxed break-words">{task.request}</div>
                                {task.result && <div className="text-[11px] text-slate-400 mt-1 break-words">当前进度：{task.result}</div>}
                              </div>
                            ))}
                          </div>
                        </section>
                      )}

                      {taskActivityView === "recent" && (
                        <section className="liquid-glass rounded-[20px] p-4 h-[480px]">
                        <div className="flex items-center gap-2 mb-3">
                          <FileText className="w-4 h-4 text-sky-500" />
                          <h3 className="text-[13px] font-semibold text-slate-700">最近任务</h3>
                        </div>
                        <div className="flex flex-col gap-2.5 h-[412px] overflow-y-auto pr-1 glass-scroll">
                          {taskActivity.tasks.length === 0 ? (
                            <div className="text-[12px] text-slate-400 py-4 text-center">暂无任务记录</div>
                          ) : taskActivity.tasks.slice().reverse().map((task, index) => {
                            const view = statusView[task.status];
                            return (
                              <div key={`${task.updatedAt}-${index}`} className="flex items-start gap-3 border-b border-white/60 last:border-0 pb-2.5 last:pb-0">
                                <span className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-md border text-[10px] font-semibold ${view.className}`}>{view.label}</span>
                                <div className="min-w-0 flex-1">
                                  <div className="text-[12px] text-slate-700 leading-relaxed break-words">{task.request}</div>
                                  {task.result && <div className="text-[11px] text-slate-400 mt-1 break-words">{task.result}</div>}
                                  <div className="text-[10px] text-slate-300 mt-1">{new Date(task.updatedAt).toLocaleString()}</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        </section>
                      )}

                      {taskActivityView === "logs" && (
                        <section className="liquid-glass rounded-[20px] p-4 h-[480px]">
                        <div className="flex items-center gap-2 mb-3">
                          <SquareTerminal className="w-4 h-4 text-violet-500" />
                          <h3 className="text-[13px] font-semibold text-slate-700">运行日志</h3>
                          <span className="ml-auto text-[10px] text-slate-400">每 2 秒刷新</span>
                        </div>
                        <div className="h-[412px] overflow-auto rounded-lg bg-slate-950/90 border border-white/10 px-3 py-2 glass-scroll select-text">
                          {taskActivity.logs.length === 0 ? (
                            <div className="text-[11px] text-slate-500 font-mono">暂无运行日志</div>
                          ) : taskActivity.logs.map((line, index) => (
                            <div key={index} className="text-[10px] leading-5 text-slate-300 font-mono whitespace-pre-wrap break-all select-text">{line}</div>
                          ))}
                        </div>
                        </section>
                      )}
                    </div>
                  );
                })()}

                {/* Long-term memory */}
                {activeSection === "memory" && (() => {
                  const categoryView = {
                    all: { label: "全部", color: "text-slate-600" },
                    profile: { label: "用户画像", color: "text-fuchsia-600" },
                    preference: { label: "习惯偏好", color: "text-sky-600" },
                    task: { label: "任务经历", color: "text-violet-600" },
                  } as const;
                  const query = memorySearch.trim().toLocaleLowerCase();
                  const visibleEntries = longTermMemory.entries.filter((entry) =>
                    (memoryCategory === "all" || entry.category === memoryCategory) &&
                    (!query || entry.text.toLocaleLowerCase().includes(query))
                  );
                  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedMemoryIds.has(entry.id));
                  return (
                    <div className="flex flex-col gap-4">
                      <div className="px-1">
                        <div className="flex items-center gap-2">
                          <Brain className="w-5 h-5 text-violet-500" />
                          <h2 className="font-display font-semibold text-2xl text-slate-800">长期记忆</h2>
                          <span className="text-[11px] text-slate-400">共 {longTermMemory.entries.length} 条</span>
                        </div>
                        <p className="text-[12px] text-slate-400 mt-1">管理 Daisy 保存在本地的用户画像、习惯偏好与任务经历，数据不会上传</p>
                      </div>

                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: "用户画像", value: longTermMemory.counts.profile, color: "text-fuchsia-600" },
                          { label: "习惯偏好", value: longTermMemory.counts.preference, color: "text-sky-600" },
                          { label: "任务经历", value: longTermMemory.counts.task, color: "text-violet-600" },
                          { label: "保留天数", value: longTermMemory.retentionDays, color: "text-slate-700" },
                        ].map((item) => (
                          <div key={item.label} className="liquid-glass rounded-[16px] px-3 py-2.5 text-center">
                            <div className={`text-lg font-semibold ${item.color}`}>{item.value}</div>
                            <div className="text-[10px] text-slate-400 mt-0.5">{item.label}</div>
                          </div>
                        ))}
                      </div>

                      <section className="liquid-glass rounded-[20px] p-4 min-h-[390px]">
                        <div className="flex items-center justify-between gap-3 mb-3">
                          <h3 className="text-[14px] font-semibold text-slate-700">记忆列表</h3>
                          <div className="text-[10px] text-slate-400">最近 30 天</div>
                        </div>
                        <div className="flex gap-2 mb-3">
                          <label className="glass-input !py-0 !px-3 flex-1 h-10 flex items-center gap-2">
                            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <input
                              value={memorySearch}
                              onChange={(event) => setMemorySearch(event.target.value)}
                              placeholder="搜索长期记忆..."
                              className="min-w-0 flex-1 bg-transparent outline-none text-[12px] text-slate-700 placeholder:text-slate-400"
                            />
                          </label>
                          <button
                            type="button"
                            title="刷新长期记忆"
                            onClick={async () => {
                              setLongTermMemoryLoading(true);
                              try { setLongTermMemory(await window.diriAPI.getLongTermMemory()); }
                              finally { setLongTermMemoryLoading(false); }
                            }}
                            className="w-10 h-10 rounded-full btn-glass-clear cursor-pointer flex items-center justify-center shrink-0"
                          >
                            <RefreshCw className={`w-4 h-4 text-slate-500 ${longTermMemoryLoading ? "animate-spin" : ""}`} />
                          </button>
                          <button
                            type="button"
                            disabled={selectedMemoryIds.size === 0}
                            onClick={() => void deleteMemoryEntries([...selectedMemoryIds])}
                            className={`h-10 px-3 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 ${selectedMemoryIds.size > 0 ? "btn-glass-red text-white cursor-pointer" : "bg-slate-100 text-slate-400 cursor-not-allowed"}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            删除选中
                          </button>
                        </div>

                        <div className="flex border-b border-slate-200 mb-1">
                          {(Object.keys(categoryView) as Array<keyof typeof categoryView>).map((category) => (
                            <button
                              key={category}
                              type="button"
                              onClick={() => setMemoryCategory(category)}
                              className={`px-3 py-2 text-[11px] font-semibold border-b-2 transition-colors ${memoryCategory === category ? `${categoryView[category].color} border-current` : "text-slate-400 border-transparent hover:text-slate-600"}`}
                            >
                              {categoryView[category].label}
                            </button>
                          ))}
                        </div>

                        <div className="grid grid-cols-[34px_76px_minmax(0,1fr)_58px_116px_34px] items-center min-h-9 px-2 border-b border-slate-200 text-[10px] font-semibold text-slate-500">
                          <input
                            type="checkbox"
                            aria-label="选择当前列表全部记忆"
                            checked={allVisibleSelected}
                            onChange={(event) => {
                              setSelectedMemoryIds((previous) => {
                                const next = new Set(previous);
                                for (const entry of visibleEntries) event.target.checked ? next.add(entry.id) : next.delete(entry.id);
                                return next;
                              });
                            }}
                            className="w-3.5 h-3.5 accent-sky-500"
                          />
                          <span>类型</span>
                          <span>内容</span>
                          <span>状态</span>
                          <span>时间</span>
                          <span>操作</span>
                        </div>

                        <div className="max-h-[280px] overflow-y-auto glass-scroll select-text">
                          {visibleEntries.length === 0 ? (
                            <div className="py-14 text-center text-[12px] text-slate-400">没有符合条件的长期记忆</div>
                          ) : visibleEntries.map((entry) => (
                            <div key={entry.id} className="grid grid-cols-[34px_76px_minmax(0,1fr)_58px_116px_34px] items-start px-2 py-2.5 border-b border-slate-100 last:border-0 hover:bg-white/30 transition-colors">
                              <input
                                type="checkbox"
                                aria-label={`选择${categoryView[entry.category].label}记忆`}
                                checked={selectedMemoryIds.has(entry.id)}
                                onChange={(event) => {
                                  setSelectedMemoryIds((previous) => {
                                    const next = new Set(previous);
                                    event.target.checked ? next.add(entry.id) : next.delete(entry.id);
                                    return next;
                                  });
                                }}
                                className="w-3.5 h-3.5 mt-0.5 accent-sky-500"
                              />
                              <span className={`text-[11px] font-semibold ${categoryView[entry.category].color}`}>{categoryView[entry.category].label}</span>
                              <span className="text-[11px] leading-[18px] text-slate-700 break-words pr-3 select-text">{entry.text}</span>
                              <span className="text-[10px] text-emerald-600 font-semibold">有效</span>
                              <span className="text-[10px] leading-4 text-slate-400">{new Date(entry.updatedAt).toLocaleString()}</span>
                              <button
                                type="button"
                                title="删除这条记忆"
                                onClick={() => void deleteMemoryEntries([entry.id])}
                                className="w-7 h-7 -mt-1 rounded-md hover:bg-rose-50 text-slate-400 hover:text-rose-500 flex items-center justify-center cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>
                  );
                })()}

                {/* System */}
                {activeSection === "system" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">系统设置</h2>
                      <p className="text-[12px] text-slate-400 mt-1">唤醒快捷键、开机自启、版本与更新检查</p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex items-center gap-2 text-slate-700">
                        <Keyboard className="w-4 h-4 text-sky-500" />
                        <h4 className="text-sm font-semibold text-slate-800">唤醒快捷键</h4>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-4 items-center">
                          <div className={`flex-1 font-mono font-semibold px-4 py-3.5 rounded-2xl border text-center transition-all ${
                            shortcutCaptureTarget === "wake" ? "bg-sky-50 text-sky-500 border-sky-300 animate-pulse" : "glass-input"}`}>
                            {shortcutCaptureTarget === "wake" ? "请按下快捷键，保存后生效" : settings.GLOBAL_SHORTCUT_DISPLAY}
                          </div>
                          <button onClick={() => setShortcutCaptureTarget("wake")} disabled={shortcutCaptureTarget !== null}
                            className="btn-glass-blue px-6 py-3.5 rounded-2xl cursor-pointer font-medium text-[13px]">
                            <span>{shortcutCaptureTarget === "wake" ? "监听中..." : "设置快捷键"}</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-400 ml-1">
                          {isWindows ? "Windows：按住快捷键说话，松开后发送；默认 Space。" : "按住说话，松手发送。点击按钮后按下任意按键设置。"}
                        </p>
                      </div>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between mt-5">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">在 Dock 中显示 Daisy</h4>
                        <p className="text-[11px] text-slate-400">关闭后 Daisy 仍在后台运行，可从菜单栏图标打开设置或重新显示 Dock</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.SHOW_DOCK_ICON}
                          onChange={(e) => handleInputChange("SHOW_DOCK_ICON", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between mt-5">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">开机自启</h4>
                        <p className="text-[11px] text-slate-400">在您的计算机启动或登录系统时，自动激活并后台运行 Daisy</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.AUTO_LAUNCH}
                          onChange={(e) => handleInputChange("AUTO_LAUNCH", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between mt-5">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">当前版本</h4>
                        <p className="text-[11px] text-slate-400">
                          {currentVersion ? `v${currentVersion}` : "读取中…"}
                          {updateStatus === "upToDate" && updateMessage && (
                            <span className="ml-2 text-emerald-500">✓ 已是最新</span>
                          )}
                          {updateStatus === "available" && updateMessage && (
                            <span className="ml-2 text-amber-500">→ {updateMessage.split("→ ")[1]}</span>
                          )}
                          {(updateStatus === "checking" || updateStatus === "downloading") && (
                            <span className="ml-2 text-sky-500">
                              {updateStatus === "checking" ? "正在检查…" : `下载中 ${updateDownloadPercent}%`}
                            </span>
                          )}
                          {updateStatus === "ready" && (
                            <span className="ml-2 text-emerald-500">✓ 新版本已就绪</span>
                          )}
                          {updateStatus === "error" && (
                            <span className="ml-2 text-rose-500">{updateMessage || "出错"}</span>
                          )}
                        </p>
                        {updateStatus === "downloading" && (
                          <div className="w-full max-w-[260px] bg-slate-100 rounded-full h-2 overflow-hidden shadow-inner border border-white mt-2">
                            <div className="bg-gradient-to-r from-emerald-400 to-teal-400 h-full rounded-full transition-all duration-200"
                              style={{ width: `${updateDownloadPercent}%` }} />
                          </div>
                        )}
                      </div>
                      {(updateStatus === "ready") ? (
                        <button onClick={handleInstallUpdate}
                          className="btn-glass-blue px-6 py-3 rounded-full cursor-pointer text-[13px] font-medium">
                          <span>重启并安装</span>
                        </button>
                      ) : (
                        <button onClick={handleCheckUpdate}
                          disabled={updateStatus === "checking" || updateStatus === "downloading"}
                          className={`px-6 py-3 rounded-full text-[13px] font-medium ${
                            updateStatus === "checking" || updateStatus === "downloading"
                              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                              : "btn-glass-red text-white cursor-pointer"
                          }`}>
                          <span>
                            {updateStatus === "checking" ? "检查中…" :
                             updateStatus === "downloading" ? `下载中 ${updateDownloadPercent}%` :
                             updateStatus === "upToDate" ? "再次检查" :
                             updateStatus === "error" ? "重试" :
                             updateStatus === "available" ? "下载中…" : "检查更新"}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
            </div>
          </main>

          {/* Footer */}
          {!["tasks", "extensions", "license"].includes(activeSection) && <footer className="h-[72px] liquid-glass rounded-[22px] px-5 flex items-center justify-between gap-4 mr-2 shrink-0 mt-4">
            <div className="flex-1 min-w-0 pr-4">
              <AnimatePresence mode="wait">
                {statusMessage.text && (
                  <motion.div key={statusMessage.text}
                    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
                    className={`text-[12px] font-medium flex items-center gap-1.5 truncate ${
                      statusMessage.type === "success" ? "text-emerald-500"
                      : statusMessage.type === "error" ? "text-rose-500" : "text-sky-500"}`}>
                    <span className="w-2 h-2 rounded-full bg-current" />
                    <span>{statusMessage.text}</span>
                  </motion.div>
                )}
              </AnimatePresence>
              {!statusMessage.text && (
                <span className="text-[11px] text-slate-400 font-medium">
                  配置项与后台服务动态同步
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {activeSection === "memory" && <button onClick={handleOpenHistory}
                className="px-5 py-3 rounded-full btn-glass-green cursor-pointer text-[13px] flex items-center gap-1.5">
                <History className="w-4 h-4 text-emerald-600" />
                <span>对话历史</span>
              </button>}
              {!["extensions", "memory", "tasks", "license"].includes(activeSection) && <button onClick={handleSaveSettings} disabled={!configLoaded}
                className="px-6 py-3 rounded-full btn-glass-blue cursor-pointer text-[13px]">
                <span>保存设置</span>
              </button>}
            </div>
          </footer>}
        </div>
      </div>

      {/* 对话历史弹窗 */}
      <AnimatePresence>
        {isHistoryOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="absolute inset-0 bg-slate-900/20 backdrop-blur-md z-40 flex items-center justify-center p-8"
          >
            <ChatHistoryDialog
              chatHistory={chatHistory}
              onClear={handleClearHistory}
              onClose={handleCloseHistory}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 退出确认 */}
      <AnimatePresence>
        {isQuitConfirmOpen && (
          <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-md z-40 flex items-center justify-center p-8">
            <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
              className="w-[360px] liquid-glass p-6 rounded-[28px] text-center">
              <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-100 mx-auto flex items-center justify-center mb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <Power className="w-6 h-6 text-rose-500" />
              </div>
              <h3 className="font-semibold text-slate-800 text-base mb-2">退出 Daisy 助手</h3>
              <p className="text-[12px] text-slate-400 mb-5 leading-relaxed">退出后，语音监听及快捷键唤醒服务将会完全中断。确定要退出吗？</p>
              <div className="flex gap-3">
                <button onClick={() => setIsQuitConfirmOpen(false)}
                  className="flex-1 py-2.5 rounded-full btn-glass-clear cursor-pointer text-[12px]"><span>取消</span></button>
                <button onClick={handleConfirmQuit}
                  className="flex-1 py-2.5 rounded-full btn-glass-red cursor-pointer text-[12px]"><span>确认退出</span></button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
