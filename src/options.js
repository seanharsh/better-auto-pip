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
  customSites: []
};

const PIP_SITES = BAPCustomSites.BUILTIN_HOSTS;

function $(id) { return document.getElementById(id); }

async function isVivaldi() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "isVivaldi" });
    return res && res.isVivaldi;
  } catch {
    return false;
  }
}

function renderSites(cfg, showPanel) {
  const wrap = $("sites");
  wrap.textContent = ""; // Fast clear

  const hosts = new Set(PIP_SITES);
  for (const h of BAPCustomSites.sanitizeList(cfg.customSites)) hosts.add(h);
  if (cfg.siteSettings) {
    for (const k in cfg.siteSettings) hosts.add(k);
  }

  const frag = document.createDocumentFragment();
  const table = document.createElement("table");
  table.className = "site-table";

  const thead = document.createElement("thead");
  // Use simple string concat for static header
  thead.innerHTML = `<tr><th>Site</th><th>Tab Switching</th>${showPanel ? '<th class="panel-column">Panel Collapse</th>' : ''}</tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const host of hosts) {
    const s = (cfg.siteSettings && cfg.siteSettings[host]) || { enableTab: true, enablePanel: true };
    const row = document.createElement("tr");

    const tdSite = document.createElement("td");
    tdSite.textContent = host;
    row.appendChild(tdSite);

    // Tab
    const tdTab = document.createElement("td");
    const cbTab = document.createElement("input");
    cbTab.type = "checkbox";
    cbTab.dataset.h = host; // Short attr
    cbTab.dataset.s = "t";  // t = tab
    cbTab.checked = s.enableTab !== false;
    tdTab.appendChild(cbTab);
    row.appendChild(tdTab);

    // Panel
    if (showPanel) {
      const tdPanel = document.createElement("td");
      tdPanel.className = "panel-column";
      const cbPanel = document.createElement("input");
      cbPanel.type = "checkbox";
      cbPanel.dataset.h = host;
      cbPanel.dataset.s = "p"; // p = panel
      cbPanel.checked = s.enablePanel !== false;
      tdPanel.appendChild(cbPanel);
      row.appendChild(tdPanel);
    }
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  frag.appendChild(table);
  wrap.appendChild(frag);
}

const SITE_ERRORS = {
  invalid: "That doesn't look like a website. Enter a name like example.com or paste a page address.",
  duplicate: "That site is already in your list.",
  builtin: "That site is already supported, no need to add it.",
  limit: `You can add up to ${BAPCustomSites.MAX_CUSTOM_SITES} custom sites.`
};

function renderCustomSites(list) {
  const wrap = $("customSites");
  wrap.textContent = "";
  for (const host of BAPCustomSites.sanitizeList(list)) {
    const row = document.createElement("div");
    row.className = "custom-site-row";
    row.dataset.customSite = host;
    const name = document.createElement("span");
    name.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "remove-site";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => removeSite(host));
    row.append(name, btn);
    wrap.appendChild(row);
  }
}

async function syncBackground() {
  try { await chrome.runtime.sendMessage({ action: "syncCustomSites" }); } catch { /* worker will sync on its own events */ }
}

async function addSite() {
  const err = $("customSiteError");
  err.textContent = "";
  const { customSites } = await chrome.storage.sync.get({ customSites: [] });
  const r = BAPCustomSites.addCustomSite(BAPCustomSites.sanitizeList(customSites), $("customSiteInput").value);
  if (!r.ok) { err.textContent = SITE_ERRORS[r.error] || SITE_ERRORS.invalid; return; }
  let granted = false;
  try {
    // Needs a user gesture (this runs from the button click). Shows the browser's own permission prompt.
    granted = await chrome.permissions.request({ origins: BAPCustomSites.toMatchPatterns(r.host) });
  } catch (e) {
    err.textContent = "Couldn't ask for permission: " + (e && e.message ? e.message : e);
    return;
  }
  if (!granted) { err.textContent = "Access wasn't allowed, so the site wasn't added."; return; }
  await chrome.storage.sync.set({ customSites: r.list });
  await syncBackground();
  $("customSiteInput").value = "";
  await load();
}

async function removeSite(host) {
  const { customSites, siteSettings } = await chrome.storage.sync.get({ customSites: [], siteSettings: {} });
  const settings = { ...siteSettings };
  delete settings[host];
  await chrome.storage.sync.set({ customSites: BAPCustomSites.removeCustomSite(BAPCustomSites.sanitizeList(customSites), host), siteSettings: settings });
  try { await chrome.permissions.remove({ origins: BAPCustomSites.toMatchPatterns(host) }); } catch { /* built-in grants can't be removed */ }
  await syncBackground();
  await load();
}

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  const isV = await isVivaldi();

  $("enabled").checked = !!cfg.enabled;
  $("collapseWidthPx").value = cfg.collapseWidthPx;
  $("collapseHeightPx").value = cfg.collapseHeightPx;
  $("debounceMs").value = cfg.debounceMs;
  $("armMinutes").value = cfg.armMinutes;
  $("exitOnExpand").checked = !!cfg.exitOnExpand;
  $("showFloatingButton").checked = cfg.showFloatingButton !== false;
  $("showBlockAlerts").checked = cfg.showBlockAlerts !== false;
  $("tabSwitchDelay").value = cfg.tabSwitchDelay;

  const ps = $("panelSection");
  if (ps) ps.style.display = isV ? "block" : "none";

  renderCustomSites(cfg.customSites);
  renderSites(cfg, isV);
}

const save = async () => {
  const cfg = {
    enabled: $("enabled").checked,
    collapseWidthPx: +$("collapseWidthPx").value,
    collapseHeightPx: +$("collapseHeightPx").value,
    debounceMs: +$("debounceMs").value,
    armMinutes: +$("armMinutes").value,
    exitOnExpand: $("exitOnExpand").checked,
    showFloatingButton: $("showFloatingButton").checked,
    showBlockAlerts: $("showBlockAlerts").checked,
    tabSwitchDelay: +$("tabSwitchDelay").value,
    siteSettings: {}
  };

  // Efficient O(N) gather
  // Use getElementsByTagName for speed vs querySelectorAll
  const inputs = $("sites").getElementsByTagName("input");
  for (let i = 0, l = inputs.length; i < l; i++) {
    const el = inputs[i];
    const h = el.dataset.h;
    const s = el.dataset.s;
    if (!h) continue;

    // Ensure object exists
    if (!cfg.siteSettings[h]) cfg.siteSettings[h] = { enableTab: true, enablePanel: true };

    if (s === "t") cfg.siteSettings[h].enableTab = el.checked;
    else if (s === "p") cfg.siteSettings[h].enablePanel = el.checked;
  }

  await chrome.storage.sync.set(cfg);

  const st = $("status");
  st.textContent = "Saved.";
  setTimeout(() => st.textContent = "", 1200);
};

let timer;
const debouncedSave = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(save, 500);
};

// Event Delegation (Single listener)
document.addEventListener("change", (e) => {
  if (e.target.tagName === "INPUT") debouncedSave();
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.tagName === "INPUT" && (t.type === "number" || t.type === "text")) debouncedSave();
});

$("addSiteButton").addEventListener("click", addSite);
$("customSiteInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSite(); } });

load();

