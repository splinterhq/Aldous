
/* 
   dece-data.js
   Group registry, key-nomenclature parser, and the response shaper. Consumes
   the live scorer contract directly:  [{ key, similarity, distance }, …]

   Key nomenclature (per spec + main.ts):
     keyname / +keyname / ++keyname / -keyname / --keyname  → gradation tiers
     %keyname  → density-probe   (vertical saturators)
     @keyname  → saturation key  (horizontal saturators)
   Everything attaches to FS.* (ForeShock) (plain globals; no modules).
*/

globalThis.FS = globalThis.FS || {};

/* The actionable floor — the universal 20% low-water mark. */
FS.FLOOR = 20;

/* The confidence threshold — above this we treat the signal as confident,
   not merely above the noise floor. */
FS.CONFIDENCE = 50;

/* Per-tier vote weight. `distance` is the model's variance-standardized
   euclidean distance (smaller = tighter match), so a tier's pull falls off
   smoothly as it gets farther — never NaN, and no scale-bound ceiling constant
   to keep in sync with the embedding model. */
FS.axisWeight = function (d) { return 1 / (1 + Math.max(0, d)); };

/* Resolve a bidirectional-axis tier set (e.g. |--outlook … |++outlook) into a
   signed reading:
     pos   — weighted centroid of the tier anchors in [−2, +2]; the needle
     sigma — weighted dispersion of those anchors around pos: how spread the
             supporting evidence is, i.e. a confidence interval ON the needle.
             (Not the model's per-dimension variance — that is already folded
             into each tier's distance, and thus into the weights below.)
     wsum  — total vote weight;   n — number of contributing tiers
   No tiers → centered at 0 with zero spread. */
FS.axisStats = function (tiers) {
  let wsum = 0, num = 0;
  for (const p of tiers) { const w = FS.axisWeight(p.distance); wsum += w; num += p.tier * w; }
  if (wsum <= 0) return { pos: 0, sigma: 0, wsum: 0, n: 0 };
  const pos = num / wsum;
  let v = 0;
  for (const p of tiers) v += FS.axisWeight(p.distance) * (p.tier - pos) ** 2;
  return { pos, sigma: Math.sqrt(v / wsum), wsum, n: tiers.length };
};

/* Shunt detection gate. Shunts are pre-embedded tripwire pillars that should
   sit quiet; a hit is only a real "shunt trip" when BOTH conditions hold
   simultaneously — the minimum detectable signal for this application:
     similarity ≥ 30%   AND   distance < 20
   (cosine close enough AND euclidean tight enough). Clients wire trips to
   automation once matches are sure enough. */
FS.SHUNT_SIM = 50.00;    // %  — minimum cosine similarity
FS.SHUNT_DIST = 15.00;   //    — maximum euclidean distance

/* True when a parsed shunt row clears both gates at once. */
FS.isDetectable = function (p) {
  return p.pct >= FS.SHUNT_SIM && p.distance < FS.SHUNT_DIST;
};

/* Intrinsic shunts ("~~shunt_") behave like monolithic shunts but carry the
   computed centroid + variance vectors the other sensors do, so they live on an
   entirely different magnitude scale and need their own gates. They are
   tuning-only (expensive to retrain), not edited live like monolithic shunts.
   Defaults mirror the monolithic gates for now; tune these as the scale settles. */
FS.ISHUNT_SIM = 70.00;   // %  — minimum cosine similarity
FS.ISHUNT_DIST = 30.00;  //    — maximum euclidean distance

/* True when a parsed intrinsic-shunt row clears both of its gates at once. */
FS.isDetectableIntrinsic = function (p) {
  return p.pct >= FS.ISHUNT_SIM && p.distance < FS.ISHUNT_DIST;
};

/* Group registry. Colors live in CSS custom props so themes can override them;
   we only key off the id here. */
FS.GROUPS = {
  ev:         { label: "Emotional Valence", short: "Emotional" },
  outlook:    { label: "Outlook",           short: "Outlook"   },
  action:     { label: "Action",            short: "Action"    },
  partisan:   { label: "Partisan",          short: "Partisan"  },
  epistemic:  { label: "Epistemic",         short: "Epistemic" },
  structural: { label: "Structural",        short: "Structural"},
  autonomy:   { label: "Autonomy",          short: "Autonomy"  },
  signal:     { label: "Signal Sat.",       short: "Signal"    },
  shunt:      { label: "Shunt Sensors",     short: "Shunt"     },
  ishunt:     { label: "Intrinsic Shunts",  short: "Intrinsic" },
};
FS.GROUP_ORDER = ["ev", "outlook", "action", "partisan", "epistemic", "structural", "autonomy", "signal", "shunt", "ishunt"];

/* Base-key → group lookup, lifted from the main.ts pillar registry + floors. */
FS.BASE_GROUP = (() => {
  const m = {};
  const put = (g, keys) => keys.forEach(k => (m[k] = g));
  put("ev", ["tension","anger","fear","sadness","joy","hedonism","sexuality","spirituality","markov_ev"]);
  put("outlook", ["outlook","markov_outlook"]);
  // action is an ev-attractor pillar in the model floors, but reads as its own
  // unidirectional axis here; its density is folded into markov_ev (no probe of
  // its own), so only the |-tier base lands in this group.
  put("action", ["action"]);
  put("partisan", ["partisan_l","partisan_r","partisan_c","markov_partisan"]);
  put("epistemic", ["objectivity","subjectivity","certainty","hedging","markov_epistemic"]);
  put("structural", ["hate","sexism","conflict","violence","philosophical_tension","tech_existential","markov_structural"]);
  put("autonomy", ["markov_autonomy"]);
  return m;
})();

/* Parse one key into { raw, type, base, tier, group, prefix }. */
FS.parseKey = function (key) {
  let type = "gradation", prefix = "", base = key, tier = 0;
  if (key.indexOf("~~shunt_") === 0) { type = "ishunt"; prefix = "~~shunt_"; base = key.slice(8); }
  else if (key.indexOf("__shunt_") === 0) { type = "shunt"; prefix = "__shunt_"; base = key.slice(8); }
  else if (key[0] === "|") {
    // Unidirectional axis pillar (e.g. |--outlook … |++outlook, |--action …
    // |++action). Strip the "|" marker, read the +/- tier from what remains; the
    // base that's left (outlook, action, …) is itself the axis type, so each
    // axis filters into its own slider while sharing one render path.
    prefix = "|";
    let rest = key.slice(1);
    const mPlus = rest.match(/^(\++)/), mMinus = rest.match(/^(-+)/);
    if (mPlus) { tier = mPlus[1].length; rest = rest.slice(tier); }
    else if (mMinus) { tier = -mMinus[1].length; rest = rest.slice(mMinus[1].length); }
    base = rest;
    type = base;
  }
  else if (key[0] === "%") { type = "density"; prefix = "%"; base = key.slice(1); }
  else if (key[0] === "@") { type = "saturation"; prefix = "@"; base = key.slice(1); }
  else {
    const mPlus = key.match(/^(\++)/);
    const mMinus = key.match(/^(-+)/);
    if (mPlus) { tier = mPlus[1].length; base = key.slice(tier); prefix = mPlus[1]; }
    else if (mMinus) { tier = -mMinus[1].length; base = key.slice(mMinus[1].length); prefix = mMinus[1]; }
  }
  let group = FS.BASE_GROUP[base] || "signal";
  if (type === "saturation") group = "signal";
  if (type === "shunt") group = "shunt";
  if (type === "ishunt") group = "ishunt";
  return { raw: key, type, base, tier, prefix, group };
};

/* Pretty label for a base key. */
FS.labelOf = function (base) {
  return base
    .replace(/^markov_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
};

/* Shape a raw flat response into the four display layers. */
FS.shape = function (rows) {
  const parsed = rows.map(r => ({
    ...r, ...FS.parseKey(r.key),
    pct: +(r.similarity * 100).toFixed(1),
    // dot product is a raw-table-only exploration column; tolerate older
    // scorer payloads that predate the field by leaving it null.
    dotproduct: typeof r.dotproduct === "number" ? r.dotproduct : null,
  }));

  const density = parsed.filter(p => p.type === "density");
  const saturation = parsed.filter(p => p.type === "saturation");
  const gradation = parsed.filter(p => p.type === "gradation");
  const shunt = parsed.filter(p => p.type === "shunt");
  const ishunt = parsed.filter(p => p.type === "ishunt");
  const outlook = parsed.filter(p => p.type === "outlook");
  const action = parsed.filter(p => p.type === "action");
  shunt.forEach(p => { p.detect = FS.isDetectable(p); });
  ishunt.forEach(p => { p.detect = FS.isDetectableIntrinsic(p); });

  // order density + saturation + shunt by value desc for a clean read
  density.sort((a, b) => b.pct - a.pct);
  saturation.sort((a, b) => b.pct - a.pct);
  shunt.sort((a, b) => b.pct - a.pct);
  ishunt.sort((a, b) => b.pct - a.pct);

  // axis pillars ordered by tier ascending (−−, −, middle, +, ++) for slider tooltips
  outlook.sort((a, b) => a.tier - b.tier);
  const outlookStats = FS.axisStats(outlook);
  action.sort((a, b) => a.tier - b.tier);
  const actionStats = FS.axisStats(action);

  // gradation ordered by group, then base, then tier
  const gi = g => FS.GROUP_ORDER.indexOf(g);
  gradation.sort((a, b) =>
    gi(a.group) - gi(b.group) ||
    a.base.localeCompare(b.base) ||
    a.tier - b.tier);

  return { parsed, density, saturation, gradation, shunt, ishunt,
           outlook, outlookStats, action, actionStats,
           floor: FS.FLOOR, confidence: FS.CONFIDENCE,
           simT: FS.SHUNT_SIM, distT: FS.SHUNT_DIST,
           simTI: FS.ISHUNT_SIM, distTI: FS.ISHUNT_DIST };
};
