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

const DEBUG = false;
const log = () => { };

chrome.storage.sync.get(DEFAULTS, (c) => CFG = { ...DEFAULTS, ...c });
chrome.storage.onChanged.addListener((changes) => {
  for (const k in changes) {
    if (DEFAULTS.hasOwnProperty(k)) CFG[k] = changes[k].newValue;
  }
});

(async function initDetectVivaldi() {
  if (typeof chrome.vivaldi !== 'undefined') {
    IS_VIVALDI = true;
    return;
  }
  if (chrome.runtime?.getBrowserInfo) {
    const info = await chrome.runtime.getBrowserInfo().catch(() => null);
    if (info?.name?.toLowerCase().includes('vivaldi')) {
      IS_VIVALDI = true;
      return;
    }
  }
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length > 0 && 'vivExtData' in wins[0]) IS_VIVALDI = true;
  } catch { }
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
  if (INJECTED.has(tabId)) return true;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: "ping" }).catch(() => null);
    if (r?.pong) {
      INJECTED.add(tabId);
      return true;
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    INJECTED.add(tabId);
    return true;
  } catch {
    INJECTED.delete(tabId);
    return false;
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!CFG.enabled || !CFG.enableTabSwitch) return;

  const newTabId = activeInfo.tabId;
  const oldTabId = LAST_TAB;
  LAST_TAB = newTabId;

  if (TIMERS[newTabId]) {
    clearTimeout(TIMERS[newTabId]);
    delete TIMERS[newTabId];
  }

  if (oldTabId && oldTabId !== newTabId) {
    try {
      const tab = await chrome.tabs.get(oldTabId);
      if (tab?.url && isSiteEnabled(tab.url)) {
        if (await ensureScript(oldTabId)) {
          chrome.tabs.sendMessage(oldTabId, { action: "tryPiP", reason: "tabSwitch" })
            .catch(() => INJECTED.delete(oldTabId));
        }
      }
    } catch { }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    INJECTED.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  INJECTED.delete(tabId);
  if (TIMERS[tabId]) {
    clearTimeout(TIMERS[tabId]);
    delete TIMERS[tabId];
  }
  if (LAST_TAB === tabId) LAST_TAB = null;
});

chrome.runtime.onMessage.addListener((msg, sender, sendRespond) => {
  const tabId = sender.tab?.id;

  if (msg.action === "isVivaldi") {
    if (!IS_VIVALDI) {
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
            } catch { }
          }
        }
        sendRespond({ isVivaldi: true, isPanel });
      } catch {
        sendRespond({ isVivaldi: true, isPanel: false });
      }
    })();
    return true;
  }
  return false;
});
