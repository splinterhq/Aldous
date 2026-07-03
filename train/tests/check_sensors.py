#!/usr/bin/env python3
"""check_sensors.py — Aldous sensor regression harness.

Scans the current directory for `.txt` specimens, scores each one through the
running DECE scorer (`dece-semsaged`) exactly the way `app/exp` does — a raw
POST of the text body to `/api/v1/score` — and asserts that a configured set of
sensors hold their similarity/distance values inside declared tolerances.

Every (sensor, metric, bound) pair is one *check*. A check has a `min` and/or a
`max`; unspecified bounds default to `min=0`, `max=100`. For each check we
record its *adhesion*: how deep inside the allowed band the value sits, 0 at the
boundary (or in violation), 1 at the far edge — i.e. how much regression margin
the sensor still has. Any violation makes the run exit non-zero.

A self-contained HTML report (inline SVG, light/dark) is written alongside:
  * per specimen, a bar of every configured sensor's score against its band,
  * the distribution of adhesion across all checks,
  * mean adhesion per specimen.

Python 3, standard library only. No external dependencies.

Config (default ./tolerances.json):

    {
      "scorer_url": "http://127.0.0.1:3271",   # optional; env SCORER_URL wins if set
      "score_params": {"protect_shunts": "1"}, # optional query params, verbatim
      "samples": {
        "*": {                                 # applied to every specimen
          "~~shunt_inciting_violent_action": {"similarity": {"max": 62}}
        },
        "fdr_pearl_harbor.txt": {              # merged over "*", same key wins
          "++tension":  {"similarity": {"min": 58, "max": 70}},
          "+joy":       {"distance":   {"min": 30}}
        }
      }
    }
"""

from __future__ import annotations

import argparse
import glob
import html
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# ── palette (dataviz reference instance; SVG reads these as CSS vars) ──────────
CSS_VARS = """
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --band:#cde2fb;
  --good:#0ca30c; --critical:#d03b3b; --warning:#eda100;
""".strip()
CSS_VARS_DARK = """
    --surface-1:#1a1a19; --plane:#0d0d0d;
    --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --series-1:#3987e5; --band:#184f95;
    --good:#0ca30c; --critical:#e34948; --warning:#c98500;
""".strip()


# ── model ─────────────────────────────────────────────────────────────────────
class Check:
    """One (sensor, metric, bound) assertion and its outcome."""

    def __init__(self, sensor, metric, bound, limit, value, present, lo, hi):
        self.sensor = sensor          # e.g. "++tension"
        self.metric = metric          # "similarity" | "distance"
        self.bound = bound            # "min" | "max"
        self.limit = limit            # the configured threshold (== lo for min, hi for max)
        self.value = value            # scored value (None if sensor absent)
        self.present = present        # was the sensor returned by the scorer?
        self.lo = lo                  # band floor  (configured min, else 0)
        self.hi = hi                  # band ceiling (configured max, else 100)

    @property
    def passed(self):
        if not self.present:
            return False
        if self.bound == "min":
            return self.value >= self.limit
        return self.value <= self.limit

    @property
    def adhesion(self):
        """0..1 — fraction of THIS band's width still remaining before a breach.

        Normalised against the sensor+metric's own band [lo, hi] (an unspecified
        side falls back to 0 / 100), so a value sitting mid-band reads ~0.5 and a
        two-sided band's min and max checks share one scale. 0 at the edge or on
        a violation/miss.
        """
        if not self.present or not self.passed:
            return 0.0
        span = self.hi - self.lo
        if span <= 0:
            span = abs(self.hi) or 1.0
        headroom = (self.value - self.lo) if self.bound == "min" else (self.hi - self.value)
        return max(0.0, min(1.0, headroom / span))


class Row:
    """A sensor+metric line for the per-specimen bar (aggregates its bounds)."""

    def __init__(self, sensor, metric, value, present, lo, hi, checks):
        self.sensor = sensor
        self.metric = metric
        self.value = value
        self.present = present
        self.lo = lo                  # band floor for drawing (0 if no min)
        self.hi = hi                  # band ceiling for drawing (100 if no max)
        self.checks = checks

    @property
    def passed(self):
        return self.present and all(c.passed for c in self.checks)

    @property
    def adhesion(self):
        return min((c.adhesion for c in self.checks), default=0.0)


class SampleResult:
    def __init__(self, name):
        self.name = name
        self.rows = []               # list[Row]
        self.checks = []             # list[Check] (atomic)
        self.skipped = None          # reason string if not scored

    @property
    def mean_adhesion(self):
        return sum(c.adhesion for c in self.checks) / len(self.checks) if self.checks else 0.0

    @property
    def all_passed(self):
        return all(c.passed for c in self.checks)


# ── config ────────────────────────────────────────────────────────────────────
def load_config(path):
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    if "samples" not in cfg or not isinstance(cfg["samples"], dict):
        raise ValueError(f"{path}: missing top-level 'samples' object")
    return cfg


def effective_sensors(cfg, filename):
    """Merge the '*' block under the per-file block (per-file key wins)."""
    samples = cfg["samples"]
    merged = {}
    for scope in ("*", filename):
        block = samples.get(scope)
        if not isinstance(block, dict):
            continue
        for sensor, spec in block.items():
            merged.setdefault(sensor, {}).update(spec)
    return merged


# ── scoring ───────────────────────────────────────────────────────────────────
def score_text(scorer_url, params, text, timeout):
    """POST the specimen to the scorer, same shape as app/exp's proxy."""
    query = urllib.parse.urlencode(params) if params else ""
    url = f"{scorer_url.rstrip('/')}/api/v1/score" + (f"?{query}" if query else "")
    req = urllib.request.Request(
        url,
        data=text.encode("utf-8"),
        method="POST",
        headers={"content-type": "text/plain"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    # {key,similarity,distance,dotproduct} -> key -> {similarity_pct, distance}
    out = {}
    for r in payload.get("results", []):
        out[r["key"]] = {
            "similarity": round(r["similarity"] * 100.0, 1),  # 0..100, like the dashboard
            "distance": r["distance"],
        }
    return out


def evaluate(sensors_spec, scored):
    """Turn a merged sensor spec + scored values into Rows and atomic Checks."""
    rows, checks = [], []
    for sensor in sorted(sensors_spec):
        spec = sensors_spec[sensor]
        for metric in ("similarity", "distance"):
            bounds = spec.get(metric)
            if not isinstance(bounds, dict):
                continue
            present = sensor in scored
            value = scored[sensor][metric] if present else None
            lo = float(bounds.get("min", 0))
            hi = float(bounds.get("max", 100))
            row_checks = []
            for bound, key in (("min", "min"), ("max", "max")):
                if key not in bounds:
                    continue
                chk = Check(sensor, metric, bound, float(bounds[key]), value, present, lo, hi)
                checks.append(chk)
                row_checks.append(chk)
            if row_checks:
                rows.append(Row(sensor, metric, value, present, lo, hi, row_checks))
    return rows, checks


# ── SVG helpers ───────────────────────────────────────────────────────────────
def esc(s):
    return html.escape(str(s), quote=True)


def svg_open(w, h):
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" '
            f'preserveAspectRatio="xMidYMid meet" font-family="system-ui,-apple-system,'
            f'\'Segoe UI\',sans-serif" role="img">')


def bar_chart(sample):
    """Horizontal bars: each sensor's score, band shaded, guides at the bounds."""
    rows = sample.rows
    pad_l, pad_r, pad_t, pad_b = 210, 70, 14, 30
    row_h = 30
    plot_w = 560
    h = pad_t + pad_b + row_h * max(1, len(rows))
    w = pad_l + pad_r + plot_w
    axmax = max([100.0] + [r.value for r in rows if r.present] +
                [r.hi for r in rows])
    axmax = math.ceil(axmax / 10.0) * 10.0

    def x(v):
        return pad_l + (v / axmax) * plot_w

    out = [svg_open(w, h)]
    # x gridlines every 20 units
    t = 0
    while t <= axmax + 0.001:
        gx = x(t)
        out.append(f'<line x1="{gx:.1f}" y1="{pad_t}" x2="{gx:.1f}" y2="{h-pad_b}" '
                   f'stroke="var(--grid)" stroke-width="1"/>')
        out.append(f'<text x="{gx:.1f}" y="{h-pad_b+16}" fill="var(--muted)" '
                   f'font-size="11" text-anchor="middle" '
                   f'style="font-variant-numeric:tabular-nums">{int(t)}</text>')
        t += 20
    for i, r in enumerate(rows):
        cy = pad_t + i * row_h + row_h / 2
        by = cy - 6
        # allowed band
        bx0, bx1 = x(r.lo), x(r.hi)
        out.append(f'<rect x="{bx0:.1f}" y="{pad_t+i*row_h+2:.1f}" width="{max(0,bx1-bx0):.1f}" '
                   f'height="{row_h-4:.1f}" fill="var(--band)" opacity=".30" rx="3"/>')
        # bar
        color = "var(--good)" if r.passed else "var(--critical)"
        label = f"{r.sensor}"
        if r.present:
            bw = max(0.0, x(r.value) - pad_l)
            out.append(f'<rect x="{pad_l}" y="{by:.1f}" width="{bw:.1f}" height="12" '
                       f'rx="4" fill="{color}"/>')
            out.append(f'<text x="{x(r.value)+6:.1f}" y="{cy+4:.1f}" fill="var(--ink-2)" '
                       f'font-size="11" style="font-variant-numeric:tabular-nums">'
                       f'{r.value:g}</text>')
        else:
            out.append(f'<text x="{pad_l+6}" y="{cy+4:.1f}" fill="var(--critical)" '
                       f'font-size="11">absent from model</text>')
        # bound guides
        for bnd, xv in (("min", r.lo), ("max", r.hi)):
            drawn = (bnd == "min" and r.lo > 0) or (bnd == "max" and r.hi < axmax)
            if drawn:
                out.append(f'<line x1="{x(xv):.1f}" y1="{pad_t+i*row_h+2:.1f}" '
                           f'x2="{x(xv):.1f}" y2="{pad_t+i*row_h+row_h-2:.1f}" '
                           f'stroke="var(--axis)" stroke-width="1.5" stroke-dasharray="2 2"/>')
        # left label: sensor + metric chip (truncated to the gutter; full key on hover)
        shown = label if len(label) <= 24 else label[:23] + "…"
        out.append(f'<text x="{pad_l-46}" y="{cy+4:.1f}" fill="var(--ink)" font-size="12" '
                   f'text-anchor="end"><title>{esc(label)}</title>{esc(shown)}</text>')
        out.append(f'<text x="{pad_l-8}" y="{cy+4:.1f}" fill="var(--muted)" font-size="10" '
                   f'text-anchor="end">{r.metric[:4]}</text>')
    out.append(f'<line x1="{pad_l}" y1="{pad_t}" x2="{pad_l}" y2="{h-pad_b}" '
               f'stroke="var(--axis)" stroke-width="1"/>')
    out.append("</svg>")
    return "".join(out)


def adhesion_hist(checks):
    """Histogram of per-check adhesion: x = margin bin (edge→safe), y = count."""
    w, h = 840, 220
    pad_l, pad_r, pad_t, pad_b = 44, 20, 22, 40
    bins = 10
    counts = [0] * bins
    for c in checks:
        idx = min(bins - 1, int(c.adhesion * bins))
        counts[idx] += 1
    ymax = max(counts + [1])
    pw = w - pad_l - pad_r
    ph = h - pad_t - pad_b
    binw = pw / bins
    gap = 3  # surface gap between bars

    def py(v):
        return pad_t + ph - (v / ymax) * ph

    out = [svg_open(w, h)]
    # y gridlines + count ticks
    for gy in range(0, ymax + 1, max(1, math.ceil(ymax / 4))):
        yy = py(gy)
        out.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{w-pad_r}" y2="{yy:.1f}" '
                   f'stroke="var(--grid)" stroke-width="1"/>')
        out.append(f'<text x="{pad_l-6}" y="{yy+4:.1f}" fill="var(--muted)" font-size="11" '
                   f'text-anchor="end" style="font-variant-numeric:tabular-nums">{gy}</text>')
    # bars, one per 10% margin bin
    for i, cnt in enumerate(counts):
        bx = pad_l + i * binw + gap / 2
        bw = binw - gap
        top = py(cnt)
        if cnt:
            out.append(f'<rect x="{bx:.1f}" y="{top:.1f}" width="{bw:.1f}" '
                       f'height="{pad_t+ph-top:.1f}" rx="3" fill="var(--series-1)"/>')
            out.append(f'<text x="{bx+bw/2:.1f}" y="{top-5:.1f}" fill="var(--ink-2)" '
                       f'font-size="10" text-anchor="middle" '
                       f'style="font-variant-numeric:tabular-nums">{cnt}</text>')
    # x axis: bin-boundary ticks every 20%
    for k in range(0, bins + 1, 2):
        xx = pad_l + k * binw
        out.append(f'<text x="{xx:.1f}" y="{h-pad_b+18:.1f}" fill="var(--muted)" font-size="11" '
                   f'text-anchor="middle">{k*10}%</text>')
    out.append(f'<line x1="{pad_l}" y1="{pad_t+ph:.1f}" x2="{w-pad_r}" y2="{pad_t+ph:.1f}" '
               f'stroke="var(--axis)" stroke-width="1"/>')
    out.append("</svg>")
    return "".join(out)


def mean_curve(samples):
    """Mean adhesion per specimen as a line with markers."""
    scored = [s for s in samples if s.checks]
    w, h = 840, 240
    pad_l, pad_r, pad_t, pad_b = 44, 20, 16, 84
    pw = w - pad_l - pad_r
    ph = h - pad_t - pad_b
    n = max(1, len(scored))

    def px(i):
        return pad_l + (i + 0.5) / n * pw

    def py(v):
        return pad_t + ph - v * ph

    out = [svg_open(w, h)]
    for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
        yy = py(frac)
        out.append(f'<line x1="{pad_l}" y1="{yy:.1f}" x2="{w-pad_r}" y2="{yy:.1f}" '
                   f'stroke="var(--grid)" stroke-width="1"/>')
        out.append(f'<text x="{pad_l-6}" y="{yy+4:.1f}" fill="var(--muted)" font-size="11" '
                   f'text-anchor="end" style="font-variant-numeric:tabular-nums">'
                   f'{int(frac*100)}</text>')
    if scored:
        pts = [(px(i), py(s.mean_adhesion)) for i, s in enumerate(scored)]
        line = "M " + " L ".join(f'{x:.1f} {y:.1f}' for x, y in pts)
        out.append(f'<path d="{line}" fill="none" stroke="var(--series-1)" stroke-width="2"/>')
        for (x, y), s in zip(pts, scored):
            col = "var(--good)" if s.all_passed else "var(--critical)"
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="{col}" '
                       f'stroke="var(--surface-1)" stroke-width="2"/>')
            out.append(f'<text x="{x:.1f}" y="{y-10:.1f}" fill="var(--ink-2)" font-size="10" '
                       f'text-anchor="middle" style="font-variant-numeric:tabular-nums">'
                       f'{s.mean_adhesion*100:.0f}</text>')
            short = s.name[:-4] if s.name.endswith(".txt") else s.name
            out.append(f'<text x="{x:.1f}" y="{h-pad_b+16:.1f}" fill="var(--muted)" '
                       f'font-size="10" text-anchor="end" transform="rotate(-40 {x:.1f} '
                       f'{h-pad_b+16:.1f})">{esc(short)}</text>')
    out.append(f'<line x1="{pad_l}" y1="{pad_t+ph:.1f}" x2="{w-pad_r}" y2="{pad_t+ph:.1f}" '
               f'stroke="var(--axis)" stroke-width="1"/>')
    out.append("</svg>")
    return "".join(out)


def write_report(path, samples, scorer_url):
    scored = [s for s in samples if s.checks]
    total_checks = sum(len(s.checks) for s in scored)
    failed = sum(1 for s in scored for c in s.checks if not c.passed)
    overall = (sum(s.mean_adhesion for s in scored) / len(scored) * 100) if scored else 0.0
    peak = max((c.adhesion for s in scored for c in s.checks), default=0.0) * 100

    cards = []
    for s in samples:
        if s.skipped:
            cards.append(f'<section class="card"><h2>{esc(s.name)} '
                         f'<span class="skip">skipped — {esc(s.skipped)}</span></h2></section>')
            continue
        nfail = sum(1 for c in s.checks if not c.passed)
        status = (f'<span class="pill bad">{nfail} failing</span>' if nfail
                  else '<span class="pill ok">all hold</span>')
        cards.append(
            f'<section class="card"><h2>{esc(s.name)} {status}'
            f'<span class="sub">mean adhesion {s.mean_adhesion*100:.0f}%</span></h2>'
            f'<div class="scroll">{bar_chart(s)}</div></section>')

    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aldous sensor tolerances</title>
<style>
  :root {{ {CSS_VARS} }}
  @media (prefers-color-scheme: dark) {{ :root {{ {CSS_VARS_DARK} }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:var(--plane); color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }}
  .wrap {{ max-width: 960px; margin:0 auto; padding:28px 20px 64px; }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  .lede {{ color:var(--ink-2); margin:0 0 22px; }}
  .lede code {{ color:var(--muted); }}
  .kpis {{ display:flex; gap:14px; flex-wrap:wrap; margin:0 0 26px; }}
  .kpi {{ background:var(--surface-1); border:1px solid var(--border); border-radius:10px;
    padding:12px 16px; min-width:120px; }}
  .kpi b {{ display:block; font-size:26px; font-variant-numeric:tabular-nums; }}
  .kpi span {{ color:var(--muted); font-size:12px; }}
  .card {{ background:var(--surface-1); border:1px solid var(--border); border-radius:10px;
    padding:16px 18px; margin:0 0 18px; }}
  .card h2 {{ font-size:15px; margin:0 0 10px; display:flex; align-items:baseline;
    gap:10px; flex-wrap:wrap; }}
  .scroll {{ overflow-x:auto; }}
  .sub {{ color:var(--muted); font-size:12px; font-weight:400; margin-left:auto; }}
  .pill {{ font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; }}
  .pill.ok {{ color:var(--good); background:color-mix(in srgb,var(--good) 14%,transparent); }}
  .pill.bad {{ color:var(--critical); background:color-mix(in srgb,var(--critical) 14%,transparent); }}
  .skip {{ color:var(--warning); font-size:12px; font-weight:400; }}
  .legend {{ color:var(--muted); font-size:12px; margin:6px 0 0; }}
  .sw {{ display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle;
    margin:0 4px 0 12px; }}
</style></head><body><div class="wrap">
<h1>Aldous sensor tolerances</h1>
<p class="lede">Specimens scored through <code>{esc(scorer_url)}</code>. A sensor
holds when its score stays inside the shaded band; the bar turns
<span style="color:var(--critical)">red</span> on a breach. Adhesion is the
regression margin left inside the band.</p>
<div class="kpis">
  <div class="kpi"><b>{overall:.0f}%</b><span>overall adhesion</span></div>
  <div class="kpi"><b>{peak:.0f}%</b><span>peak adhesion</span></div>
  <div class="kpi"><b>{len(scored)}</b><span>specimens scored</span></div>
  <div class="kpi"><b>{total_checks}</b><span>checks</span></div>
  <div class="kpi"><b style="color:{'var(--critical)' if failed else 'var(--good)'}">{failed}</b>
    <span>failing</span></div>
</div>

{''.join(cards)}

<section class="card"><h2>Adhesion distribution — all checks</h2>
  <div class="scroll">{adhesion_hist([c for s in scored for c in s.checks])}</div>
  <p class="legend">bar height counts checks; each bar is a 10%-wide margin bin.
  Bars on the left = sensors sitting near a limit (little regression headroom);
  bars on the right = deep in the safe zone.</p></section>

<section class="card"><h2>Mean adhesion by specimen</h2>
  <div class="scroll">{mean_curve(samples)}</div>
  <p class="legend"><span class="sw" style="background:var(--good)"></span>all hold
  <span class="sw" style="background:var(--critical)"></span>has a breach — higher is
  more margin before the next tuning could regress it.</p></section>

</div></body></html>"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)


# ── console ───────────────────────────────────────────────────────────────────
def print_report(samples):
    for s in samples:
        if s.skipped:
            print(f"\n  {s.name}: skipped ({s.skipped})")
            continue
        nfail = sum(1 for c in s.checks if not c.passed)
        tag = "FAIL" if nfail else "ok"
        print(f"\n  {s.name}  [{tag}]  mean adhesion {s.mean_adhesion*100:4.0f}%")
        for c in s.checks:
            mark = "✓" if c.passed else "✗"
            if not c.present:
                print(f"      {mark} {c.sensor:<38} {c.metric[:4]} {c.bound}"
                      f"  — absent from model")
                continue
            print(f"      {mark} {c.sensor:<38} {c.metric[:4]} {c.bound}{c.limit:>6.1f}"
                  f"  value {c.value:>6.1f}  adhesion {c.adhesion*100:3.0f}%")


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Aldous sensor regression harness.")
    ap.add_argument("-c", "--config", default="tolerances.json",
                    help="tolerance config (default: ./tolerances.json)")
    ap.add_argument("--scorer-url", default=None,
                    help="override scorer base URL (else config / $SCORER_URL / :3271)")
    ap.add_argument("-r", "--report", default="sensor-report.html",
                    help="HTML report path (default: ./sensor-report.html)")
    ap.add_argument("--no-report", action="store_true", help="skip the HTML report")
    ap.add_argument("--timeout", type=float, default=30.0, help="per-request seconds")
    args = ap.parse_args()

    try:
        cfg = load_config(args.config)
    except FileNotFoundError:
        print(f"error: config not found: {args.config}", file=sys.stderr)
        return 2
    except (ValueError, json.JSONDecodeError) as e:
        print(f"error: bad config {args.config}: {e}", file=sys.stderr)
        return 2

    scorer_url = (args.scorer_url or os.environ.get("SCORER_URL")
                  or cfg.get("scorer_url") or "http://127.0.0.1:3271")
    params = cfg.get("score_params") or {}

    txt_files = sorted(glob.glob("*.txt"))
    if not txt_files:
        print("error: no .txt specimens in the current directory", file=sys.stderr)
        return 2

    print(f"scorer: {scorer_url}   specimens: {len(txt_files)}")

    samples = []
    reachable = True
    for name in txt_files:
        s = SampleResult(name)
        sensors_spec = effective_sensors(cfg, name)
        with open(name, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        if not text.strip():
            s.skipped = "empty specimen"
            samples.append(s)
            continue
        if not sensors_spec:
            s.skipped = "no sensors configured"
            samples.append(s)
            continue
        try:
            scored = score_text(scorer_url, params, text, args.timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"\nerror: could not reach scorer for {name}: {e}", file=sys.stderr)
            reachable = False
            break
        s.rows, s.checks = evaluate(sensors_spec, scored)
        samples.append(s)

    if not reachable:
        print("error: scorer unreachable — is `dece-semsaged` up? "
              "(semsage start <model>)", file=sys.stderr)
        return 3

    print_report(samples)

    if not args.no_report:
        try:
            write_report(args.report, samples, scorer_url)
            print(f"\nreport: {args.report}")
        except OSError as e:
            print(f"warning: could not write report: {e}", file=sys.stderr)

    failing = sum(1 for s in samples for c in s.checks if not c.passed)
    scored_n = sum(1 for s in samples if s.checks)
    peak = max((c.adhesion for s in samples for c in s.checks), default=0.0) * 100
    print(f"\nsummary: {scored_n} scored, {failing} failing check(s), peak adhesion {peak:.0f}%")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
