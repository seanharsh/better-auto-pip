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

const PIP_SITES = [
  "app.plex.tv",
  "teams.microsoft.com",
  "meet.google.com",
  "www.twitch.tv",
  "player.twitch.tv",
  "www.netflix.com",
  "www.espn.com",
  "www.youtube.com",
  "www.hulu.com",
  "vimeo.com",
  "www.dailymotion.com",
  "www.crunchyroll.com"
];

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

load();

