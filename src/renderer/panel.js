/* global diriAPI */

// ── 运行与面板状态 ──
const BASE_PANEL_WIDTH = 260;
const BASE_PANEL_HEIGHT = 74;
const PANEL_TOP = 134;
const PANEL_WINDOW_MIN_WIDTH = 720;
const PANEL_WINDOW_MIN_HEIGHT = 360;
const PANEL_WINDOW_MARGIN_X = 120;
const PANEL_WINDOW_MARGIN_BOTTOM = 54;
const PANEL_MAX_WIDTH = 920;
const PANEL_MAX_HEIGHT = 600;
const PANEL_SCROLL_LINE_THRESHOLD = 6;

let panelWidth = BASE_PANEL_WIDTH;
let panelHeight = BASE_PANEL_HEIGHT;
let panelRadius = BASE_PANEL_HEIGHT / 2;
let currentText = "";
let isDragging = false;
let typewriterTimeout = null;
let isMouseOverPanel = false;
let liquidTimeouts = [];
let periodicDropInterval = null;
let isMouseDown = false;
let lastMouseX = 0;
let lastMouseY = 0;

const droppingWet = document.getElementById("droppingWet");
const droppingWetPeriodic = document.getElementById("droppingWetPeriodic");
const liquidPanel = document.getElementById("liquidPanel");
const panelContent = document.getElementById("panelContent");
const panelText = document.getElementById("panelText");
const panelTextScroll = document.querySelector(".panel-text-scroll");

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function normalizePanelText(text) {
  return (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]*\n+/g, "\n")
    .replace(/\\n(?:[ \t]*\\n)+/g, "\\n");
}

function getPanelLimits() {
  const displayWidth = window.screen?.availWidth || window.innerWidth || 1280;
  const displayHeight = window.screen?.availHeight || window.innerHeight || 720;
  return {
    maxWidth: clamp(displayWidth - 96, BASE_PANEL_WIDTH, PANEL_MAX_WIDTH),
    maxHeight: clamp(displayHeight - PANEL_TOP - PANEL_WINDOW_MARGIN_BOTTOM - 32, BASE_PANEL_HEIGHT, PANEL_MAX_HEIGHT),
  };
}

function getTextLayout(text) {
  const compactLength = text.replace(/\s+/g, "").length;
  return {
    fontSize:
      compactLength > 900 ? 12 :
      compactLength > 560 ? 12.5 :
      compactLength > 320 ? 13 :
      14,
    paddingX: compactLength > 90 ? 52 : 30,
    paddingY: compactLength > 90 ? 30 : 22,
  };
}

function measureTextHeight(text, contentWidth, fontSize) {
  const measurer = document.createElement("div");
  measurer.className = "panel-text";
  measurer.style.position = "absolute";
  measurer.style.visibility = "hidden";
  measurer.style.pointerEvents = "none";
  measurer.style.left = "-9999px";
  measurer.style.top = "0";
  measurer.style.width = `${contentWidth}px`;
  measurer.style.fontSize = `${fontSize}px`;
  measurer.textContent = text.replace(/\\n/g, "\n");
  document.body.appendChild(measurer);
  const height = Math.ceil(measurer.scrollHeight);
  measurer.remove();
  return height;
}

function computePanelRadius(width, height) {
  return height <= 120 && width <= 360
    ? Math.min(width, height) / 2
    : Math.round(clamp(height * 0.32, 44, 86));
}

function calculatePanelSize(text) {
  const displayText = normalizePanelText(text);
  const limits = getPanelLimits();
  const layout = getTextLayout(displayText);
  const compactLength = displayText.replace(/\s+/g, "").length;
  const desiredContentWidth =
    compactLength <= 22 ? 220 :
    compactLength <= 48 ? 300 :
    compactLength <= 90 ? 420 :
    compactLength <= 180 ? 620 :
    760;
  const horizontalPadding = layout.paddingX * 2;
  const verticalPadding = layout.paddingY * 2;
  const contentWidth = clamp(desiredContentWidth, 188, limits.maxWidth - horizontalPadding);
  const measuredTextHeight = measureTextHeight(displayText, contentWidth, layout.fontSize);
  const lineHeight = layout.fontSize * 1.5;
  const measuredLineCount = Math.max(1, Math.ceil(measuredTextHeight / lineHeight));
  const scrollEnabled = measuredLineCount > PANEL_SCROLL_LINE_THRESHOLD;
  const visibleTextHeight = scrollEnabled
    ? Math.ceil(lineHeight * PANEL_SCROLL_LINE_THRESHOLD + 2)
    : measuredTextHeight;
  const width = clamp(contentWidth + horizontalPadding, BASE_PANEL_WIDTH, limits.maxWidth);
  const height = clamp(visibleTextHeight + verticalPadding, BASE_PANEL_HEIGHT, limits.maxHeight);
  const radius = computePanelRadius(width, height);
  return { width, height, radius, scrollEnabled, measuredLineCount, ...layout };
}

function applyPanelLayout(size) {
  panelRadius = size.radius;
  liquidPanel.style.setProperty("--panel-radius", `${size.radius}px`);
  liquidPanel.style.setProperty("--panel-padding-x", `${size.paddingX}px`);
  liquidPanel.style.setProperty("--panel-padding-y", `${size.paddingY}px`);
  liquidPanel.style.setProperty("--panel-font-size", `${size.fontSize}px`);
  panelTextScroll?.classList.toggle("scroll-enabled", size.scrollEnabled);
}

function resizePanelWindowForContent(width, height) {
  if (!diriAPI.resizePanelWindow) return;
  const windowWidth = Math.max(PANEL_WINDOW_MIN_WIDTH, width + PANEL_WINDOW_MARGIN_X);
  const windowHeight = Math.max(
    PANEL_WINDOW_MIN_HEIGHT,
    PANEL_TOP + height + PANEL_WINDOW_MARGIN_BOTTOM,
  );
  diriAPI.resizePanelWindow(windowWidth, windowHeight);
}

// ── IPC 监听 ──
diriAPI.onAsrFinal((text) => {
  // Can be used if needed
});

// 监听主进程的展示事件
// 通过特定的自定义事件接收 text 并播放展开动画
// Note: We use window IPC channel communication
window.electronIpc = window.electronIpc || {};
const ipcRenderer = window.ipcRenderer || {
  on: (channel, callback) => {
    // If diriAPI has custom listener or if we wire it directly
    // Let's check how diriAPI registers events in preload/index.ts.
    // In preload:
    // onStateUpdate: createListener(IPC_CHANNELS.STATE_UPDATE)
    // onShowWindow: createListener(IPC_CHANNELS.SHOW_WINDOW)
    // ...
    // Oh! We didn't expose a custom event for panel:start-speaking in DiriAPI interface.
    // Wait! Let's check preload/index.ts:
    // Can we send panel:start-speaking using an existing channel or define a generic listener?
    // In DiriAPI interface:
    //   onStateUpdate: createListener<string>(IPC_CHANNELS.STATE_UPDATE)
    // Wait, let's look at preload/index.ts again:
    // It doesn't have a generic ipcRenderer.on!
    // Ah!
    // `contextBridge.exposeInMainWorld("diriAPI", api);`
    // And `api` only has specific listeners.
    // Let's check if we can add custom listener to preload/index.ts, or if we can use onStateUpdate to trigger it!
    // Yes! In updateState, we send IPC_CHANNELS.STATE_UPDATE to panelWindow:
    // `sendToPanelWindow(IPC_CHANNELS.STATE_UPDATE, JSON.stringify(payload));`
    // So panel.js can just listen to `onStateUpdate`!
    // When state === "speaking" and isFinal is true:
    // It runs `triggerFinalSpeakingPanel(data.text)`!
    // When state !== "speaking":
    // It runs `hideFinalSpeakingPanel()`!
    // This is incredibly elegant because we do NOT need to change preload/index.ts at all! We just reuse `onStateUpdate` which is already wired!
  }
};

// ── IPC State Update Listener ──
diriAPI.onStateUpdate((payload) => {
  try {
    const data = JSON.parse(payload);
    const state = data.state || "idle";
    
    if (state === "speaking" && data.isFinal) {
      showPanelText(data.text || "");
    } else if (state !== "speaking" && !data.keepPanelOpen) {
      currentText = "";
      hideFinalSpeakingPanel();
    }
  } catch (err) {
    console.error("onStateUpdate error in panel:", err);
  }
});

diriAPI.onShowWindow(() => {
  // Sync window show
});

diriAPI.onHideWindow(() => {
  hideFinalSpeakingPanel();
});

let panelGeneration = 0;
let lastPanelTriggerText = "";
let lastPanelTriggerAt = 0;

function showPanelText(text) {
  const nextText = text || "";
  const now = performance.now();
  if (nextText === lastPanelTriggerText && now - lastPanelTriggerAt < 400) {
    return;
  }
  lastPanelTriggerText = nextText;
  lastPanelTriggerAt = now;
  currentText = nextText;
  triggerFinalSpeakingPanel();
}

diriAPI.onPanelStartSpeaking((text) => {
  showPanelText(text);
});

// ── 边缘流光动画引擎 ──
function triggerBorderFlow() {
  const currentGen = panelGeneration;
  const w = panelWidth;
  const h = panelHeight;
  const r = clamp(panelRadius, 1, Math.min(w, h) / 2);
  const borderFlowSvg = document.getElementById("borderFlowSvg");
  if (!borderFlowSvg) return;

  borderFlowSvg.style.display = "block";
  borderFlowSvg.setAttribute("width", w);
  borderFlowSvg.setAttribute("height", h);
  borderFlowSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const dLeft = `M ${w / 2} 0 L ${r} 0 A ${r} ${r} 0 0 0 ${r} ${h} L ${w / 2} ${h}`;
  const dRight = `M ${w / 2} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w - r} ${h} L ${w / 2} ${h}`;

  borderFlowSvg.innerHTML = `
    <path id="leftWide" d="${dLeft}" fill="none" stroke="rgba(255, 255, 255, 0.95)" stroke-width="7" stroke-linecap="round" filter="url(#glowFilterWide)" />
    <path id="leftCore" d="${dLeft}" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" filter="url(#glowFilter)" />
    <path id="rightWide" d="${dRight}" fill="none" stroke="rgba(255, 255, 255, 0.95)" stroke-width="7" stroke-linecap="round" filter="url(#glowFilterWide)" />
    <path id="rightCore" d="${dRight}" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" filter="url(#glowFilter)" />
  `;

  const leftWide = document.getElementById("leftWide");
  const leftCore = document.getElementById("leftCore");
  const rightWide = document.getElementById("rightWide");
  const rightCore = document.getElementById("rightCore");

  const paths = [leftWide, leftCore, rightWide, rightCore];
  const lengths = paths.map(p => p.getTotalLength());

  const duration = 1440;
  const startTime = performance.now();

  function animate(time) {
    if (panelGeneration !== currentGen) {
      if (borderFlowSvg) {
        borderFlowSvg.style.display = "none";
        borderFlowSvg.innerHTML = "";
      }
      return;
    }

    const elapsed = time - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const t = progress;
    const easeProgress = 1 - Math.pow(1 - t, 5);

    let opacity = 0;
    if (progress < 0.15) {
      opacity = lerp(0, 0.9, progress / 0.15);
    } else if (progress < 0.45) {
      opacity = lerp(0.9, 0.35, (progress - 0.15) / 0.30);
    } else if (progress < 0.70) {
      opacity = lerp(0.35, 0.05, (progress - 0.45) / 0.25);
    } else {
      opacity = lerp(0.05, 0, (progress - 0.70) / 0.30);
    }

    paths.forEach((path, idx) => {
      const S = lengths[idx];
      const dashLen = S * 0.16;
      path.style.strokeDasharray = `${dashLen} ${S}`;
      const offsetStart = dashLen;
      const offsetEnd = -S;
      const currentOffset = offsetStart - (offsetStart - offsetEnd) * easeProgress;
      path.style.strokeDashoffset = currentOffset;
      path.style.opacity = opacity;
    });

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      borderFlowSvg.style.display = "none";
      borderFlowSvg.innerHTML = "";
    }
  }

  requestAnimationFrame(animate);
}

// ── 首次大水滴坠落动效 ──
function triggerFirstDrop() {
  droppingWet.classList.remove("dropping-wet-anim");
  void droppingWet.offsetWidth;
  droppingWet.classList.add("dropping-wet-anim");

  const tFlow = setTimeout(() => {
    triggerBorderFlow();
  }, 550);

  const tCleanup = setTimeout(() => {
    droppingWet.classList.remove("dropping-wet-anim");
  }, 650);

  liquidTimeouts.push(tFlow, tCleanup);
}

// ── 周期性小水滴坠落动效 ──
function triggerPeriodicDrop() {
  droppingWetPeriodic.classList.remove("dropping-wet-periodic-anim");
  void droppingWetPeriodic.offsetWidth;
  droppingWetPeriodic.classList.add("dropping-wet-periodic-anim");

  const tFlow = setTimeout(() => {
    triggerBorderFlow();
  }, 550);

  const tCleanup = setTimeout(() => {
    droppingWetPeriodic.classList.remove("dropping-wet-periodic-anim");
  }, 650);

  liquidTimeouts.push(tFlow, tCleanup);
}

// ── 液态水滴与玻璃面板动态展开 ──
function triggerFinalSpeakingPanel() {
  clearLiquidTimeouts();
  const targetSize = calculatePanelSize(currentText);
  panelWidth = targetSize.width;
  panelHeight = targetSize.height;
  diriAPI.sendRendererLog(
    `Panel auto-size: ${panelWidth}x${panelHeight}, chars=${currentText.length}, lines=${targetSize.measuredLineCount}, scroll=${targetSize.scrollEnabled}`,
  );
  resizePanelWindowForContent(panelWidth, panelHeight);
  
  // 初始化面板
  liquidPanel.style.display = "flex";
  liquidPanel.classList.remove("expanded");
  liquidPanel.classList.remove("has-expanded");
  liquidPanel.style.width = "20px";
  liquidPanel.style.height = "10px";
  liquidPanel.style.borderRadius = "9999px";
  panelContent.classList.remove("visible");
  panelTextScroll?.classList.remove("scroll-enabled");
  panelText.innerText = "";
  applyPanelLayout(targetSize);
  
  // 触发首次大水滴
  triggerFirstDrop();
  
  // T=450ms: 水滴下坠中，面板开始融化扩散为小气泡
  const t1 = setTimeout(() => {
    liquidPanel.style.width = "48px";
    liquidPanel.style.height = "12px";
  }, 450);
  
  // T=550ms: 水滴滴落溅射，面板流畅展开为最终大小
  const t2 = setTimeout(() => {
    liquidPanel.classList.add("expanded");
    liquidPanel.style.width = `${panelWidth}px`;
    liquidPanel.style.height = `${panelHeight}px`;
    liquidPanel.style.borderRadius = `${targetSize.radius}px`;
  }, 550);
  
  // T=6500ms 周期性循环滴水与流光
  periodicDropInterval = setInterval(() => {
    triggerPeriodicDrop();
  }, 6500);
  
  liquidTimeouts.push(t1, t2);
}

function hideFinalSpeakingPanel() {
  panelGeneration++;
  lastPanelTriggerText = "";
  lastPanelTriggerAt = 0;
  clearLiquidTimeouts();

  const borderFlowSvg = document.getElementById("borderFlowSvg");
  if (borderFlowSvg) {
    borderFlowSvg.style.display = "none";
    borderFlowSvg.innerHTML = "";
  }

  // 清除并隐藏所有面板和动效
  droppingWet.classList.remove("dropping-wet-anim");
  droppingWetPeriodic.classList.remove("dropping-wet-periodic-anim");
  liquidPanel.style.display = "none";
  liquidPanel.classList.remove("expanded");
  liquidPanel.classList.remove("has-expanded");
  panelContent.classList.remove("visible");
  panelText.innerText = "";
  
  // 重置尺寸
  panelWidth = BASE_PANEL_WIDTH;
  panelHeight = BASE_PANEL_HEIGHT;
  panelRadius = BASE_PANEL_HEIGHT / 2;
  resizePanelWindowForContent(panelWidth, panelHeight);
}

function clearLiquidTimeouts() {
  liquidTimeouts.forEach(t => clearTimeout(t));
  liquidTimeouts = [];
  if (periodicDropInterval) {
    clearInterval(periodicDropInterval);
    periodicDropInterval = null;
  }
  if (typewriterTimeout) {
    clearTimeout(typewriterTimeout);
    typewriterTimeout = null;
  }
}

function startTypewriter(text) {
  panelText.innerText = "";
  if (panelTextScroll) {
    panelTextScroll.scrollTop = 0;
  }
  // The model commonly separates paragraphs with a blank line. Keep the
  // paragraph break, but collapse the visual empty row to save panel space.
  const displayText = normalizePanelText(text);
  let i = 0;
  
  function nextChar() {
    if (i < displayText.length) {
      if (displayText.charAt(i) === '\\' && displayText.charAt(i+1) === 'n') {
        panelText.appendChild(document.createElement("br"));
        i += 2;
      } else if (displayText.charAt(i) === '\n') {
        panelText.appendChild(document.createElement("br"));
        i++;
      } else {
        panelText.appendChild(document.createTextNode(displayText.charAt(i)));
        i++;
      }
      if (panelTextScroll && !panelTextScroll.classList.contains("scroll-enabled")) {
        panelTextScroll.scrollTop = panelTextScroll.scrollHeight;
      }
      typewriterTimeout = setTimeout(nextChar, 25);
    } else if (panelTextScroll) {
      panelTextScroll.scrollTop = 0;
    }
  }
  
  nextChar();
}

// ── 鼠标穿透智能判断 ──
window.addEventListener("mousemove", (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (isDragging || isMouseDown) return;
  
  const over = isPointInElement(e.clientX, e.clientY, liquidPanel);
  if (over !== isMouseOverPanel) {
    isMouseOverPanel = over;
    diriAPI.setIgnoreMouse(!isMouseOverPanel);
  }
});

window.addEventListener("mousedown", (e) => {
  const over = isPointInElement(e.clientX, e.clientY, liquidPanel);
  if (over) {
    isMouseDown = true;
  }
});

window.addEventListener("mouseup", () => {
  isMouseDown = false;
  // 鼠标释放后，如果鼠标已经不在面板范围，立刻恢复鼠标穿透，保证交互顺滑
  const over = isPointInElement(lastMouseX, lastMouseY, liquidPanel);
  if (!over && isMouseOverPanel) {
    isMouseOverPanel = false;
    diriAPI.setIgnoreMouse(true);
  }
});

function isPointInElement(x, y, el) {
  if (!el || el.style.display === "none" || el.style.opacity === "0" || el.classList.contains("hidden")) return false;
  const rect = el.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// ── 面板拖拽缩放事件 ──
function setupResizeHandler(elementId) {
  const handler = document.getElementById(elementId);
  if (!handler) return;

  handler.addEventListener("mousedown", (e) => {
    if (!liquidPanel.classList.contains("has-expanded")) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    isDragging = true;
    diriAPI.setIgnoreMouse(false);
    diriAPI.lockPanelOpen();
    
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = panelWidth;
    const startHeight = panelHeight;
    
    function onMouseMove(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      
      panelWidth = Math.round(clamp(startWidth + dx * 2, BASE_PANEL_WIDTH, PANEL_MAX_WIDTH));
      panelHeight = Math.round(clamp(startHeight + dy, BASE_PANEL_HEIGHT, PANEL_MAX_HEIGHT));
      panelRadius = computePanelRadius(panelWidth, panelHeight);
      
      liquidPanel.style.width = `${panelWidth}px`;
      liquidPanel.style.height = `${panelHeight}px`;
      liquidPanel.style.borderRadius = `${panelRadius}px`;
      liquidPanel.style.setProperty("--panel-radius", `${panelRadius}px`);
      resizePanelWindowForContent(panelWidth, panelHeight);
    }
    
    function onMouseUp() {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      
      // 缩放结束时，如果鼠标不在面板范围内，再恢复穿透
      const over = isPointInElement(lastMouseX, lastMouseY, liquidPanel);
      isMouseOverPanel = over;
      diriAPI.setIgnoreMouse(!isMouseOverPanel);
    }
    
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

["rz1", "rz2", "rz3", "rz4"].forEach(setupResizeHandler);

// 监听 CSS 过渡结束事件，替代不精确的 setTimeout 定时器，保证与浏览器 Paint 帧完全同步
liquidPanel.addEventListener("transitionend", (e) => {
  if (e.propertyName === "width" || e.propertyName === "height") {
    if (liquidPanel.classList.contains("expanded") && !liquidPanel.classList.contains("has-expanded")) {
      liquidPanel.classList.add("has-expanded");
      panelContent.classList.add("visible");
      startTypewriter(currentText);
    }
  }
});
