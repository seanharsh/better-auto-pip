const DEFAULTS = {
  enabled: true,
  collapseWidthPx: 8,
  collapseHeightPx: 80,
  debounceMs: 250,
  armMinutes: 10,
  exitOnExpand: false,
  siteEnabled: {},
  enableTabSwitch: true,
  tabSwitchDelay: 500,
  showFloatingButton: true,
  showBlockAlerts: true
};

let CFG = DEFAULTS;
let IS_VIVALDI = false;
let LAST_TAB = null;
const TIMERS = {};
const INJECTED = new Set();

const DEBUG = true;
const log = (...args) => {
  if (DEBUG) console.debug("[BetterAutoPiP Background]", ...args);
};

chrome.storage.sync.get(DEFAULTS, (c) => {
  CFG = { ...DEFAULTS, ...c };
  log("Config loaded:", CFG);
});
chrome.storage.onChanged.addListener((changes) => {
  for (const k in changes) {
    if (DEFAULTS.hasOwnProperty(k)) {
      CFG[k] = changes[k].newValue;
      log(`Config changed: ${k} =`, changes[k].newValue);
    }
  }
});

(async function initDetectVivaldi() {
  if (typeof chrome.vivaldi !== 'undefined') {
    IS_VIVALDI = true;
    log("Vivaldi detected via chrome.vivaldi API");
    return;
  }
  if (chrome.runtime?.getBrowserInfo) {
    const info = await chrome.runtime.getBrowserInfo().catch(() => null);
    if (info?.name?.toLowerCase().includes('vivaldi')) {
      IS_VIVALDI = true;
      log("Vivaldi detected via getBrowserInfo");
      return;
    }
  }
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length > 0 && 'vivExtData' in wins[0]) {
      IS_VIVALDI = true;
      log("Vivaldi detected via vivExtData");
    }
  } catch { }
  log(`Vivaldi detection complete: IS_VIVALDI=${IS_VIVALDI}`);
})();

const getHost = (url) => {
  try { return new URL(url).host; } catch { return ""; }
};

const isSiteEnabled = (url) => {
  if (!url) return false;
  const host = getHost(url);
  return host && CFG.siteEnabled[host] !== false;
};

async function ensureScript(tabId) {
  if (INJECTED.has(tabId)) {
    log(`Tab ${tabId}: content script already injected (cached)`);
    return true;
  }
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: "ping" }).catch(() => null);
    if (r?.pong) {
      INJECTED.add(tabId);
      log(`Tab ${tabId}: content script responded to ping`);
      return true;
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    INJECTED.add(tabId);
    log(`Tab ${tabId}: content script injected successfully`);
    return true;
  } catch (e) {
    INJECTED.delete(tabId);
    log(`Tab ${tabId}: failed to inject content script -`, e?.message);
    return false;
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const newTabId = activeInfo.tabId;
  const oldTabId = LAST_TAB;
  log(`Tab activated: ${oldTabId} -> ${newTabId}`);

  if (!CFG.enabled || !CFG.enableTabSwitch) {
    log(`Tab switch ignored: enabled=${CFG.enabled}, enableTabSwitch=${CFG.enableTabSwitch}`);
    LAST_TAB = newTabId;
    return;
  }

  LAST_TAB = newTabId;

  if (TIMERS[newTabId]) {
    clearTimeout(TIMERS[newTabId]);
    delete TIMERS[newTabId];
  }

  if (oldTabId && oldTabId !== newTabId) {
    try {
      const tab = await chrome.tabs.get(oldTabId);
      const host = getHost(tab?.url);
      const siteOk = isSiteEnabled(tab?.url);
      log(`Previous tab ${oldTabId}: url=${host}, siteEnabled=${siteOk}`);
      if (tab?.url && siteOk) {
        if (await ensureScript(oldTabId)) {
          log(`Sending tryPiP to tab ${oldTabId} (reason: tabSwitch)`);
          chrome.tabs.sendMessage(oldTabId, { action: "tryPiP", reason: "tabSwitch" })
            .catch((e) => {
              log(`Failed to send tryPiP to tab ${oldTabId}:`, e?.message);
              INJECTED.delete(oldTabId);
            });
        }
      }
    } catch (e) {
      log(`Error accessing previous tab ${oldTabId}:`, e?.message);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    INJECTED.delete(tabId);
    log(`Tab ${tabId} loading, cleared injection cache`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  log(`Tab ${tabId} removed, cleaning up`);
  INJECTED.delete(tabId);
  if (TIMERS[tabId]) {
    clearTimeout(TIMERS[tabId]);
    delete TIMERS[tabId];
  }
  if (LAST_TAB === tabId) LAST_TAB = null;
});

chrome.runtime.onMessage.addListener((msg, sender, sendRespond) => {
  const tabId = sender.tab?.id;
  log(`Message received: action=${msg.action}, tabId=${tabId}`);

  if (msg.action === "isVivaldi") {
    if (!IS_VIVALDI) {
      log(`Responding to isVivaldi: isVivaldi=false`);
      sendRespond({ isVivaldi: false, isPanel: false });
      return false;
    }

    (async () => {
      try {
        const winId = sender.tab.windowId;
        const win = await chrome.windows.get(winId).catch(() => null);

        let isPanel = false;
        if (win && win.vivExtData) {
          const dataStr = typeof win.vivExtData === 'string' ? win.vivExtData : null;
          if (!dataStr || (dataStr.includes("SELECTED_PANEL") || dataStr.includes("SHOW_PANEL"))) {
            try {
              const data = dataStr ? JSON.parse(dataStr) : win.vivExtData;
              const webPanelActive = (data.SELECTED_PANEL && data.SELECTED_PANEL.startsWith("WEBPANEL_")) || data.SHOW_PANEL;

              if (webPanelActive) {
                let t = sender.tab;
                if (!t.width) t = await chrome.tabs.get(tabId);

                if (t.width && win.width && (t.width / win.width < 0.7)) {
                  isPanel = true;
                }
              }
            } catch (e) {
              log(`Error parsing vivExtData:`, e?.message);
            }
          }
        }
        log(`Responding to isVivaldi: isVivaldi=true, isPanel=${isPanel}`);
        sendRespond({ isVivaldi: true, isPanel });
      } catch (e) {
        log(`Error in isVivaldi handler:`, e?.message);
        sendRespond({ isVivaldi: true, isPanel: false });
      }
    })();
    return true;
  }

  if (msg.action === "pipEntered") {
    log(`PiP entered in tab ${tabId} (reason: ${msg.reason})`);
  } else if (msg.action === "pipExited") {
    log(`PiP exited in tab ${tabId}`);
  }

  return false;
});

log("Background service worker initialized");
