# Sample Texts 

All textx in this directory are out of US Copyright because they:

 - Were created by the US Government, Or, 
 - Are at least 95 years past their publication date making January 1, 1930 the cutoff, Or
 - Both situations, or another exception where Copyright law does not apply or has been waived
   through a copyleft license.

These texts help ensure safe and successful continuous integration of Aldous' sensors.

## `check_sensors.py` — the tolerance harness

`check_sensors.py` scores every `.txt` in this directory through the running
scorer (the same raw `POST /api/v1/score` `app/exp` makes) and asserts that
configured sensors hold their similarity/distance values inside declared bands.
Standard-library Python 3, no dependencies.

```sh
semsage start Aldous_1-2.dece      # scorer must be up (default :3271)
cd train/tests
./check_sensors.py                 # reads ./tolerances.json, writes sensor-report.html
```

It exits non-zero if any sensor breaches its band, so it drops straight into CI.
Useful flags: `--config <file>`, `--scorer-url <url>` (also honours `$SCORER_URL`),
`--report <file>` / `--no-report`.

**Config (`tolerances.json`).** Each check is a `(sensor, metric, bound)` triple.
Under a sensor, name `similarity` (a 0–100 percentage) and/or `distance` (the raw
SED float), each with an optional `min` and/or `max` — unset bounds default to
`min 0`, `max 100`. The `*` block applies to every specimen; a per-file block is
merged over it (per-file wins on a clash):

```json
{
  "samples": {
    "*": { "~~shunt_inciting_violent_action": { "similarity": { "max": 62 } } },
    "fdr_pearl_harbor.txt": {
      "++tension": { "similarity": { "min": 58, "max": 70 } },
      "+joy":      { "distance":   { "max": 42 } }
    }
  }
}
```

For every check it also records *adhesion* — how much margin the value keeps
inside its band (0 at the edge, 1 at the far side) — i.e. how much a future
tuning could drift the sensor before it regresses.

**The graphs.** The generated `sensor-report.html` is self-contained
(light/dark, inline SVG — no assets, no network) and carries three kinds of
graph:

- **Per-specimen bars** — one card per specimen, a horizontal bar for each
  configured sensor showing its score against its band. The band is shaded and
  the declared bounds are drawn as guides; a bar turns red when the score
  breaches its band. This is the "did it hold?" view.
- **Adhesion distribution** — a histogram over *all* checks. Each bar is a
  10%-wide margin bin and its height counts the checks that fall in it. Bars on
  the left are sensors sitting near a limit (little regression headroom); bars
  on the right are deep in the safe zone.
- **Mean adhesion by specimen** — a line with a marker per specimen, green
  where every sensor holds and red where one breached. Higher means more margin
  before the next tuning could regress that specimen.

A KPI row up top summarises overall and peak adhesion, specimens scored, total
checks, and how many are failing.

The per-file bands in `tolerances.json` were seeded from `factory-benchmarks/`
(~6pt similarity margin, ~5 distance margin around each benchmark value). To
eyeball a specimen by hand instead of running the harness, use the dashboard's
file-upload button and select it.

## Song Lyrics Are A Better Demonstration

Just search for the lyrics to songs you know well and paste the lyrics into the explorer. Most
well-known lyrics are still in copyright (You Are My Sunshine is 1940), so they can't be distributed
in a public-facing Github repository.

