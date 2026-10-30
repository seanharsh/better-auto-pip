importScripts('customSites.js');   // BAPCustomSites: shared with the options page

const DEFAULTS = {
  enabled: true,
  debounceMs: 250,
  armMinutes: 10,
  exitOnExpand: false,
  siteSettings: {},
  enableTabSwitch: true,
  tabSwitchDelay: 500,
  showFloatingButton: true,
  showBlockAlerts: true
};

let CFG = DEFAULTS;
let IS_VIVALDI = false;
let VIVALDI_DETECTION_COMPLETE = false;
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
    VIVALDI_DETECTION_COMPLETE = true;
    return;
  }
  if (chrome.runtime?.getBrowserInfo) {
    const info = await chrome.runtime.getBrowserInfo().catch(() => null);
    if (info?.name?.toLowerCase().includes('vivaldi')) {
      IS_VIVALDI = true;
      log("Vivaldi detected via getBrowserInfo");
      VIVALDI_DETECTION_COMPLETE = true;
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
  try {
    const wins = await chrome.windows.getAll();
    if (wins.some(w => 'vivExtData' in w)) {
      IS_VIVALDI = true;
      log("Vivaldi detected via vivExtData (any window)");
    }
  } catch { }
  VIVALDI_DETECTION_COMPLETE = true;
  log(`Vivaldi detection complete: IS_VIVALDI=${IS_VIVALDI}`);
})();

const getHost = (url) => {
  try { return new URL(url).host; } catch { return ""; }
};

const isSiteEnabled = (url) => {
  if (!url) return false;
  const host = getHost(url);
  return !!host && (CFG.siteSettings?.[host] || {}).enableTab !== false;
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
          const delay = Math.max(+CFG.tabSwitchDelay || 0, 0);
          log(`Scheduling tryPiP for tab ${oldTabId} in ${delay}ms (reason: tabSwitch)`);
          clearTimeout(TIMERS[oldTabId]);
          // Cancelled in onActivated if the user returns to the tab before the delay elapses
          TIMERS[oldTabId] = setTimeout(() => {
            delete TIMERS[oldTabId];
            log(`Sending tryPiP to tab ${oldTabId} (reason: tabSwitch)`);
            chrome.tabs.sendMessage(oldTabId, { action: "tryPiP", reason: "tabSwitch" })
              .catch((e) => {
                log(`Failed to send tryPiP to tab ${oldTabId}:`, e?.message);
                INJECTED.delete(oldTabId);
              });
          }, delay);
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

// Vivaldi panel tabs seen so far. tabs.query can't list them, and the service worker may stop between uses, so keep them in session storage.
async function getPanelTabs() {
  try { return (await chrome.storage.session.get({ panelTabs: [] })).panelTabs; } catch { return []; }
}
async function setPanelTabs(ids) {
  try { await chrome.storage.session.set({ panelTabs: ids }); } catch { }
}
async function rememberPanelTab(tabId) {
  const ids = await getPanelTabs();
  if (!ids.includes(tabId)) await setPanelTabs([...ids, tabId]);
}
async function forgetPanelTab(tabId) {
  const ids = await getPanelTabs();
  if (ids.includes(tabId)) await setPanelTabs(ids.filter((id) => id !== tabId));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  log(`Tab ${tabId} removed, cleaning up`);
  forgetPanelTab(tabId);
  INJECTED.delete(tabId);
  if (TIMERS[tabId]) {
    clearTimeout(TIMERS[tabId]);
    delete TIMERS[tabId];
  }
  if (LAST_TAB === tabId) LAST_TAB = null;
});

// ---- Custom sites (user-added): keep registered content scripts in step with storage + granted permissions ----
const CUSTOM_PREFIX = 'bap-custom-';
let customSyncChain = Promise.resolve();

async function doSyncCustomSites() {
  const { customSites, allSites } = await chrome.storage.sync.get({ customSites: [], allSites: false });
  const wanted = new Map();
  // "Allow on all sites": only when the switch is a real `true` AND the user granted *://*/*. All frames, so embedded players can mirror their
  // video to the top frame; in sub-frames the content script stays quiet (no floating button) and only acts once a video plays.
  if (allSites === true && (await chrome.permissions.contains({ origins: [BAPCustomSites.ALL_SITES_PATTERN] }))) {
    wanted.set(BAPCustomSites.ALL_SITES_SCRIPT_ID, { id: BAPCustomSites.ALL_SITES_SCRIPT_ID, matches: [BAPCustomSites.ALL_SITES_PATTERN], js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true });
  }
  for (const host of BAPCustomSites.sanitizeList(customSites)) {
    const matches = BAPCustomSites.toMatchPatterns(host);
    if (!(await chrome.permissions.contains({ origins: matches }))) continue;      // never register without the user's grant
    wanted.set(CUSTOM_PREFIX + host, { id: CUSTOM_PREFIX + host, matches, js: ['content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true });
  }
  const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((r) => r.id.startsWith(CUSTOM_PREFIX) || r.id === BAPCustomSites.ALL_SITES_SCRIPT_ID);
  const stale = existing.filter((r) => !wanted.has(r.id)).map((r) => r.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const have = new Set(existing.map((r) => r.id));
  const toAdd = [...wanted.values()].filter((r) => !have.has(r.id));
  if (toAdd.length) await chrome.scripting.registerContentScripts(toAdd);
  log(`Custom sites synced: registered=${[...wanted.keys()].join(',') || '(none)'} removed=${stale.join(',') || '(none)'}`);
}
// One at a time, so overlapping triggers (storage change + message + permission event) can't double-register.
function syncCustomSites() {
  customSyncChain = customSyncChain.then(doSyncCustomSites, doSyncCustomSites).catch((e) => log('Custom sites sync failed:', e?.message));
  return customSyncChain;
}
syncCustomSites();
// Tabs already open when the extension is installed, updated or reloaded keep the old content script, which is cut off from the
// extension, so PiP would not work there until the page is refreshed. Put the current one into every frame we have access to.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const res = await Promise.all(tabs.map((t) => chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["content.js"] }).then(() => 1, () => 0)));
  log(`Injected the content script into ${res.reduce((a, b) => a + b, 0)} of ${tabs.length} open tab(s)`);
}
chrome.runtime.onInstalled.addListener(({ reason }) => {
  syncCustomSites();
  if (reason === "install" || reason === "update") injectIntoOpenTabs().catch((e) => log("Injecting into open tabs failed:", e?.message));
});
chrome.runtime.onStartup.addListener(() => syncCustomSites());
chrome.permissions.onAdded.addListener(() => syncCustomSites());
chrome.permissions.onRemoved.addListener(() => syncCustomSites());
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && (changes.customSites || changes.allSites)) syncCustomSites(); });

chrome.runtime.onMessage.addListener((msg, sender, sendRespond) => {
  const tabId = sender.tab?.id;
  log(`Message received: action=${msg.action}, tabId=${tabId}`);

  if (msg.action === "syncCustomSites") {
    syncCustomSites().then(() => sendRespond({ ok: true }));
    return true;
  }

  // Setup prompt: open the browser's site settings for the sending tab's site (its own URL, never one from the message),
  // where the user can set "Automatic picture-in-picture" to Allow. Extensions cannot change that setting themselves.
  if (msg.action === "openAutoPipSettings") {
    let origin = null;
    try { const u = new URL(sender.tab?.url || ""); if (u.protocol === "https:" || u.protocol === "http:") origin = u.origin; } catch { }
    if (!origin) return false;
    const url = `chrome://settings/content/siteDetails?site=${encodeURIComponent(origin)}`;
    // Vivaldi ignores the url given to tabs.create (the tab stays blank) but honours tabs.update, so set it again.
    chrome.tabs.create({ url, index: (sender.tab.index ?? 0) + 1, openerTabId: tabId })
      .then((t) => chrome.tabs.update(t.id, { url }))
      .then(() => log(`Opened site settings for ${origin}`), (e) => log(`Could not open site settings: ${e?.message}`));
    return false;
  }

  // Mirror signalling between an embedded player frame and the top frame of the same tab (see content.js "Mirror").
  if (msg.action === "mirror") {
    if (!tabId) return false;
    chrome.tabs.sendMessage(tabId, { ...msg, fromFrame: sender.frameId || 0 }, { frameId: msg.toFrame || 0 })
      .then((r) => sendRespond(r || { ok: false }), () => sendRespond({ ok: false }));
    return true;
  }

  if (msg.action === "isVivaldi") {
    (async () => {
      // Wait for Vivaldi detection to complete
      let waitCount = 0;
      while (!VIVALDI_DETECTION_COMPLETE && waitCount < 50) {
        await new Promise(r => setTimeout(r, 10));
        waitCount++;
      }

      if (!IS_VIVALDI) {
        const w = await chrome.windows.get(sender.tab.windowId).catch(() => null);   // the asking tab's own window
        if (w && 'vivExtData' in w) IS_VIVALDI = true;
      }
      if (!IS_VIVALDI) {
        log(`Responding to isVivaldi: isVivaldi=false`);
        sendRespond({ isVivaldi: false, isPanel: false });
        return;
      }

      try {
        // Vivaldi web panels are tabs the extension can message, but tabs.query never lists them (normal tabs, tab stacks and
        // tiles all are). Neither window size nor the window's vivExtData can tell which page is the panel.
        const isPanel = !!tabId && !(await chrome.tabs.query({})).some((t) => t.id === tabId);
        if (isPanel) rememberPanelTab(tabId);
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

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== "trigger-pip") return;
    const tabId = tab?.id;
    if (!tabId) {
      log("trigger-pip command received but no tab id");
      return;
    }
    log(`trigger-pip command on tab ${tabId}`);
    const run = (id) => chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      func: () => {
        const videos = Array.from(document.querySelectorAll("video")).filter((v) => !v.hasAttribute("data-bap-mirror"));
        let best = null;
        let bestArea = 0;
        for (const v of videos) {
          if (!v.isConnected) continue;
          try {
            if (v.paused || v.ended || v.readyState < 2) continue;
            const r = v.getBoundingClientRect();
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = v; }
          } catch { }
        }
        if (!best && videos.length) best = videos[0];
        if (!best) return { ok: false, reason: "no-video" };
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => { });
          return { ok: true, action: "exit" };
        }
        return best.requestPictureInPicture()
          .then(() => ({ ok: true, action: "enter" }))
          .catch((e) => ({ ok: false, reason: e?.name || "unknown", message: e?.message }));
      }
    }).then((results) => {
      const r = results?.map(x => x.result) || [];
      log(`trigger-pip results on tab ${id}:`, JSON.stringify(r));
      return r;
    });
    // The command comes with the active normal tab, never a panel. If that tab has no video, try the Vivaldi panels instead.
    (async () => {
      const found = (r) => r.some((x) => x?.reason !== "no-video");
      if (found(await run(tabId).catch((e) => (log("trigger-pip failed:", e?.message), [])))) return;
      for (const id of await getPanelTabs()) {
        const r = await run(id).catch(() => { forgetPanelTab(id); return []; });
        if (found(r)) return;
      }
    })();
  });
}

log("Background service worker initialized");
