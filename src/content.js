(() => {
  const DEFAULTS = {
    enabled: true,
    collapseWidthPx: 8,
    collapseHeightPx: 80,
    debounceMs: 250,
    armMinutes: 10,
    exitOnExpand: true,
    siteSettings: {},
    tabSwitchDelay: 500,
    showFloatingButton: true,
    showBlockAlerts: true
  };

  const state = {
    armedUntil: 0,
    lastCollapsed: false,
    lastAttemptTs: 0,
    debounceTimer: null,
    toastEl: null,
    bannerEl: null,
    floatingToggle: null,
    isInPiP: false,
    lastVisibilityState: document.visibilityState,
    lastViewportKey: null,
    tabSwitchFailCount: 0,
    lastUserInteraction: 0,
    mediaSessionHandlerRegistered: false,
    supportsAutoPiP: false,
    cachedVideos: null,
    cachedVideosTs: 0,
    cachedViewport: null,
    cachedViewportTs: 0,
    cachedConfig: null,
    cachedConfigTs: 0
  };

  function isExtensionValid() {
    try {
      return !!(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isVivaldi() {
    return !!(window.vivaldi) || navigator.userAgent.includes("Vivaldi") || (navigator.vendor && navigator.vendor.includes("Vivaldi"));
  }

  const log = () => { };

  function hostKey() {
    try { return location.host; } catch { return ""; }
  }

  function now() {
    return Date.now();
  }

  function isArmed() {
    return now() < state.armedUntil;
  }

  function arm(minutes) {
    state.armedUntil = now() + minutes * 60000;
    state.tabSwitchFailCount = 0;
  }

  function checkAutoPiPSupport() {
    try {
      if (!navigator.mediaSession) return false;
      try {
        navigator.mediaSession.setActionHandler("enterpictureinpicture", null);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  async function registerMediaSessionHandler() {
    if (state.mediaSessionHandlerRegistered || !state.supportsAutoPiP) return;
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !isSiteEnabled(cfg, "tab")) return;

      navigator.mediaSession.setActionHandler("enterpictureinpicture", async () => {
        const currentCfg = await loadConfig();
        if (!currentCfg.enabled || !isSiteEnabled(currentCfg, "tab")) return;

        const video = getBestVideo();
        if (!video || document.pictureInPictureElement) return;

        try {
          await video.requestPictureInPicture();
          state.isInPiP = true;
          state.tabSwitchFailCount = 0;
          hideToast();
          hideBanner();
          if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipEntered", reason: "mediaSession" });
        } catch { }
      });

      state.mediaSessionHandlerRegistered = true;
    } catch { }
  }

  function unregisterMediaSessionHandler() {
    if (!state.mediaSessionHandlerRegistered) return;
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture", null);
      state.mediaSessionHandlerRegistered = false;
    } catch { }
  }

  function getViewportSize() {
    const t = now();
    if (state.cachedViewport && t - state.cachedViewportTs < 100) return state.cachedViewport;
    const vv = window.visualViewport;
    const w = vv?.width ?? window.innerWidth ?? document.documentElement.clientWidth ?? 0;
    const h = vv?.height ?? window.innerHeight ?? document.documentElement.clientHeight ?? 0;
    state.cachedViewport = { w: Math.round(w), h: Math.round(h) };
    state.cachedViewportTs = t;
    return state.cachedViewport;
  }

  function isVivaldiPanel() {
    try {
      const { w, h } = getViewportSize();
      if (window.name && window.name.startsWith('vivaldi-webpanel-')) return true;
      if (window.location.href.includes('vivaldi://webpanel') || window.location.href.includes('vivaldi-webpanel')) return true;
      const screenW = window.screen.width;
      return window === window.top && window.opener === null && w < (screenW * 0.6) && (h / w) > 1.2;
    } catch {
      return false;
    }
  }

  function isCollapsed(cfg) {
    const { w, h } = getViewportSize();
    return (w > 0 && w <= cfg.collapseWidthPx) || (h > 0 && h <= cfg.collapseHeightPx);
  }

  function visibleAreaScore(video) {
    const rect = video.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return 0;
    const { w: vw, h: vh } = getViewportSize();
    const onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
    return (w * h) * (onScreen ? 1 : 0.2);
  }

  function getBestVideo() {
    const t = now();
    if (state.cachedVideos && t - state.cachedVideosTs < 1000) {
      let best = null;
      let bestScore = 0;
      const len = state.cachedVideos.length;
      for (let i = 0; i < len; i++) {
        const v = state.cachedVideos[i];
        if (!v.isConnected) continue;
        try {
          if (v.paused || v.ended || v.readyState < 2) continue;
          const score = visibleAreaScore(v);
          if (score > bestScore) {
            bestScore = score;
            best = v;
          }
        } catch { }
      }
      if (best) return best;
    }

    const videos = [];
    const docVideos = document.querySelectorAll("video");
    for (let i = 0; i < docVideos.length; i++) videos.push(docVideos[i]);

    if (location.host.includes("youtube.com")) {
      const ytVideo = document.querySelector("#movie_player video, .html5-video-player video, ytd-player video");
      if (ytVideo && !videos.includes(ytVideo)) videos.unshift(ytVideo);
    }

    try {
      const iframes = document.querySelectorAll("iframe");
      for (let i = 0; i < iframes.length; i++) {
        try {
          const iframeDoc = iframes[i].contentDocument || iframes[i].contentWindow?.document;
          if (iframeDoc) {
            const iVideos = iframeDoc.querySelectorAll("video");
            for (let j = 0; j < iVideos.length; j++) videos.push(iVideos[j]);
          }
        } catch { }
      }
    } catch { }

    state.cachedVideos = videos;
    state.cachedVideosTs = t;

    let best = null;
    let bestScore = 0;
    let fallback = null;
    let fallbackScore = 0;

    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      try {
        const score = visibleAreaScore(v);
        if (!v.paused && !v.ended && v.readyState >= 2) {
          if (score > bestScore) {
            bestScore = score;
            best = v;
          }
        } else if (v.readyState >= 1) {
          if (score > fallbackScore) {
            fallbackScore = score;
            fallback = v;
          }
        }
      } catch { }
    }
    return best || fallback || (videos.length > 0 ? videos[0] : null);
  }

  async function tryEnterPiP(cfg, reason = "unknown") {
    const t = now();
    if (t - state.lastAttemptTs < 1500) return;
    state.lastAttemptTs = t;

    const video = getBestVideo();
    if (!video || document.pictureInPictureElement) return;

    const isArmed = t < state.armedUntil;
    const timeSinceInteraction = t - state.lastUserInteraction;
    const hasRecentInteraction = timeSinceInteraction < 5000;

    if (reason === "tabSwitch" && !isArmed && !hasRecentInteraction && timeSinceInteraction > 10000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
      await video.requestPictureInPicture();
      state.isInPiP = true;
      state.tabSwitchFailCount = 0;
      hideToast();
      hideBanner();
      if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipEntered", reason });
    } catch (e) {
      if (e?.name === "NotAllowedError" || e?.message?.includes("gesture")) {
        if (reason === "tabSwitch") {
          state.tabSwitchFailCount++;
          if (state.tabSwitchFailCount === 1 && now() >= state.armedUntil) {
            if (cfg.showBlockAlerts !== false) {
              showInteractionBanner(cfg, "tab");
            }
          }
        } else {
          if (cfg.showBlockAlerts !== false) {
            showInteractionBanner(cfg, "panel");
          }
        }
      }
    }
  }

  async function maybeExitPiP(cfg) {
    if (!cfg.exitOnExpand) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        state.isInPiP = false;
        if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipExited" });
      }
    } catch { }
  }

  function showToast(cfg, text) {
    if (state.toastEl) return;
    const el = document.createElement("div");
    el.className = "betterautopip-toast";
    el.textContent = text;
    el.addEventListener("click", async () => {
      if (!isExtensionValid()) return hideToast();
      arm(cfg.armMinutes);
      el.textContent = `Armed for ${cfg.armMinutes} min. Trying PiP...`;
      const video = getBestVideo();
      if (video && !document.pictureInPictureElement) {
        try {
          await video.requestPictureInPicture();
          state.isInPiP = true;
          setTimeout(hideToast, 1000);
          if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipEntered", reason: "armed" });
        } catch {
          el.textContent = `Armed for ${cfg.armMinutes} min. Collapse to PiP.`;
          setTimeout(hideToast, 2000);
        }
      } else {
        setTimeout(hideToast, 2000);
      }
    }, { once: true });
    document.documentElement.appendChild(el);
    state.toastEl = el;
  }

  function hideToast() {
    if (!state.toastEl) return;
    state.toastEl.remove();
    state.toastEl = null;
  }

  function showInteractionBanner(cfg, triggerType) {
    if (state.bannerEl) return;
    if (cfg.showBlockAlerts === false) return; // double-check
    const el = document.createElement("div");
    el.className = "betterautopip-banner";
    const msg = triggerType === "tab" ? "Better Auto PiP needs page interaction to work when switching tabs." : "Better Auto PiP needs page interaction to work when panel collapses.";
    el.innerHTML = `<div class="betterautopip-banner-content"><div class="betterautopip-banner-icon">&#9432;</div><div class="betterautopip-banner-text"><strong>Picture-in-Picture Blocked</strong><p>${msg} Click anywhere on this page, then try again.</p></div><button class="betterautopip-banner-close">&times;</button></div>`;
    el.querySelector(".betterautopip-banner-close").addEventListener("click", (e) => { e.stopPropagation(); hideBanner(); });
    const hideTimer = setTimeout(hideBanner, 8000);
    const interactionHandler = () => {
      clearTimeout(hideTimer);
      setTimeout(hideBanner, 2000);
      document.removeEventListener("mousedown", interactionHandler);
      document.removeEventListener("keydown", interactionHandler);
    };
    document.addEventListener("mousedown", interactionHandler, { once: true });
    document.addEventListener("keydown", interactionHandler, { once: true });
    document.documentElement.appendChild(el);
    state.bannerEl = el;
  }

  function hideBanner() {
    if (!state.bannerEl) return;
    state.bannerEl.remove();
    state.bannerEl = null;
  }

  let cachedVivaldi = null;
  async function getVivaldiData() {
    if (cachedVivaldi) return cachedVivaldi;
    try {
      cachedVivaldi = await chrome.runtime.sendMessage({ action: "isVivaldi" });
    } catch {
      cachedVivaldi = { isPanel: false };
    }
    return cachedVivaldi || { isPanel: false };
  }

  async function updateFloatingToggle() {
    if (!document.body) return setTimeout(updateFloatingToggle, 500);
    const cfg = await loadConfig();

    if (cfg.showFloatingButton === false) {
      if (state.floatingToggle) {
        state.floatingToggle.remove();
        state.floatingToggle = null;
      }
      return;
    }

    if (state.floatingToggle) return;

    injectStylesOnce();
    const host = hostKey();
    const vInfo = await getVivaldiData();
    const isPanel = vInfo?.isPanel || false;

    const sKey = isPanel ? 'enablePanel' : 'enableTab';
    const isEnabled = (cfg.siteSettings[host] || {})[sKey] !== false;

    // Optimization: Create element only if needed, use fragment if complex (here simple)
    const el = document.createElement("div");
    el.className = `betterautopip-floating-toggle ${isEnabled ? 'enabled' : 'disabled'}`;
    el.innerHTML = `<div class="betterautopip-floating-toggle-icon"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="14" rx="2" stroke="currentColor" stroke-width="2"/><rect x="12" y="11" width="8" height="5" rx="1" fill="currentColor"/></svg></div><div class="betterautopip-floating-toggle-text">Auto PiP<span class="betterautopip-floating-toggle-status">${isEnabled ? 'ON' : 'OFF'}</span></div>`;

    // Optimize: Single event listener with cached state access
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      const cCfg = await loadConfig(); // Refresh config on interaction
      const cHost = hostKey();
      const cv = await getVivaldiData();
      const cPanel = cv?.isPanel || false;

      const cKey = cPanel ? 'enablePanel' : 'enableTab';
      const cEnabled = (cCfg.siteSettings[cHost] || {})[cKey] !== false;
      const nEnabled = !cEnabled;
      const nSettings = { ...cCfg.siteSettings, [cHost]: { ...(cCfg.siteSettings[cHost] || {}), [cKey]: nEnabled } };

      // Optimistic UI update
      el.className = `betterautopip-floating-toggle ${nEnabled ? 'enabled' : 'disabled'}`;
      el.querySelector('.betterautopip-floating-toggle-status').textContent = nEnabled ? 'ON' : 'OFF';

      await chrome.storage.sync.set({ siteSettings: nSettings });

      if (cKey === 'enableTab') {
        nEnabled ? registerMediaSessionHandler() : unregisterMediaSessionHandler();
      }
      el.style.transform = 'scale(1.1)';
      setTimeout(() => el.style.transform = '', 200);
    });

    document.body.appendChild(el);
    state.floatingToggle = el;
  }

  const STYLES_ID = "betterautopip-style";
  function injectStylesOnce() {
    if (document.getElementById(STYLES_ID)) return;
    const style = document.createElement("style");
    style.id = STYLES_ID;
    // Minified CSS
    style.textContent = `.betterautopip-toast{position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:10px 12px;border-radius:10px;font:13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:rgba(30,30,30,.92);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer;user-select:none;max-width:320px}.betterautopip-toast:hover{filter:brightness(1.05)}.betterautopip-banner{position:fixed;z-index:2147483646;top:0;left:0;right:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.15);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;animation:betterautopip-slide-down .3s ease-out}@keyframes betterautopip-slide-down{from{transform:translateY(-100%)}to{transform:translateY(0)}}.betterautopip-banner-content{display:flex;align-items:center;gap:12px;padding:14px 20px;max-width:1200px;margin:0 auto}.betterautopip-banner-icon{font-size:24px;line-height:1;flex-shrink:0}.betterautopip-banner-text{flex:1}.betterautopip-banner-text strong{display:block;font-size:15px;margin-bottom:4px}.betterautopip-banner-text p{margin:0;opacity:.95;font-size:13px}.betterautopip-banner-close{background:rgba(255,255,255,.2);border:none;color:#fff;font-size:24px;line-height:1;width:32px;height:32px;border-radius:50%;cursor:pointer;flex-shrink:0;transition:background .2s}.betterautopip-banner-close:hover{background:rgba(255,255,255,.3)}.betterautopip-floating-toggle{position:fixed;z-index:2147483645;bottom:20px;left:20px;display:flex;align-items:center;gap:10px;padding:10px 16px;background:rgba(30,30,30,.95);backdrop-filter:blur(10px);border-radius:24px;box-shadow:0 4px 16px rgba(0,0,0,.3);font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fff;cursor:pointer;user-select:none;transition:all .3s ease;opacity:.7;animation:betterautopip-float-in .4s ease-out}.betterautopip-floating-toggle:hover{opacity:1;transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.4)}.betterautopip-floating-toggle-icon{width:24px;height:24px;flex-shrink:0;display:flex;align-items:center;justify-content:center;position:relative}.betterautopip-floating-toggle-icon svg{width:100%;height:100%;display:block;color:#fff}.betterautopip-floating-toggle-icon::after{content:'';position:absolute;top:50%;left:-2px;right:-2px;height:2px;background:#ff4444;transform:translateY(-50%) rotate(-45deg);opacity:0;transition:opacity .2s}.betterautopip-floating-toggle.disabled .betterautopip-floating-toggle-icon::after{opacity:1}.betterautopip-floating-toggle-text{font-weight:500;white-space:nowrap}.betterautopip-floating-toggle-status{font-size:11px;opacity:.8;margin-left:4px}.betterautopip-floating-toggle.enabled{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}.betterautopip-floating-toggle.disabled{background:rgba(80,80,80,.95)}@keyframes betterautopip-float-in{from{opacity:0;transform:translateY(20px)}to{opacity:.7;transform:translateY(0)}}`;
    (document.head || document.documentElement).appendChild(style);
  }

  async function loadConfig() {
    const t = now();
    if (state.cachedConfig && t - state.cachedConfigTs < 5000) return state.cachedConfig;
    if (!isExtensionValid()) return DEFAULTS;
    try {
      const cfg = await chrome.storage.sync.get(DEFAULTS);
      const m = { ...DEFAULTS, ...cfg };
      if (!m.siteSettings || typeof m.siteSettings !== "object") m.siteSettings = {};
      delete m.siteEnabled;
      delete m.enableTabSwitch;
      delete m.enablePanelCollapse;
      state.cachedConfig = m;
      state.cachedConfigTs = t;
      return m;
    } catch {
      return DEFAULTS;
    }
  }

  function isSiteEnabled(cfg, feature) {
    const key = hostKey();
    if (!key) return true;
    const s = cfg.siteSettings?.[key];
    if (!s) return true;
    return feature === 'tab' ? s.enableTab !== false : s.enablePanel !== false;
  }

  async function tick() {
    if (!isExtensionValid()) return;
    if (!isVivaldi()) return;
    const cfg = await loadConfig();
    if (!cfg.enabled || !isSiteEnabled(cfg, 'panel')) return;
    injectStylesOnce();
    const collapsed = isCollapsed(cfg);
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(async () => {
      if (!isExtensionValid()) return;
      if (collapsed && !state.lastCollapsed) {
        state.lastCollapsed = true;
        await tryEnterPiP(cfg, "collapse");
      }
      if (!collapsed && state.lastCollapsed) {
        state.lastCollapsed = false;
        hideToast();
        await maybeExitPiP(cfg);
      }
    }, cfg.debounceMs);
  }

  function trackUserInteraction() {
    state.lastUserInteraction = now();
  }

  function hookViewportEvents() {
    ['mousedown', 'keydown', 'touchstart', 'click'].forEach(e => document.addEventListener(e, trackUserInteraction, { passive: true, capture: true }));
    if (isVivaldi()) {
      window.visualViewport?.addEventListener("resize", tick, { passive: true });
      window.addEventListener("resize", tick, { passive: true });
      document.addEventListener("fullscreenchange", tick, { passive: true });
      setInterval(async () => {
        const { w, h } = getViewportSize();
        const key = `${w}x${h}`;
        if (state.lastViewportKey !== key) {
          state.lastViewportKey = key;
          tick();
        }
      }, 500);
    }
    document.addEventListener("visibilitychange", handleVisibilityChange, { passive: true });
    document.addEventListener("enterpictureinpicture", () => state.isInPiP = true, { passive: true });
    document.addEventListener("leavepictureinpicture", () => state.isInPiP = false, { passive: true });
  }

  async function handleVisibilityChange() {
    if (!isExtensionValid()) return;
    const cfg = await loadConfig();
    if (!cfg.enabled) return;
    const curr = document.visibilityState;
    if (curr === "hidden" && state.lastVisibilityState === "visible") {
      if (isSiteEnabled(cfg, 'tab')) {
        const d = cfg.tabSwitchDelay;
        if (state.mediaSessionHandlerRegistered) {
          setTimeout(async () => {
            if (!document.pictureInPictureElement && !state.isInPiP) await tryEnterPiP(cfg, "tabSwitch");
          }, d + 200);
        } else {
          setTimeout(() => tryEnterPiP(cfg, "tabSwitch"), d);
        }
      }
    }
    if (curr === "visible" && state.lastVisibilityState === "hidden") {
      if (cfg.exitOnExpand) await maybeExitPiP(cfg);
    }
    state.lastVisibilityState = curr;
    tick();
  }

  chrome.runtime.onMessage.addListener((m, s, r) => {
    if (m.action === "ping") { r({ pong: true }); return false; }
    if (m.action === "tryPiP") {
      loadConfig().then(c => tryEnterPiP(c, m.reason || "background"));
      r({ success: true });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      state.cachedConfig = null;
      updateFloatingToggle();
    }
  });

  function setupVideoObserver() {
    const o = new MutationObserver((mutations) => {
      let added = false;
      for (let i = 0; i < mutations.length; i++) {
        const nodes = mutations[i].addedNodes;
        for (let j = 0; j < nodes.length; j++) {
          const n = nodes[j];
          if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.querySelector?.('video'))) {
            added = true;
            break;
          }
        }
        if (added) break;
      }
      if (added) {
        state.cachedVideosTs = 0;
        setTimeout(tick, 500);
        setTimeout(registerMediaSessionHandler, 600);
      }
    });
    o.observe(document.documentElement, { childList: true, subtree: true });
  }

  function initYouTube() {
    if (!location.host.includes("youtube.com")) return;
    const chk = () => {
      const v = document.querySelector("#movie_player video, .html5-video-player video");
      if (v) { }
    };
    chk(); setTimeout(chk, 1000); setTimeout(chk, 2000);
    document.addEventListener("yt-navigate-finish", () => {
      state.cachedVideosTs = 0;
      setTimeout(tick, 1000);
    }, { passive: true });
  }

  (async function init() {
    state.supportsAutoPiP = checkAutoPiPSupport();
    hookViewportEvents();
    setupVideoObserver();
    initYouTube();
    tick();
    tick();
    setTimeout(updateFloatingToggle, 2000);
    setTimeout(tick, 2000);
    setTimeout(tick, 2000);
    setTimeout(registerMediaSessionHandler, 1000);
  })();
})();
