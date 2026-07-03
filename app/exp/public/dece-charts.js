/*
 * Apache Charts Helpers
 */
globalThis.FS = globalThis.FS || {};

FS.charts = {};          // id -> echarts instance
FS._lastShaped = null;   // remember data for theme rebuilds

function rd(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

FS.tokens = function () {
  return {
    text: rd("--chart-text"),
    axis: rd("--chart-axis"),
    grid: rd("--chart-grid"),
    split: rd("--chart-split"),
    floor: rd("--floor"),
    fail: rd("--fail-ink"),
    panel: rd("--bg1"),
    border: rd("--border"),
    g: {
      ev: rd("--ev"), outlook: rd("--outlook"), action: rd("--action"),
      partisan: rd("--partisan"),
      epistemic: rd("--epistemic"), structural: rd("--structural"),
      autonomy: rd("--autonomy"), signal: rd("--signal"), shunt: rd("--shunt"),
      ishunt: rd("--ishunt"),
    },
    trip: rd("--trip"),
  };
};

FS.reduceMotion = function () {
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

const SYMBOL = { density: "rect", saturation: "diamond", gradation: "circle", shunt: "triangle", ishunt: "triangle", outlook: "diamond", action: "diamond" };

function baseTooltip(t) {
  return {
    backgroundColor: t.panel,
    borderColor: t.border,
    borderWidth: 1,
    textStyle: { color: rd("--text"), fontFamily: "Space Mono, monospace", fontSize: 11 },
    extraCssText: "box-shadow:0 8px 24px rgba(0,0,0,.25); border-radius:8px;",
  };
}

function axisCommon(t) {
  return {
    nameTextStyle: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 10 },
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { lineStyle: { color: t.axis } },
    axisLabel: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 10 },
    splitLine: { lineStyle: { color: t.grid } },
  };
}

/* Large scatter: cosine similarity × euclidean distance, all keys */
FS.scatterOption = function (shaped, t) {
  // Intrinsic shunts carry centroid+variance vectors and read on a different
  // magnitude scale; folding them into this shared-scale scatter would blow out
  // its auto-fit axes, so they stay in their own dedicated plot only.
  const present = FS.GROUP_ORDER.filter(g =>
    g !== "ishunt" && shaped.parsed.some(p => p.group === g));
  const series = present.map(g => ({
    name: FS.GROUPS[g].label,
    type: "scatter",
    symbolSize: 15,
    emphasis: { focus: "series", scale: 1.25 },
    itemStyle: { color: t.g[g], borderColor: rd("--bg1"), borderWidth: 1, opacity: .92 },
    data: shaped.parsed.filter(p => p.group === g).map(p => ({
      value: [p.pct, p.distance],
      name: p.key,
      symbol: SYMBOL[p.type],
      symbolSize: p.type === "gradation" ? 13 : 17,
    })),
  }));
  return {
    animation: !FS.reduceMotion(),
    animationDuration: 480,
    aria: { enabled: true, label: { description:
      "Scatter plot of every scored key. Horizontal axis is cosine similarity percent, vertical axis is euclidean distance. Color encodes group; squares are density probes, diamonds are saturation keys, circles are gradations." } },
    grid: { left: 64, right: 28, top: 18, bottom: 80 },
    legend: {
      type: "scroll", bottom: 8, left: "center",
      textStyle: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 10 },
      inactiveColor: t.axis, itemWidth: 12, itemHeight: 12, itemGap: 14,
    },
    tooltip: Object.assign(baseTooltip(t), {
      trigger: "item",
      formatter: p => `<b>${p.data.name}</b><br/>similarity ${p.value[0].toFixed(1)}%<br/>distance ${p.value[1].toFixed(3)}`,
    }),
    xAxis: Object.assign({ type: "value", name: "cosine similarity →", nameLocation: "middle", nameGap: 30,
      min: 0, max: 70, scale: true }, axisCommon(t)),
    yAxis: Object.assign({ type: "value", name: "euclidean distance ↑", nameLocation: "middle", nameGap: 44,
      inverse: false, scale: true }, axisCommon(t)),
    series,
  };
};

/* Unified %-density saturation plot (vertical), shared 20% floor */
FS.satOption = function (shaped, t) {
  const items = shaped.density;
  const data = items.map(p => {
    const pass = p.pct >= shaped.floor;
    return {
      value: p.pct,
      name: p.key,
      itemStyle: pass
        ? { color: t.g[p.group], borderRadius: [4, 4, 0, 0] }
        : { color: "transparent", borderColor: t.g[p.group], borderWidth: 1.5, borderType: "dashed",
            borderRadius: [4, 4, 0, 0],
            decal: { symbol: "rect", color: t.fail, dashArrayX: [1, 0], dashArrayY: [2, 5], rotation: -Math.PI / 4 } },
    };
  });
  return {
    animation: !FS.reduceMotion(),
    aria: { enabled: true, label: { description:
      `Bar chart of density-probe percentages, one bar per percent-key. A dashed line marks the ${shaped.floor} percent actionable floor; bars below it are drawn hollow with a hatch pattern.` } },
    grid: { left: 52, right: 20, top: 24, bottom: 86 },
    tooltip: Object.assign(baseTooltip(t), {
      trigger: "item",
      formatter: p => `<b>${p.name}</b><br/>${p.value.toFixed(1)}%  ${p.value >= shaped.floor ? "· over floor" : "· below 20% floor"}`,
    }),
    xAxis: Object.assign({ type: "category", data: items.map(p => p.key),
      axisLabel: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 10, rotate: 32, interval: 0,
        margin: 12 } }, axisCommon(t)),
    yAxis: Object.assign({ type: "value", name: "saturation %", nameLocation: "middle", nameGap: 38,
      min: 0, max: 100 }, axisCommon(t)),
    series: [{
      type: "bar", barMaxWidth: 54, data,
      markLine: {
        symbol: "none", silent: true,
        lineStyle: { color: t.floor, type: "dashed", width: 2 },
        label: { color: t.floor, fontFamily: "Space Mono, monospace", fontSize: 11,
          position: "insideEndTop" },
        // Only draw a line for values echarts can resolve to a coordinate;
        // a stray `{ yAxis: undefined }` crashes the whole render (coord lookup).
        data: [
          { yAxis: shaped.floor, label: { formatter: `${shaped.floor}% floor` } },
          ...(Number.isFinite(shaped.confidence)
            ? [{ yAxis: shaped.confidence, label: { formatter: `${shaped.confidence}% Confidence` },
                lineStyle: { color: t.g.signal, type: "dashed", width: 2 } }]
            : []),
        ],
      },
    }],
  };
};

/* Summed spectrum: gradation bars (key/+key/++key) */
FS.spectrumOption = function (shaped, t) {
  const items = shaped.gradation;
  const data = items.map(p => ({
    value: p.pct,
    name: p.key,
    itemStyle: { color: t.g[p.group], borderRadius: [3, 3, 0, 0],
      opacity: p.tier === 0 ? .72 : p.tier < 0 ? .6 : Math.min(1, .78 + p.tier * .11) },
  }));
  const many = items.length > 22;
  // peak (loudest bar) + floor (quietest bar), drawn as dotted hold-lines so
  // they stay visible while the x-axis is zoomed — like the peak/floor rails on
  // a graphic EQ's waveform display.
  const peak = items.length ? Math.max(...items.map(p => p.pct)) : 0;
  const floor = items.length ? Math.min(...items.map(p => p.pct)) : 0;
  return {
    animation: !FS.reduceMotion(),
    aria: { enabled: true, label: { description:
      `Bar chart of gradation keys grouped by pillar. Bar height is similarity percent; brighter bars are higher intensity tiers (++). A dotted line marks the ${peak.toFixed(0)} percent peak and another the ${floor.toFixed(0)} percent floor (lowest-scoring sensor).` } },
    grid: { left: 48, right: 18, top: 18, bottom: many ? 96 : 78 },
    tooltip: Object.assign(baseTooltip(t), {
      trigger: "item",
      formatter: p => { const it = items[p.dataIndex];
        return `<b>${p.name}</b><br/>${FS.GROUPS[it.group].label} · tier ${it.tier >= 0 ? "+" + it.tier : it.tier}<br/>${p.value.toFixed(1)}%`; },
    }),
    dataZoom: many ? [
      { type: "inside", filterMode: "none" },
      { type: "slider", height: 32, bottom: 30, borderColor: t.border, fillerColor: t.grid,
        handleStyle: { color: t.g.signal }, textStyle: { color: t.text, fontSize: 16 },
        backgroundColor: "transparent" },
    ] : undefined,
    xAxis: Object.assign({ type: "category", data: items.map(p => p.key),
      axisLabel: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 9.5, rotate: 42, interval: 0,
        margin: 10 } }, axisCommon(t)),
    yAxis: Object.assign({ type: "value", name: "similarity %", nameLocation: "middle", nameGap: 36,
      min: 0 }, axisCommon(t)),
    series: [{
      type: "bar", barMaxWidth: 26, data,
      markLine: {
        symbol: "none", silent: true,
        lineStyle: { color: t.floor, type: "dotted", width: 1.5 },
        label: { color: t.floor, fontFamily: "Space Mono, monospace", fontSize: 10,
          position: "insideEndTop" },
        // Guard each value: a stray `{ yAxis: undefined }` crashes the render.
        data: [
          { yAxis: floor, label: { formatter: `floor ${floor.toFixed(0)}%` } },
          ...(peak > floor
            ? [{ yAxis: peak, label: { formatter: `peak ${peak.toFixed(0)}%`, color: t.g.signal },
                lineStyle: { color: t.g.signal, type: "dotted", width: 1.5 } }]
            : []),
        ],
      },
    }],
  };
};

/* @-saturation keys (horizontal) */
FS.hsatOption = function (shaped, t) {
  const items = shaped.saturation.slice().reverse(); // bottom-up so largest on top
  const data = items.map(p => {
    const pass = p.pct >= shaped.floor;
    return {
      value: p.pct, name: p.key,
      itemStyle: pass
        ? { color: t.g.signal, borderRadius: [0, 4, 4, 0] }
        : { color: "transparent", borderColor: t.g.signal, borderWidth: 1.5, borderType: "dashed",
            borderRadius: [0, 4, 4, 0],
            decal: { symbol: "rect", color: t.fail, dashArrayX: [1, 0], dashArrayY: [2, 5], rotation: -Math.PI / 4 } },
    };
  });
  return {
    animation: !FS.reduceMotion(),
    aria: { enabled: true, label: { description:
      `Horizontal bar chart of at-saturation keys. A dashed vertical line marks the ${shaped.floor} percent noise floor${Number.isFinite(shaped.confidence) ? ` and another the ${shaped.confidence} percent confidence threshold` : ""}; bars short of the floor are hollow with a hatch pattern.` } },
    grid: { left: 130, right: 56, top: 14, bottom: 38 },
    tooltip: Object.assign(baseTooltip(t), {
      trigger: "item",
      formatter: p => `<b>${p.name.replace(/^[%@]/, "")}</b><br/>${p.value.toFixed(1)}%  ${p.value >= shaped.floor ? "· over floor" : "· below 20% floor"}`,
    }),
    xAxis: Object.assign({ type: "value", name: "saturation %", nameLocation: "middle", nameGap: 26,
      min: 0, max: 100 }, axisCommon(t)),
    yAxis: Object.assign({ type: "category", data: items.map(p => p.key),
      axisLabel: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 11,
        formatter: v => v.replace(/^[%@]/, "") } }, axisCommon(t)),
    series: [{
      type: "bar", barMaxWidth: 22, data,
      label: { show: true, position: "right", formatter: p => p.value.toFixed(0) + "%",
        color: t.text, fontFamily: "Space Mono, monospace", fontSize: 11 },
      markLine: {
        symbol: "none", silent: true,
        lineStyle: { color: t.floor, type: "dashed", width: 2 },
        label: { color: t.floor, fontFamily: "Space Mono, monospace", fontSize: 10,
          position: "end" },
        // Guard the confidence line: a stray `{ xAxis: undefined }` crashes the
        // whole render (echarts coord lookup) — mirror satOption.
        data: [
          { xAxis: shaped.floor, label: { formatter: `${shaped.floor}% Noise Floor` } },
          ...(Number.isFinite(shaped.confidence)
            ? [{ xAxis: shaped.confidence, label: { formatter: `${shaped.confidence}% Confidence`, color: t.g.signal },
                lineStyle: { color: t.g.signal, type: "dashed", width: 2 } }]
            : []),
        ],
      },
    }],
  };
};

/*
   Shunt scatter that resembles an air traffic control display. Shared between
   the monolithic shunts and the intrinsic shunts — they render identically; only
   the point set, the gate thresholds and the "quiet" hue differ. Tolerates an
   empty point set so a section with no shunts of its kind still draws its gates.
 */
function shuntScatter(pts, simT, distT, t, quietColor, descr) {
  const sims = pts.map(p => p.pct), dists = pts.map(p => p.distance);

  // bounds that always keep both gate lines and all points in frame
  const xMin = 0;
  const xMax = Math.max(60, Math.ceil((Math.max(...sims, simT) + 6) / 5) * 5);
  const yMin = Math.floor(Math.min(...dists, distT) - 2);
  const yMax = Math.ceil(Math.max(...dists, distT) + 2);

  const data = pts.map(p => {
    const det = p.detect;
    return {
      value: [p.pct, p.distance],
      name: p.key, base: p.base, det,
      symbol: "triangle",
      symbolSize: det ? 21 : 14,
      itemStyle: det
        ? { color: t.trip, borderColor: rd("--bg1"), borderWidth: 1, shadowColor: t.trip, shadowBlur: 12 }
        : { color: quietColor, opacity: .72, borderColor: rd("--bg1"), borderWidth: 1 },
      label: {
        show: true, position: "right", distance: 6,
        formatter: () => (det ? "⚡ " : "") + p.base,
        color: det ? t.trip : t.text, fontWeight: det ? 700 : 400,
        fontFamily: "Space Mono, monospace", fontSize: 10,
      },
    };
  });

  return {
    animation: !FS.reduceMotion(),
    animationDuration: 480,
    aria: { enabled: true, label: { description: descr } },
    grid: { left: 60, right: 72, top: 20, bottom: 52 },
    tooltip: Object.assign(baseTooltip(t), {
      trigger: "item",
      formatter: p => `<b>${p.data.name}</b><br/>similarity ${p.value[0].toFixed(1)}%<br/>distance ${p.value[1].toFixed(3)}<br/>${p.data.det ? "· ⚡ SHUNT TRIP" : "· quiet"}`,
    }),
    xAxis: Object.assign({ type: "value", name: "cosine similarity →", nameLocation: "middle", nameGap: 30,
      min: xMin, max: xMax }, axisCommon(t)),
    yAxis: Object.assign({ type: "value", name: "euclidean distance (closer ↑)", nameLocation: "middle", nameGap: 42,
      min: yMin, max: yMax, inverse: true }, axisCommon(t)),
    series: [{
      type: "scatter", data,
      markArea: {
        silent: true,
        itemStyle: { color: t.trip, opacity: .08 },
        label: { show: true, position: "insideTopRight", formatter: "Minimum actionable signal",
          color: t.trip, fontFamily: "Space Mono, monospace", fontSize: 10, opacity: .85,
          padding: [4, 6, 0, 0] },
        data: [[{ xAxis: simT, yAxis: distT }, { xAxis: xMax, yAxis: yMin }]],
      },
      markLine: {
        symbol: "none", silent: true,
        lineStyle: { color: t.trip, type: "dashed", width: 1.5, opacity: .8 },
        data: [
          { xAxis: simT, label: { formatter: `sim ≥ ${simT}%`, position: "insideEndBottom",
            color: t.trip, fontFamily: "Space Mono, monospace", fontSize: 10 } },
          { yAxis: distT, label: { formatter: `dist < ${distT}`, position: "insideStartTop",
            color: t.trip, fontFamily: "Space Mono, monospace", fontSize: 10 } },
        ],
      },
    }],
  };
}

/* Monolithic, mean-pooled shunts. */
FS.shuntOption = function (shaped, t) {
  return shuntScatter(shaped.shunt, shaped.simT, shaped.distT, t, t.g.shunt,
    "Scatter plot of shunt tripwire keys against two gates at once. Horizontal axis is cosine similarity percent, vertical axis is euclidean distance (inverted, closer is higher). A shaded box in the top-right marks the minimum actionable signal. Triangles inside the box are shunt trips: high enough confidence to trigger automation for deep-evaluation or holding.");
};

/* Intrinsic shunts: same display, distinct point set, gates and hue. May be
   empty when the model carries no intrinsic shunts — the chart still draws. */
FS.ishuntOption = function (shaped, t) {
  return shuntScatter(shaped.ishunt, shaped.simTI, shaped.distTI, t, t.g.ishunt || t.g.shunt,
    "Scatter plot of intrinsic shunt keys against two gates at once. Horizontal axis is cosine similarity percent, vertical axis is euclidean distance (inverted, closer is higher). A shaded box in the top-right marks the minimum actionable signal. Triangles inside the box are intrinsic shunt trips. Intrinsic shunts carry centroid and variance vectors, so they read on a different magnitude scale than monolithic shunts.");
};

/*
  Bidirectional sensor beams: outlook & action
  Each sensor is a diverging axis (−− ↔ ++) centered on neutral 0. We draw the
  resolved needle (weighted tier centroid), a shaded band = needle ± weighted
  dispersion (a confidence interval on the reading), and every tier anchor as a
  bubble sized by its vote weight. distance is variance-standardized, so tighter
  tiers vote harder and show as larger bubbles.
 */
FS.beamOption = function (shaped, t) {
  // lane 0 = Action (bottom row), lane 1 = Outlook (top row)
  const lanes = [
    { label: "Action",   color: t.g.action,   tiers: shaped.action,   st: shaped.actionStats },
    { label: "Outlook", color: t.g.outlook, tiers: shaped.outlook, st: shaped.outlookStats },
  ];
  const laneColor = lanes.map(l => l.color);
  const TIER_LABEL = { "-2": "−−", "-1": "−", "0": "0", "1": "+", "2": "++" };

  // structural beam: ±σ band span per lane (track + zero line drawn in renderItem)
  const beam = lanes.map((ln, i) => ({ value: [i, ln.st.pos - ln.st.sigma, ln.st.pos + ln.st.sigma] }));

  // tier-anchor bubbles, sized by vote weight
  const bubbles = [];
  lanes.forEach((ln, i) => ln.tiers.forEach(p => {
    const w = FS.axisWeight(p.distance);
    bubbles.push({
      value: [p.tier, i], name: p.key,
      symbolSize: 9 + w * 30,
      itemStyle: { color: ln.color, opacity: .55, borderColor: t.panel, borderWidth: 1 },
      _d: p.distance, _w: w, _lane: ln.label,
    });
  }));

  // needle markers — only lanes that actually voted
  const needles = lanes.map((ln, i) => ({ ln, i })).filter(o => o.ln.st.n > 0).map(({ ln, i }) => ({
    value: [ln.st.pos, i], name: ln.label, _sigma: ln.st.sigma, _n: ln.st.n,
    itemStyle: { color: ln.color, borderColor: t.panel, borderWidth: 1.5, shadowColor: ln.color, shadowBlur: 10 },
    label: {
      show: true, position: "top", distance: 8,
      formatter: () => `${ln.label}  ${ln.st.pos >= 0 ? "+" : ""}${ln.st.pos.toFixed(2)}`,
      color: t.text, fontFamily: "Space Mono, monospace", fontSize: 11, fontWeight: 700,
    },
  }));

  return {
    animation: !FS.reduceMotion(),
    animationDuration: 480,
    aria: { enabled: true, label: { description:
      `Two bidirectional sensor beams — outlook and action — each centered on neutral zero with negative tiers left and positive right on a minus-two to plus-two scale. A diamond marks the resolved needle: outlook ${shaped.outlookStats.pos.toFixed(2)}, action ${shaped.actionStats.pos.toFixed(2)}. A shaded band around each needle shows the spread of supporting tier evidence; bubbles mark each tier anchor, larger when the match is tighter.` } },
    grid: { left: 96, right: 40, top: 46, bottom: 62 },
    graphic: [{
      type: "text", left: "center", bottom: 6, silent: true,
      style: {
        text: "Outlook: how favorable the result looks  ·  Action: energizing / moving vs. calming / damping",
        fill: t.axis, fontFamily: "Space Mono, monospace", fontSize: 10, opacity: .85,
        textAlign: "center",
      },
    }],
    tooltip: Object.assign(baseTooltip(t), {
      trigger: "item",
      formatter: p => {
        if (p.seriesName === "tiers")
          return `<b>${p.data.name}</b><br/>${p.data._lane} · tier ${p.value[0] >= 0 ? "+" + p.value[0] : p.value[0]}<br/>distance ${p.data._d.toFixed(3)}<br/>weight ${(p.data._w * 100).toFixed(0)}%`;
        if (p.seriesName === "needle")
          return `<b>${p.data.name} reading</b><br/>position ${p.value[0] >= 0 ? "+" : ""}${p.value[0].toFixed(2)}<br/>spread ±${p.data._sigma.toFixed(2)}<br/>${p.data._n} tier${p.data._n === 1 ? "" : "s"} voting`;
        return "";
      },
    }),
    xAxis: Object.assign({
      type: "value", min: -2.2, max: 2.2,
      name: "←  negative tiers        ·  0  ·        positive tiers  →",
      nameLocation: "middle", nameGap: 28,
      axisLabel: { formatter: v => TIER_LABEL[String(v)] ?? "", showMinLabel: false, showMaxLabel: false },
    }, axisCommon(t)),
    yAxis: Object.assign({
      type: "category", data: lanes.map(l => l.label),
      axisLabel: { color: t.text, fontFamily: "Space Mono, monospace", fontSize: 12, fontWeight: 700 },
      axisTick: { show: false },
    }, axisCommon(t)),
    series: [
      {
        name: "beam", type: "custom", silent: true, z: 1, data: beam,
        renderItem: (_params, api) => {
          const lane = api.value(0), lo = api.value(1), hi = api.value(2);
          const yPix = api.coord([0, lane])[1];
          const bandH = api.size([0, 1])[1];
          const trackH = Math.max(3, bandH * 0.05);
          const fillH = bandH * 0.42;
          const x0 = api.coord([-2, lane])[0], x2 = api.coord([2, lane])[0];
          const xLo = api.coord([lo, lane])[0], xHi = api.coord([hi, lane])[0];
          const xZero = api.coord([0, lane])[0];
          return { type: "group", children: [
            { type: "rect", silent: true,
              shape: { x: x0, y: yPix - trackH / 2, width: x2 - x0, height: trackH, r: trackH / 2 },
              style: { fill: t.grid } },
            { type: "rect", silent: true,
              shape: { x: xLo, y: yPix - fillH / 2, width: Math.max(2, xHi - xLo), height: fillH, r: 7 },
              style: { fill: laneColor[lane], opacity: .20 } },
            { type: "line", silent: true,
              shape: { x1: xZero, y1: yPix - bandH * 0.36, x2: xZero, y2: yPix + bandH * 0.36 },
              style: { stroke: t.axis, lineWidth: 1, lineDash: [3, 3] } },
          ] };
        },
      },
      { name: "tiers", type: "scatter", z: 2, data: bubbles, emphasis: { scale: 1.2 } },
      { name: "needle", type: "scatter", z: 3, symbol: "diamond", symbolSize: 22, data: needles },
    ],
  };
};

/* ── build / rebuild all charts ── */
const CHART_SPECS = [
  ["scatter", "scatterOption"],
  ["sat", "satOption"],
  ["spectrum", "spectrumOption"],
  ["beam", "beamOption"],
  ["hsat", "hsatOption"],
  ["shunt", "shuntOption"],
  ["ishunt", "ishuntOption"],
];

FS.buildCharts = function (shaped) {
  FS._lastShaped = shaped;
  const t = FS.tokens();
  CHART_SPECS.forEach(([id, fn]) => {
    const el = document.getElementById("chart-" + id);
    if (!el) return;
    if (!FS.charts[id]) FS.charts[id] = echarts.init(el, null, { renderer: "canvas" });
    FS.charts[id].setOption(FS[fn](shaped, t), true);
  });
};

FS.rebuildCharts = function () {
  if (!FS._lastShaped) return;
  // dispose + recreate so theme chrome (axis/text) re-reads tokens cleanly
  CHART_SPECS.forEach(([id]) => { if (FS.charts[id]) { FS.charts[id].dispose(); delete FS.charts[id]; } });
  FS.buildCharts(FS._lastShaped);
};

FS.resizeCharts = function () {
  Object.values(FS.charts).forEach(c => c && c.resize());
};
