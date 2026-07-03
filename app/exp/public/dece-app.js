/*
 * Main app circuitry
 */
globalThis.FS = globalThis.FS || {};
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const THEME_KEY = "dece-theme";
  const mqDark = globalThis.matchMedia("(prefers-color-scheme: dark)");

  function getPref() { return localStorage.getItem(THEME_KEY) || "system"; }
  function resolve(pref) { return pref === "system" ? (mqDark.matches ? "dark" : "light") : pref; }

  function applyTheme(pref, rebuild) {
    localStorage.setItem(THEME_KEY, pref);
    const root = document.documentElement;
    root.dataset.theme = pref;
    root.dataset.themeResolved = resolve(pref);
    $$("#theme-seg button").forEach(b =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === pref)));
    if (rebuild) FS.rebuildCharts();
  }

  $$("#theme-seg button").forEach(b =>
    b.addEventListener("click", () => applyTheme(b.dataset.theme, true)));
  mqDark.addEventListener("change", () => { if (getPref() === "system") applyTheme("system", true); });

  function setView(view) {
    $$("#view-seg button").forEach(b =>
      b.setAttribute("aria-selected", String(b.dataset.view === view)));
    $$("[data-view-pane]").forEach(p =>
      p.classList.toggle("active", p.dataset.viewPane === view));
    if (view === "dashboard") setTimeout(FS.resizeCharts, 30);
  }
  $$("#view-seg button").forEach(b =>
    b.addEventListener("click", () => setView(b.dataset.view)));

  const dock = $("#dock"), dockBtn = $("#dock-toggle");
  function setDock(open) {
    dock.classList.toggle("open", open);
    dockBtn.setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => $("#txt").focus(), 60);
  }
  dockBtn.addEventListener("click", () => setDock(!dock.classList.contains("open")));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && dock.classList.contains("open")) { setDock(false); dockBtn.focus(); }
  });

  function syncGates() {
    $("#minsim").disabled = !$("#minsim-en").checked;
    $("#mindot").disabled = !$("#mindot-en").checked;
  }

  function buildQuery() {
    const p = new URLSearchParams();
    const limit = $("#limit").value.trim();
    const minsim = $("#minsim").value.trim();
    const mindot = $("#mindot").value.trim();
    if (limit !== "") p.set("limit", limit);
    if ($("#minsim-en").checked && minsim !== "") p.set("min_similarity", minsim);
    if ($("#mindot-en").checked && mindot !== "") p.set("min_dot", mindot);
    if ($("#elbow").checked) p.set("elbow", "1");
    if ($("#strip-code").checked) p.set("strip_code", "1");
    if ($("#protect-shunts").checked) p.set("protect_shunts", "1");
    return p.toString();
  }

  function refreshUrl() {
    const qs = buildQuery();
    $("#urlprev").innerHTML = "POST <b>/api/v1/score" + (qs ? "?" + qs : "") + "</b>";
  }

  ["#limit", "#minsim", "#mindot", "#elbow", "#strip-code", "#protect-shunts"].forEach(s => $(s).addEventListener("input", refreshUrl));
  ["#minsim-en", "#mindot-en"].forEach(s =>
    $(s).addEventListener("change", () => { syncGates(); refreshUrl(); }));

  function status(msg, tone) {
    const el = $("#status");
    el.dataset.tone = tone || "";
    el.innerHTML = '<span class="dot"></span>' + msg;
  }

  async function score() {
    const text = $("#txt").value.trim();
    const btn = $("#score-btn");
    btn.disabled = true;
    status("scoring…", "busy");

    const qs = buildQuery();
    let rows = null;
    const t0 = performance.now();
    try {
      const r = await fetch("/score" + (qs ? "?" + qs : ""), { method: "POST", body: text });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const payload = await r.json();
      // scorer returns { results: [...] }; tolerate a bare array too
      rows = Array.isArray(payload) ? payload : payload && payload.results;
      if (!Array.isArray(rows)) throw new Error("unexpected payload");
    } catch (e) {
      // No fake data: this is a dev scope. Report the failure and stay blank.
      status("scorer unreachable · " + (e && e.message ? e.message : e), "err");
      btn.disabled = false;
      return;
    }
    const ms = Math.round(performance.now() - t0);

    const shaped = FS.shape(rows);
    FS._lastShaped = shaped;
    FS._lastMeta = { endpoint: "/score" + (qs ? "?" + qs : ""), scored_at: new Date().toISOString(), ms };
    FS.buildCharts(shaped);
    FS.buildTable(shaped);
    updateShuntStatus(shaped);
    updateIshuntStatus(shaped);
    const below = shaped.density.filter(d => d.pct < shaped.floor).length +
                  shaped.saturation.filter(s => s.pct < shaped.floor).length;
    const detected = shaped.shunt.filter(s => s.detect).length;
    status(
      "HTTP 200 · " +
      rows.length + " keys · " + ms + " ms · " + below + " below floor" +
      (detected ? " · ⚡ " + detected + " shunt trip" : ""),
      detected ? "err" : "ok");
    btn.disabled = false;
    setDock(false);
  }
  $("#score-btn").addEventListener("click", score);
  $("#txt").addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); score(); }
  });

  const MAX_UPLOAD = 8000; // bytes; larger files are rejected, not truncated
  $("#upload-btn").addEventListener("click", () => $("#upload-file").click());
  $("#upload-file").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (file.size > MAX_UPLOAD) {
      status("file too large · " + file.size + " bytes (max " + MAX_UPLOAD + ")", "err");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      $("#txt").value = reader.result;
      status("loaded " + file.name + " · " + file.size + " bytes", "ok");
    };
    reader.onerror = () => status("could not read " + file.name, "err");
    reader.readAsText(file);
  });

  function updateShuntStatus(shaped) {
    const el = $("#shunt-status");
    if (!el) return;
    const detected = shaped.shunt.filter(s => s.detect).length;
    if (detected) { el.dataset.tone = "trip"; el.textContent = "⚡ " + detected + " detected"; }
    else { el.dataset.tone = "quiet"; el.textContent = "all quiet"; }
  }

  // Intrinsic shunts may be absent entirely; report "none" so the empty plot
  // reads as intentional rather than broken.
  function updateIshuntStatus(shaped) {
    const el = $("#ishunt-status");
    if (!el) return;
    const list = shaped.ishunt || [];
    if (!list.length) { el.dataset.tone = "quiet"; el.textContent = "none loaded"; return; }
    const detected = list.filter(s => s.detect).length;
    if (detected) { el.dataset.tone = "trip"; el.textContent = "⚡ " + detected + " detected"; }
    else { el.dataset.tone = "quiet"; el.textContent = "all quiet"; }
  }

  const TYPE_BADGE = { density: "%", saturation: "@", gradation: "·", shunt: "⚡", ishunt: "⚡", outlook: "🧲", action: "⇅" };
  let tableRows = [], sortCol = "distance", sortDir = 1;

  FS.buildTable = function (shaped) {
    tableRows = shaped.parsed.slice();
    sortAndRender();
    $("#export-json").hidden = false;
  };

  // Tidy one parsed row into a tool-friendly record: stable field names, no
  // internal-only cruft (raw/prefix), shunt verdict only where it's meaningful.
  function exportRow(p) {
    const rec = {
      key: p.key, group: p.group, type: p.type, base: p.base, tier: p.tier,
      similarity: p.similarity, similarity_pct: p.pct,
      distance: p.distance, dotproduct: p.dotproduct,
    };
    if (p.type === "shunt") rec.detected = FS.isDetectable(p);
    else if (p.type === "ishunt") rec.detected = FS.isDetectableIntrinsic(p);
    return rec;
  }

  $("#export-json").addEventListener("click", e => {
    e.preventDefault();
    // Export in the table's current sort order so the file matches what's seen.
    const payload = {
      ...FS._lastMeta,
      count: tableRows.length,
      results: tableRows.map(exportRow),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dece-" + Date.now() + ".json";
    a.click();
    URL.revokeObjectURL(url);
  });

  function sortAndRender() {
    const dir = sortDir;
    tableRows.sort((a, b) => {
      let va, vb;
      if (sortCol === "key") { va = a.key; vb = b.key; return va.localeCompare(vb) * dir; }
      if (sortCol === "group") { va = a.group; vb = b.group; return va.localeCompare(vb) * dir; }
      // null dot products (legacy payloads) always sort to the bottom.
      va = a[sortCol]; vb = b[sortCol];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
    const tb = $("#raw-body");
    tb.innerHTML = tableRows.map(p => {
      const below = (p.type === "density" || p.type === "saturation") && p.pct < FS.FLOOR;
      const tripped = (p.type === "shunt" && FS.isDetectable(p)) ||
                      (p.type === "ishunt" && FS.isDetectableIntrinsic(p));
      const col = "var(--" + p.group + ")";
      return `<tr class="${below ? "below" : ""}${tripped ? " tripped" : ""}">
        <td class="key"><span class="kbadge" style="background:${col}" title="${p.type}">${TYPE_BADGE[p.type]}</span>${p.key}</td>
        <td><span class="swatch" style="background:${col}"></span>${FS.GROUPS[p.group].short}</td>
        <td>${p.similarity.toFixed(6)}</td>
        <td class="pct-cell">${p.distance.toFixed(5)}</td>
        <td class="pct-cell">${p.dotproduct == null ? "—" : p.dotproduct.toFixed(6)}</td>
        <td class="pct-cell">${p.pct.toFixed(1)}%</td>
      </tr>`;
    }).join("");
    $$("#raw thead th[data-col]").forEach(th => {
      const c = th.dataset.col;
      const on = c === sortCol;
      th.setAttribute("aria-sort", on ? (dir > 0 ? "ascending" : "descending") : "none");
      const a = th.querySelector(".arrow");
      if (a) a.textContent = on ? (dir > 0 ? "▲" : "▼") : "▲";
    });
  }

  $$("#raw thead th[data-col] button").forEach(btn => {
    btn.addEventListener("click", () => {
      const col = btn.closest("th").dataset.col;
      if (col === sortCol) sortDir = -sortDir; else { sortCol = col; sortDir = 1; }
      sortAndRender();
    });
  });

  let rt;
  globalThis.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(FS.resizeCharts, 120); });

  applyTheme(getPref(), false);
  syncGates();
  refreshUrl();
  setView("dashboard");
  // Starts blank by design — paste a specimen and score to populate.
  status("Paste a specimen to begin.", "");
  // Nothing scored yet → open the drawer so the input is ready to use.
  if (!FS._lastShaped) setDock(true);
})();
