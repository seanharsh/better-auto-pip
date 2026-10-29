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
    showBlockAlerts: true,
    autoPipPromptOff: {}
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
    autoPiPCalledThisHide: false,
    pendingSetupPrompt: false,
    supportsAutoPiP: false,
    cachedVideos: null,
    cachedVideosTs: 0,
    cachedViewport: null,
    cachedViewportTs: 0,
    cachedConfig: null,
    cachedConfigTs: 0
  };

  const IS_TOP = (() => { try { return window === window.top; } catch { return false; } })();
  // Mirror: sender side (in an embedded player frame) or receiver side (in the top frame).
  const mirror = { pc: null, source: null, video: null, fromFrame: null, pending: false, lastTry: 0 };

  function isExtensionValid() {
    try {
      return !!(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isVivaldi() {
    if (cachedVivaldi && typeof cachedVivaldi.isVivaldi === "boolean") return cachedVivaldi.isVivaldi;
    return !!(window.vivaldi) || navigator.userAgent.includes("Vivaldi") || (navigator.vendor && navigator.vendor.includes("Vivaldi"));
  }

  const DEBUG = true;
  const log = (...args) => {
    if (!DEBUG) return;
    if (!isExtensionValid()) return;
    console.log("[BetterAutoPiP]", ...args);
  };

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
    log(`Armed for ${minutes} minutes`);
  }

  function checkAutoPiPSupport() {
    try {
      if (!navigator.mediaSession) {
        log("MediaSession API not available");
        return false;
      }
      try {
        navigator.mediaSession.setActionHandler("enterpictureinpicture", null);
        log("MediaSession enterpictureinpicture action supported");
        return true;
      } catch {
        log("MediaSession enterpictureinpicture action not supported");
        return false;
      }
    } catch (e) {
      log("Error checking MediaSession support:", e?.message);
      return false;
    }
  }

  async function registerMediaSessionHandler() {
    if (state.mediaSessionHandlerRegistered || !state.supportsAutoPiP) {
      log(`MediaSession handler skip: registered=${state.mediaSessionHandlerRegistered}, supported=${state.supportsAutoPiP}`);
      return;
    }
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled || !isSiteEnabled(cfg, "tab")) {
        log("MediaSession handler not registered: extension disabled or site not enabled for tab");
        return;
      }

      navigator.mediaSession.setActionHandler("enterpictureinpicture", async () => {
        log("MediaSession enterpictureinpicture action triggered");
        state.autoPiPCalledThisHide = true;
        const currentCfg = await loadConfig();
        if (!currentCfg.enabled || !isSiteEnabled(currentCfg, "tab")) {
          log("MediaSession PiP ignored: disabled");
          return;
        }

        const video = pickPiPVideo();
        if (!video) {
          log("MediaSession PiP: no video found");
          return;
        }
        if (document.pictureInPictureElement) {
          log("MediaSession PiP: already in PiP");
          return;
        }

        const delay = Math.min(Math.max(+currentCfg.tabSwitchDelay || 0, 0), 4000);
        if (delay > 0) {
          log(`MediaSession PiP: honoring tabSwitchDelay ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          if (document.pictureInPictureElement) return;
        }

        try {
          await video.requestPictureInPicture();
          state.isInPiP = true;
          state.tabSwitchFailCount = 0;
          hideToast();
          hideBanner();
          log("Entered PiP via MediaSession API");
          if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipEntered", reason: "mediaSession" });
        } catch (e) {
          log("MediaSession PiP request failed:", e?.name, e?.message);
        }
      });

      state.mediaSessionHandlerRegistered = true;
      log("MediaSession handler registered");
    } catch (e) {
      log("Failed to register MediaSession handler:", e?.message);
    }
  }

  function unregisterMediaSessionHandler() {
    if (!state.mediaSessionHandlerRegistered) return;
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture", null);
      state.mediaSessionHandlerRegistered = false;
      log("MediaSession handler unregistered");
    } catch (e) {
      log("Failed to unregister MediaSession handler:", e?.message);
    }
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
      if (window.name && window.name.startsWith('vivaldi-webpanel-')) {
        log("Panel detected via window.name");
        return true;
      }
      if (window.location.href.includes('vivaldi://webpanel') || window.location.href.includes('vivaldi-webpanel')) {
        log("Panel detected via URL");
        return true;
      }
      const screenW = window.screen.width;
      const isPanel = window === window.top && window.opener === null && w < (screenW * 0.6) && (h / w) > 1.2;
      if (isPanel) {
        log(`Panel detected via heuristic: w=${w}, screenW=${screenW}, h=${h}, aspect=${(h/w).toFixed(2)}`);
      }
      return isPanel;
    } catch (e) {
      log("Panel detection error:", e?.message);
      return false;
    }
  }

  function isCollapsed(cfg) {
    const { w, h } = getViewportSize();
    const collapsed = (w > 0 && w <= cfg.collapseWidthPx) || (h > 0 && h <= cfg.collapseHeightPx);
    if (collapsed) {
      log(`Collapse detected: w=${w}, h=${h}, thresholds: w<=${cfg.collapseWidthPx}, h<=${cfg.collapseHeightPx}`);
    }
    return collapsed;
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

  // querySelectorAll that also descends into open shadow roots (web-component players).
  function queryAllDeep(root, selector, out = []) {
    const found = root.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) out.push(found[i]);
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const sr = all[i].shadowRoot;
      if (sr) queryAllDeep(sr, selector, out);
    }
    return out;
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
    queryAllDeep(document, "video", videos);
    const mi = videos.indexOf(mirror.video);
    if (mi >= 0) videos.splice(mi, 1);

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
            const iVideos = queryAllDeep(iframeDoc, "video");
            for (let j = 0; j < iVideos.length; j++) videos.push(iVideos[j]);
            if (iVideos.length > 0) {
              log(`Found ${iVideos.length} video(s) in iframe`);
            }
          }
        } catch { }
      }
    } catch (e) {
      log("Error checking iframes:", e?.message);
    }

    state.cachedVideos = videos;
    state.cachedVideosTs = t;
    log(`Total videos found: ${videos.length}`);

    if (videos.length === 0) {
      log("No video elements found");
      return null;
    }

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

    const selected = best || fallback || videos[0];
    if (selected) {
      log(`Selected video: paused=${selected.paused}, readyState=${selected.readyState}, duration=${selected.duration}`);
    }
    return selected;
  }

  async function tryEnterPiP(cfg, reason = "unknown") {
    // Without a fresh click in this frame the request can only fail; the top frame's mirror handles PiP instead (no banner here).
    if (!IS_TOP && mirror.pc && reason === "tabSwitch" && !navigator.userActivation?.isActive) {
      log("Tab switch: video is mirrored to the top frame, which handles PiP");
      return;
    }
    const t = now();
    if (t - state.lastAttemptTs < 1500) {
      log(`PiP attempt throttled (reason: ${reason})`);
      return;
    }
    state.lastAttemptTs = t;

    const video = pickPiPVideo();
    if (!video) {
      log(`PiP attempt failed: no video found (reason: ${reason})`);
      return;
    }
    if (document.pictureInPictureElement) {
      log(`PiP attempt skipped: already in PiP (reason: ${reason})`);
      return;
    }

    const armed = t < state.armedUntil;
    const timeSinceInteraction = t - state.lastUserInteraction;
    const hasRecentInteraction = timeSinceInteraction < 5000;

    log(`Attempting PiP (reason: ${reason}, armed: ${armed}, recentInteraction: ${hasRecentInteraction}, timeSinceInteraction: ${Math.round(timeSinceInteraction/1000)}s, failCount: ${state.tabSwitchFailCount})`);

    if (reason === "tabSwitch" && !armed && !hasRecentInteraction && timeSinceInteraction > 10000) {
      log("Tab switch without recent interaction - waiting briefly...");
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
      await video.requestPictureInPicture();
      state.isInPiP = true;
      state.tabSwitchFailCount = 0;
      hideToast();
      hideBanner();
      log("Entered PiP successfully");
      if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipEntered", reason });
    } catch (e) {
      log(`PiP request failed: ${e?.name} - ${e?.message}`);
      if (e?.name === "NotAllowedError" || e?.message?.includes("gesture")) {
        if (reason === "tabSwitch" && IS_TOP && state.mediaSessionHandlerRegistered && !state.autoPiPCalledThisHide) {
          // The browser had our handler and did not call it: its auto-PiP is held back for this site (not enough watch
          // history and no "Automatic picture-in-picture: Allow"). Clicking the page would not help; explain the setting on return.
          if (cfg.showBlockAlerts !== false && !(cfg.autoPipPromptOff || {})[hostKey()]) {
            log("Browser auto-PiP held back for this site - will show the setup prompt on return");
            state.pendingSetupPrompt = true;
          }
        } else if (reason === "tabSwitch") {
          state.tabSwitchFailCount++;
          log(`Tab switch failure #${state.tabSwitchFailCount}: armed=${armed}, timeSinceInteraction=${Math.round(timeSinceInteraction/1000)}s`);
          if (state.tabSwitchFailCount === 1 && now() >= state.armedUntil) {
            if (cfg.showBlockAlerts !== false) {
              log("First tab switch PiP failure - showing notification banner");
              showInteractionBanner(cfg, "tab");
            }
          }
        } else {
          if (cfg.showBlockAlerts !== false) {
            log("Panel/collapse PiP failure - showing notification banner");
            showInteractionBanner(cfg, "panel");
          }
        }
      }
    }
  }

  async function maybeExitPiP(cfg) {
    log(`maybeExitPiP called: exitOnExpand=${cfg.exitOnExpand}, inPiP=${!!document.pictureInPictureElement}`);
    if (!cfg.exitOnExpand) {
      log("exitOnExpand disabled, not exiting PiP");
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        state.isInPiP = false;
        log("Exited PiP");
        if (chrome.runtime?.id) chrome.runtime.sendMessage({ action: "pipExited" });
      }
    } catch (e) {
      log("Failed to exit PiP:", e?.message);
    }
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

  // The browser decides per site whether it may pop a video out on its own, and extensions cannot change that setting.
  // So: name the setting, and open this site's settings page on request.
  function showSetupPrompt(cfg) {
    hideBanner();
    injectStylesOnce();
    const host = hostKey();
    const el = document.createElement("div");
    el.className = "betterautopip-banner betterautopip-setup";
    el.innerHTML = `<div class="betterautopip-banner-content"><div class="betterautopip-banner-icon">&#9432;</div><div class="betterautopip-banner-text"><strong>Automatic Picture-in-Picture is off for <span class="betterautopip-setup-host"></span></strong><p>Your browser only pops videos out by itself on sites you allow. Click <b>Allow for this site</b>, then set <b>Automatic picture-in-picture</b> to <b>Allow</b> on the page that opens.</p></div><div class="betterautopip-setup-actions"><button data-bap-action="open-settings">Allow for this site</button><button data-bap-action="never">Don't ask again</button></div><button class="betterautopip-banner-close" data-bap-action="close">&times;</button></div>`;
    el.querySelector(".betterautopip-setup-host").textContent = host;
    const on = (sel, fn) => el.querySelector(sel).addEventListener("click", (e) => { e.stopPropagation(); hideBanner(); if (isExtensionValid()) fn(); });
    on('[data-bap-action="open-settings"]', () => chrome.runtime.sendMessage({ action: "openAutoPipSettings" }).catch(() => { }));
    on('[data-bap-action="never"]', async () => {
      const c = await loadConfig();
      await chrome.storage.sync.set({ autoPipPromptOff: { ...(c.autoPipPromptOff || {}), [host]: true } });
      log(`Setup prompt turned off for ${host}`);
    });
    on(".betterautopip-banner-close", () => { });
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
    if (!IS_TOP) return;
    if (!document.body) return setTimeout(updateFloatingToggle, 500);
    const cfg = await loadConfig();

    if (cfg.showFloatingButton === false) {
      if (state.floatingToggle) {
        state.floatingToggle.remove();
        state.floatingToggle = null;
        log("Floating toggle removed (disabled in config)");
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
    log(`Creating floating toggle: host=${host}, isPanel=${isPanel}, enabled=${isEnabled}`);

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
      log(`Floating toggle clicked: ${cKey} ${cEnabled} -> ${nEnabled} for ${cHost}`);
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
    style.textContent = `.betterautopip-toast{position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:10px 12px;border-radius:10px;font:13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:rgba(30,30,30,.92);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer;user-select:none;max-width:320px}.betterautopip-toast:hover{filter:brightness(1.05)}.betterautopip-banner{position:fixed;z-index:2147483646;top:0;left:0;right:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.15);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;animation:betterautopip-slide-down .3s ease-out}@keyframes betterautopip-slide-down{from{transform:translateY(-100%)}to{transform:translateY(0)}}.betterautopip-banner-content{display:flex;align-items:center;gap:12px;padding:14px 20px;max-width:1200px;margin:0 auto}.betterautopip-banner-icon{font-size:24px;line-height:1;flex-shrink:0}.betterautopip-banner-text{flex:1}.betterautopip-banner-text strong{display:block;font-size:15px;margin-bottom:4px}.betterautopip-banner-text p{margin:0;opacity:.95;font-size:13px}.betterautopip-banner-close{background:rgba(255,255,255,.2);border:none;color:#fff;font-size:24px;line-height:1;width:32px;height:32px;border-radius:50%;cursor:pointer;flex-shrink:0;transition:background .2s}.betterautopip-banner-close:hover{background:rgba(255,255,255,.3)}.betterautopip-setup-actions{display:flex;gap:8px;flex-shrink:0}.betterautopip-setup-actions button{background:#fff;color:#4b3c9a;border:none;border-radius:16px;padding:7px 14px;font:600 13px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;cursor:pointer}.betterautopip-setup-actions button[data-bap-action=never]{background:rgba(255,255,255,.2);color:#fff}.betterautopip-floating-toggle{position:fixed;z-index:2147483645;bottom:20px;left:20px;display:flex;align-items:center;gap:10px;padding:10px 16px;background:rgba(30,30,30,.95);backdrop-filter:blur(10px);border-radius:24px;box-shadow:0 4px 16px rgba(0,0,0,.3);font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fff;cursor:pointer;user-select:none;transition:all .3s ease;opacity:.7;animation:betterautopip-float-in .4s ease-out}.betterautopip-floating-toggle:hover{opacity:1;transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.4)}.betterautopip-floating-toggle-icon{width:24px;height:24px;flex-shrink:0;display:flex;align-items:center;justify-content:center;position:relative}.betterautopip-floating-toggle-icon svg{width:100%;height:100%;display:block;color:#fff}.betterautopip-floating-toggle-icon::after{content:'';position:absolute;top:50%;left:-2px;right:-2px;height:2px;background:#ff4444;transform:translateY(-50%) rotate(-45deg);opacity:0;transition:opacity .2s}.betterautopip-floating-toggle.disabled .betterautopip-floating-toggle-icon::after{opacity:1}.betterautopip-floating-toggle-text{font-weight:500;white-space:nowrap}.betterautopip-floating-toggle-status{font-size:11px;opacity:.8;margin-left:4px}.betterautopip-floating-toggle.enabled{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}.betterautopip-floating-toggle.disabled{background:rgba(80,80,80,.95)}@keyframes betterautopip-float-in{from{opacity:0;transform:translateY(20px)}to{opacity:.7;transform:translateY(0)}}`;
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
    document.addEventListener("enterpictureinpicture", async () => {
      state.isInPiP = true;
      try {
        const cfg = await loadConfig();
        const hidden = document.visibilityState === "hidden";
        const context = hidden ? "tab" : "panel";
        const allowed = cfg.enabled && isSiteEnabled(cfg, context);
        if (!allowed) {
          log(`Auto-exiting PiP: extension disabled for ${context} on this site`);
          try { await document.exitPictureInPicture(); } catch (e) { log("exitPictureInPicture failed:", e?.message); }
        }
      } catch { }
    }, { passive: true });
    document.addEventListener("leavepictureinpicture", () => state.isInPiP = false, { passive: true });
  }

  async function handleVisibilityChange() {
    if (!isExtensionValid()) return;
    const cfg = await loadConfig();
    if (!cfg.enabled) return;
    const curr = document.visibilityState;
    const prev = state.lastVisibilityState;
    log(`Visibility changed: ${prev} -> ${curr}`);

    if (curr === "hidden" && prev === "visible") {
      if (isSiteEnabled(cfg, 'tab')) {
        const d = cfg.tabSwitchDelay;
        log(`Tab hidden, scheduling PiP attempt in ${d}ms (mediaSession: ${state.mediaSessionHandlerRegistered})`);
        if (state.mediaSessionHandlerRegistered) {
          setTimeout(async () => {
            if (!document.pictureInPictureElement && !state.isInPiP) await tryEnterPiP(cfg, "tabSwitch");
          }, d + 200);
        } else {
          setTimeout(() => tryEnterPiP(cfg, "tabSwitch"), d);
        }
      } else {
        log("Tab hidden but site not enabled for tab switching");
      }
    }
    if (curr === "visible" && prev === "hidden") {
      log("Tab visible again");
      if (cfg.exitOnExpand) await maybeExitPiP(cfg);
      if (state.pendingSetupPrompt) showSetupPrompt(cfg);
      // Reset here, not on hide: the browser may call the PiP handler before this frame sees visibilitychange.
      state.pendingSetupPrompt = false;
      state.autoPiPCalledThisHide = false;
    }
    state.lastVisibilityState = curr;
    tick();
  }

  // ---- Mirror: PiP for players inside cross-origin iframes ----
  // Browsers auto-PiP only the TOP frame's media session (Chromium: auto_picture_in_picture_tab_helper.cc), so a player inside an embedded
  // iframe never gets the call. The player frame streams a live copy of its video (captureStream -> RTCPeerConnection, signalled through the
  // background) to a hidden, muted <video> in the top frame, whose handler puts that copy in PiP. The sound stays with the original player.
  const MIRROR_MIN_W = 200, MIRROR_MIN_H = 112;

  function pickPiPVideo() {
    const real = getBestVideo();
    if (real && !real.paused && !real.ended) return real;
    if (IS_TOP && mirror.video && mirror.pc) return mirror.video;
    return real;
  }

  function waitIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((r) => {
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") r(); });
      setTimeout(r, 2000);
    });
  }

  function sendMirror(msg) {
    try { return chrome.runtime.sendMessage({ action: "mirror", ...msg }).catch(() => null); } catch { return Promise.resolve(null); }
  }

  // Sender (embedded player frame)
  function stopMirrorSender(why) {
    if (!mirror.pc) return;
    try { mirror.pc.close(); } catch { }
    mirror.pc = null;
    mirror.source = null;
    log(`Mirror stopped (${why})`);
    sendMirror({ type: "stop" });
  }

  async function checkMirrorSender() {
    if (IS_TOP || !isExtensionValid() || mirror.pending) return;
    const cfg = await loadConfig();
    if (!cfg.enabled) return stopMirrorSender("disabled");
    if (mirror.source && (!mirror.source.isConnected || mirror.source.ended)) stopMirrorSender("video gone");
    const v = getBestVideo();
    if (!v || v.paused || v.ended || v.readyState < 2 || v.clientWidth < MIRROR_MIN_W || v.clientHeight < MIRROR_MIN_H) return;
    if (mirror.source === v && mirror.pc && !["failed", "closed"].includes(mirror.pc.connectionState)) return;
    if (now() - mirror.lastTry < 5000) return;
    mirror.lastTry = now();
    mirror.pending = true;
    try {
      stopMirrorSender("restart");
      let stream = null;
      try { stream = v.captureStream ? v.captureStream() : null; } catch (e) { log("Mirror: captureStream failed:", e?.name, e?.message); }
      if (!stream || !stream.getVideoTracks().length) { log("Mirror: no capturable video track"); return; }
      const pc = new RTCPeerConnection();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc);
      const r = await sendMirror({ type: "offer", sdp: pc.localDescription.toJSON(), w: v.videoWidth, h: v.videoHeight });
      if (!r?.ok || !r.sdp) { pc.close(); log("Mirror: top frame did not answer (extension not running there?)"); return; }
      await pc.setRemoteDescription(r.sdp);
      mirror.pc = pc;
      mirror.source = v;
      v.addEventListener("play", () => sendMirror({ type: "state", paused: false }));
      v.addEventListener("pause", () => sendMirror({ type: "state", paused: true }));
      log(`Mirror started: ${v.videoWidth}x${v.videoHeight}, tracks=${stream.getTracks().map((t) => t.kind).join(",")}`);
    } catch (e) {
      log("Mirror: start failed:", e?.name, e?.message);
    } finally {
      mirror.pending = false;
    }
  }

  // Receiver (top frame)
  function setMirrorControls(on) {
    for (const a of ["play", "pause"]) {
      try {
        navigator.mediaSession.setActionHandler(a, on ? () => {
          sendMirror({ type: "control", op: a, toFrame: mirror.fromFrame });
          navigator.mediaSession.playbackState = a === "play" ? "playing" : "paused";
        } : null);
      } catch { }
    }
  }

  function stopMirrorReceiver() {
    if (!mirror.video && !mirror.pc) return;
    try { if (document.pictureInPictureElement === mirror.video) document.exitPictureInPicture().catch(() => { }); } catch { }
    try { mirror.pc?.close(); } catch { }
    mirror.video?.remove();
    mirror.pc = null;
    mirror.video = null;
    mirror.fromFrame = null;
    setMirrorControls(false);
    log("Mirror receiver stopped");
  }

  async function onMirrorOffer(m, respond) {
    stopMirrorReceiver();
    try {
      const pc = new RTCPeerConnection();
      const v = document.createElement("video");
      v.setAttribute("data-bap-mirror", "");
      v.muted = true;
      v.playsInline = true;
      v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1";
      pc.ontrack = (e) => {
        if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
        v.play().catch((err) => log("Mirror: play failed:", err?.name));
      };
      document.documentElement.appendChild(v);
      await pc.setRemoteDescription(m.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIce(pc);
      mirror.pc = pc;
      mirror.video = v;
      mirror.fromFrame = m.fromFrame;
      setMirrorControls(true);
      registerMediaSessionHandler();
      log(`Mirror receiving from frame ${m.fromFrame} (${m.w}x${m.h})`);
      respond({ ok: true, sdp: pc.localDescription.toJSON() });
    } catch (e) {
      log("Mirror: answer failed:", e?.name, e?.message);
      stopMirrorReceiver();
      respond({ ok: false });
    }
  }

  function handleMirrorMessage(m, respond) {
    if (IS_TOP && m.type === "offer") return onMirrorOffer(m, respond);
    if (IS_TOP && m.type === "stop" && m.fromFrame === mirror.fromFrame) stopMirrorReceiver();
    if (IS_TOP && m.type === "state" && m.fromFrame === mirror.fromFrame) {
      try { navigator.mediaSession.playbackState = m.paused ? "paused" : "playing"; } catch { }
    }
    if (!IS_TOP && m.type === "control" && mirror.source) {
      (m.op === "play" ? mirror.source.play() : Promise.resolve(mirror.source.pause())).catch((e) => log("Mirror control failed:", e?.name));
    }
    respond({ ok: true });
  }

  function setupMirrorSender() {
    if (IS_TOP) return;
    document.addEventListener("playing", () => setTimeout(checkMirrorSender, 300), { capture: true, passive: true });
    setInterval(checkMirrorSender, 3000);
  }

  chrome.runtime.onMessage.addListener((m, s, r) => {
    log(`Message received: action=${m.action}, reason=${m.reason}`);
    if (m.action === "ping") { r({ pong: true }); return false; }
    if (m.action === "mirror") { handleMirrorMessage(m, r); return true; }
    if (m.action === "tryPiP") {
      loadConfig().then(c => tryEnterPiP(c, m.reason || "background"));
      r({ success: true });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      log("Storage changed, invalidating config cache");
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
        log("New video element detected in DOM");
        state.cachedVideosTs = 0;
        setTimeout(tick, 500);
        setTimeout(registerMediaSessionHandler, 600);
      }
    });
    o.observe(document.documentElement, { childList: true, subtree: true });
    log("Video observer set up");
  }

  function initYouTube() {
    if (!location.host.includes("youtube.com")) return;
    log("YouTube detected, setting up YouTube-specific handlers");
    const chk = () => {
      const v = document.querySelector("#movie_player video, .html5-video-player video");
      if (v) {
        log("YouTube video player found");
      }
    };
    chk(); setTimeout(chk, 1000); setTimeout(chk, 2000);
    document.addEventListener("yt-navigate-finish", () => {
      log("YouTube navigation detected");
      state.cachedVideosTs = 0;
      setTimeout(tick, 1000);
    }, { passive: true });
  }

  (async function init() {
    log(`Content script initialized on ${location.host}`);
    await getVivaldiData().catch(() => { });
    log(`Vivaldi: ${isVivaldi()}, supportsAutoPiP: ${checkAutoPiPSupport()}`);
    state.supportsAutoPiP = checkAutoPiPSupport();
    hookViewportEvents();
    setupVideoObserver();
    setupMirrorSender();
    initYouTube();
    tick();
    tick();
    setTimeout(updateFloatingToggle, 2000);
    setTimeout(tick, 2000);
    setTimeout(tick, 2000);
    setTimeout(registerMediaSessionHandler, 1000);
  })();
})();
