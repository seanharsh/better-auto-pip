// Custom sites: helpers shared by the options page (<script>) and the background service worker (importScripts).
// Keep this file free of DOM / chrome.* calls so it can be unit-tested in plain Node.
(function (root) {
  const BUILTIN_HOSTS = [
    "app.plex.tv", "teams.microsoft.com", "meet.google.com", "www.twitch.tv", "player.twitch.tv", "www.netflix.com",
    "www.espn.com", "www.youtube.com", "www.hulu.com", "vimeo.com", "www.dailymotion.com", "www.crunchyroll.com"
  ];
  const MAX_CUSTOM_SITES = 100;
  const ALL_SITES_PATTERN = "*://*/*";          // the single optional host permission behind the "Allow on all sites" switch
  const ALL_SITES_SCRIPT_ID = "bap-all-sites";
  const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

  const isIPv4 = (h) => { const m = IPV4.exec(h); return !!m && m.slice(1).every((o) => +o <= 255); };

  // "https://Www.Example.com:8443/watch?v=1" | "example.com/path" | "localhost:3000" -> "www.example.com" ; anything else -> null
  function normalizeHost(input) {
    if (typeof input !== "string") return null;
    let s = input.trim();
    if (!s || /\s/.test(s)) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (!/^https?:\/\//i.test(s)) return null;                 // only web pages: no file:, ftp:, chrome: ...
      s = s.replace(/^https?:\/\//i, "");
    } else if (/^[a-z][a-z0-9+.-]*:(?!\d+(\/|$|\?|#))/i.test(s)) {
      return null;                                               // javascript:, mailto:, ... (but allow host:port)
    }
    s = s.split(/[\/?#]/)[0];
    const pm = /^(.*):(\d{1,5})$/.exec(s);                       // strip :port
    if (pm) s = pm[1];
    if (!s || s.includes("@") || s.includes("*") || s.includes("[")) return null;
    let host;
    try { host = new URL("http://" + s).hostname; } catch { return null; }   // lowercases and converts IDN to punycode
    host = host.replace(/\.$/, "");
    if (!host || host.length > 253) return null;
    if (isIPv4(host)) return host;
    if (/^[\d.]+$/.test(host)) return null;                      // malformed IPv4
    const labels = host.split(".");
    if (labels.length < 2 && host !== "localhost") return null;
    if (!labels.every((l) => l.length >= 1 && l.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return null;
    return host;
  }

  // Host (and its subdomains) on http and https. IP addresses can't have wildcard subdomains.
  function toMatchPatterns(host) {
    return isIPv4(host) ? [`*://${host}/*`] : [`*://${host}/*`, `*://*.${host}/*`];
  }

  function addCustomSite(list, input) {
    const host = normalizeHost(input);
    if (!host) return { ok: false, error: "invalid" };
    if (BUILTIN_HOSTS.includes(host)) return { ok: false, error: "builtin" };
    if ((list || []).includes(host)) return { ok: false, error: "duplicate" };
    if ((list || []).length >= MAX_CUSTOM_SITES) return { ok: false, error: "limit" };
    return { ok: true, host, list: [...(list || []), host] };
  }

  const removeCustomSite = (list, host) => (list || []).filter((h) => h !== host);

  // Whatever is in storage (could be edited, synced from another version...) -> clean, unique, valid hosts.
  function sanitizeList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const x of raw) { const h = normalizeHost(x); if (h && !out.includes(h)) out.push(h); }
    return out.slice(0, MAX_CUSTOM_SITES);
  }

  root.BAPCustomSites = { BUILTIN_HOSTS, MAX_CUSTOM_SITES, ALL_SITES_PATTERN, ALL_SITES_SCRIPT_ID, normalizeHost, toMatchPatterns, addCustomSite, removeCustomSite, sanitizeList };
})(typeof globalThis !== "undefined" ? globalThis : self);
