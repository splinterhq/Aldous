# Aldous 1-2.0 Key Nomenclature Reference Guide

This document explains the key nomenclature (prefixes) and the shell functions
used to construct Aldous models via `model_funcs.sh`.

## Key Nomenclature (Prefixes)

Aldous relies on a specific key nomenclature to tell the scoring engine and
frontend UI how to handle, group, and render the resulting vectors.

- **`-` / `--` / `+` / `++` (Gradation Tiers)**
  - **What it is:** Intensity markers for graduated emotional valence sensors.
  - **Example:** `+anger` (personal grievance) vs `++anger` (collective
    outrage).
  - **Usage:** Determines the severity or scale of an emotion. The frontend uses
    these to construct stacked spectrum bars.

- **`|` (Unidirectional Axes)**
  - **What it is:** A specialized prefix for pillars that act as directional
    sliders (e.g., demobilized vs. mobilized).
  - **Example:** `|--action` through `|++action`.
  - **Usage:** These keys bypass value gates (min similarity/dot) and elbow cuts
    in the C scorer, guaranteeing they are always present in the response.

- **`@` (Pragmatic Scalars / Saturation Indexes)**
  - **What it is:** Unsigned, "flattened" modifiers that measure the depth of a
    specific tonal context (like Sarcasm, Gratitude, or Sycophancy) rather than
    an emotional gradient.
  - **Example:** `@Sarcasm`, `@Reactionary`.
  - **Usage:** Used as an additive modifier to interpret the context of other
    triggered sensors.

- **`%` (Density Probes / Nyquist Floors)**
  - **What it is:** A baseline reference vector representing the overall ambient
    intensity of an entire group (e.g., emotional valence, structural,
    partisan).
  - **Example:** `%markov_ev`.
  - **Usage:** Acts as an input gain meter. If a specimen trips this, it shows
    the text is heavily utilizing language from that specific category, serving
    as a baseline noise floor.

- **`__` (Monolithic, Mean-Pooled Shunts)**
  - **What it is:** Fast, community-editable Trust & Safety circuit
    breakers[cite: 5, 8].
  - **Example:** `__shunt_misogyny`, `__shunt_ai_sycophancy`.
  - **Usage:** These require only a single embedding pass to provision and do
    not calculate variance[cite: 5, 8]. They sit outside standard valence
    distributions and must not be fed into elbow math.

- **`~~` (Intrinsic, Centroid-Weighted Shunts)**
  - **What it is:** Deep, heavily-tuned guardrails designed for serious,
    universally problematic content (like predation or incitement to
    violence)[cite: 5, 8].
  - **Example:** `~~shunt_coercion_from_or_against_guardian`.
  - **Usage:** Unlike monolithic shunts, these _do_ compute diagonal variance
    vectors (yielding a `.1` companion slot), making them ideal for Latent
    Concept Erasure (LCE).

## Model Provisioning Functions

These functions are provided by `model_funcs.sh` and are used sequentially in
the `Aldous_1-2` training script to build the `.dece` model over the Splinter
IPC bus.

### Setup & Teardown

- **`INIT <model_path> <slots> <max_val>`**
  - Initializes the Splinter shared memory store. Prepares the necessary
    geometry (key slots and maximum string payload size) for the embedding
    pipeline.

- **`START_EMBEDDER <model_path>`**
  - Spins up the `splinference` butler daemon. This background process monitors
    the Splinter store for new phrases, embeds them live, and deposits the
    768-dimensional vectors back into the store.

- **`STOP_EMBEDDER`**
  - Shuts down the `splinference` daemon. Called immediately after the centroid
    and variance computations are finished, just before defining the monolithic
    shunts.

### Sensor Definitions

- **`SENSOR "<key>" "<phrases>" "<label>"`**
  - The primary function for defining a graduated tier, scalar, or density
    probe.
  - It accepts a `^`-delimited string of phrases. It triggers the Lua compiler
    to isolate each phrase, ask the embedder for vectors, and then compute the
    centroid and the diagonal variance. The label (e.g., `"ev-attractor"`)
    assigns it to an internal bloom filter.

- **`INTRINSIC_SHUNT "<key>" "<phrases>"`**
  - Functions identically to `SENSOR` under the hood (computing centroid and
    variance), but uses the `~~` key prefix so the scoring engine knows to
    exempt it from elbow cuts when requested.

### Monolithic Shunts

- **`MONOLITHIC_SHUNT "<key>" "<phrases>"`**
  - Defines a mean-pooled Trust & Safety tripwire. It does not invoke the Lua
    variance calculations. The provided phrases are embedded as a single string
    to create a fast, rigid hyper-diamond boundary.

- **`POST_TRAIN_MONOLITHIC_SHUNTS "<model_name>"`**
  - Executes a single-shot batch embedding pass for all declared
    `MONOLITHIC_SHUNT` definitions. This is called at the very end of the script
    for extreme speed (averaging ~1 second per shunt).
