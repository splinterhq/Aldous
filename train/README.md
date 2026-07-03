# train/ — DECE model training scripts

This directory holds everything needed to **compile a DECE model** from source: a
runnable trainer script per model, the helpers it leans on, and a test corpus for
validating the result. Running the trainer embeds a curated set of phrases and
writes a compiled `.dece` store to `dece/<model>/<model>.dece`, which the scorer
then serves.

Today there is exactly one model here — **Aldous_1-2** — and this README uses it
as the worked example. Everything below generalizes to any future
`train/<Model>` you add: the file naming (`<Model>`, `<Model>.lua`, `<Model>.rc`)
is a convention that [`util/lib/model_funcs.sh`](../util/lib/model_funcs.sh)
depends on.

## Quick start: training Aldous_1-2

The trainer is meant to be run **from the install root** (not from inside
`train/`), because all paths it uses are relative to the root:

```sh
cd /home/tinkertim/code/semsage     # the install root
util/install_nomic                  # once — fetches the embedder (gguf/nomic.gguf)
train/Aldous_1-2                    # compiles dece/Aldous_1-2/Aldous_1-2.dece
```

That's it. On a typical laptop the full fill takes ~15 minutes; the script prints
its own timing when it finishes:

```
Vector fill complete: filled all keys and shunts in 14m 32s (872s total).
```

### What it needs first

- **The Splinter toolchain** — `splinterpctl` and `splinferencep` on your `PATH`.
  Installed by [`util/install_splinter`](../util/install_splinter).
- **The embedder model** — `gguf/nomic.gguf` (nomic-embed-text v1.5). Fetched by
  [`util/install_nomic`](../util/install_nomic). The trainer stands up its own
  embedding butler against this model while it runs; you do **not** need the
  systemd services from `app/svcs/` for training.

### What it produces

- `dece/Aldous_1-2/Aldous_1-2.dece` — the compiled model store the scorer loads.

### Re-running

The trainer is safe to re-run; it re-initializes the store and refills it. Pass
an alternate name as the first argument to compile under a different model name
(useful for experiments):

```sh
train/Aldous_1-2 Aldous_1-2-experiment   # writes dece/Aldous_1-2-experiment/...
```

If you only want to adjust **one** sensor without a full recompile, use
`semsage retrain <model> <keyname>` instead — it extracts that single sensor,
lets you edit it, and recompiles just that key back into the model.

## The files

| File | Role |
|---|---|
| `Aldous_1-2` | The **trainer** — an executable `/bin/sh` script. The human-editable definition of the model: one `SENSOR` / `SHUNT` call per concept. Run this to compile the model. |
| `Aldous_1-2.lua` | The **per-phrase provisioner**. Invoked once per sensor by the trainer; embeds each phrase and collapses them into a centroid + variance pair. You rarely edit this. |
| `Aldous_1-2.rc` | The **bloom/label rc** for this model — maps human-readable label names (e.g. `outlook-attractor`) to the bit masks the scorer uses. |
| `Aldous_1-2.md` | **Key nomenclature reference** — what the `+`, `|`, `@`, `%`, `__`, `~~` key prefixes mean and what each `model_funcs.sh` function does. Read this before editing the trainer. |
| `ipc.rc` | Bloom rc for the **IPC bus signalling** used during training (data-ready / data-waiting / shunt signals between the trainer and the embedding butler). |
| `tests/` | Validation corpus and the `check_sensors.py` harness. See [`tests/README.md`](tests/README.md). |

### `Aldous_1-2` — the trainer (start here)

This is the file you edit to change the model. Its shape:

1. Sets the model name (defaults to its own basename, `Aldous_1-2`).
2. Sources [`util/lib/model_funcs.sh`](../util/lib/model_funcs.sh), which defines
   `INIT`, `START_EMBEDDER`, `SENSOR`, `MONOLITHIC_SHUNT`, etc.
3. `INIT`s the store and `START_EMBEDDER`s the embedding butler.
4. A long "**EDITABLE MODEL**" block of `SENSOR` calls — each one names a key,
   provides a `^`-delimited list of example phrases, and assigns a label:

   ```sh
   SENSOR "|--outlook" \
       "The worst possible outcome.^\
       A total failure in both planning and execution.^\
       Utterly catastrophic, a total failure." \
       "outlook-attractor"
   ```

5. `INTRINSIC_SHUNT`s (the `~~` guardrails), then `STOP_EMBEDDER`.
6. A batch of `MONOLITHIC_SHUNT`s finalized in one fast pass by
   `POST_TRAIN_MONOLITHIC_SHUNTS`.

The three sensor-defining verbs differ in the math they run — `SENSOR` and
`INTRINSIC_SHUNT` compute a centroid **and** diagonal variance (a `.1` companion
slot), while `MONOLITHIC_SHUNT` mean-pools its phrases into a single fast
tripwire with no variance. [`Aldous_1-2.md`](Aldous_1-2.md) documents each in
detail, along with the key-prefix nomenclature (`+`/`++` intensity tiers, `|`
unidirectional axes, `@` scalars, `%` density probes, `__`/`~~` shunts).

### `Aldous_1-2.lua` — the provisioner

`model_funcs.sh` runs this once per `SENSOR` via `splinterpctl lua`. Given a base
key and a `^`-delimited payload it: splits the phrases, deposits each into a temp
slot, waits for the live embedder to fill in the 768-d vectors, then writes the
**centroid** (mean → "where the concept sits") into the base key and the
**diagonal variance** (spread → "how tight the concept is") into `<key>.1`. The
scorer reads both for its standardized (diagonal-Mahalanobis) distance. Editing
this changes the math for *every* sensor, so treat it as infrastructure.

### `Aldous_1-2.rc` / `ipc.rc` — bloom rc files

These map label names to bit masks. `Aldous_1-2.rc` is baked into the
`splinterpctl` alias in `model_funcs.sh` (`--rc-file train/Aldous_1-2.rc`) so
that labels like `outlook-attractor` or `intrinsic-shunt` used in the trainer
resolve to the right bloom bits in the store. `ipc.rc` covers the signalling bits
the trainer and embedding butler use to hand phrases back and forth over the bus.

## Naming convention (for new models)

`model_funcs.sh` derives the `.lua` and `.rc` paths from the model name, so a new
model `Foo` needs, in this directory:

- `train/Foo` — the trainer (sets `ALDOUS=Foo` — or its basename — before sourcing `model_funcs.sh`)
- `train/Foo.lua` — its provisioner
- `train/Foo.rc` — its label rc

## See also

- [`Aldous_1-2.md`](Aldous_1-2.md) — key nomenclature + function reference.
- [`tests/README.md`](tests/README.md) — validating a compiled model.
- [`util/lib/model_funcs.sh`](../util/lib/model_funcs.sh) — the provisioning helpers the trainer calls.
- The top-level [`README.md`](../README.md) — where training fits in the full semsage workflow (train → serve via `app/svcs/` → query with `semsage`).
