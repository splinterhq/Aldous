# `dece-semsaged`, the DECE scoring gateway

`dece-semsaged` is the loopback-only HTTP inference gateway for a DECE model. It
loads a trained corpus into memory once at startup, embeds each incoming text
**specimen** into a vector, and scores that vector against every cached corpus
key — returning cosine similarity, a (variance-weighted) distance, and the raw
dot product for each. The [DECE explorer](../exp) (`app/exp`) is the usual
front end; it proxies its **Score** requests here.

The whole gateway is a single translation unit — [dece-semsaged.cpp](dece-semsaged.cpp) —
built against `libsplinter` and the vendored [httplib.h](httplib.h).

## Build

```sh
make            # build ./dece-semsaged
make run        # build, then serve $(MODEL) over $(BUS) on $(PORT)
make clean
```

`libsplinter` (the `.dece`/IPC store library) is expected under `/usr/local`;
override `PREFIX` or the `SPLINTER_*` paths for a different location. TLS support
(needed only to reach an `https://` external embedder) is compiled in via
`-DCPPHTTPLIB_OPENSSL_SUPPORT`, which pulls in `-lssl -lcrypto` (`libssl-dev`).

The built binary is git-ignored (see [.gitignore](.gitignore)).

## Run

```sh
dece-semsaged --model <name> [<name> ...] --bus <ipc_name> 
                [--journal dece-semsaged-journal.jsonl] 
                [--addr 127.0.0.1] [--port 8080] 
                [--threads N] [--timeout-ms 10000]
```

| Flag           | Default                        | Purpose                                                                 |
| -------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `--model`      | *(required)*                   | One or more corpus store **chunks**. Repeat the flag or list several after it; all merge into one logical model. |
| `--bus`        | *(required for IPC mode)*      | Live IPC bus name that `splinference` watches. Optional when an external embedder is configured. |
| `--journal`    | `scorer-journal.jsonl`         | Append-only JSONL request log.                                          |
| `--addr`       | `127.0.0.1`                    | Bind interface. Loopback by design — a front-end proxy reaches it here. |
| `--port`       | `3271`                         | Listen port.                                                            |
| `--threads`    | `0` (auto)                     | Worker pool size. `0` ⇒ `max(8, 2× cores)`.                             |
| `--timeout-ms` | `10000`                        | How long a request waits for an embedding before giving up.             |

## How it works

### Two embedding paths

A specimen has to become a vector before it can be scored. There are two mutually
exclusive ways to get that vector:

1. **IPC bus (default).** The specimen is written to a private scratch slot on the
   `splinter` bus keyed by a fresh UUID, labeled `EMBED`/`WAITING`, and the embed
   signal group is pulsed. The `splinference` daemon (watching the same label)
   embeds the slot and clears `WAITING`; the gateway polls the slot snapshot until
   the embedding is present, then reads the vector back.
2. **External embedder (opt-in).** If `SEMSAGE_EMBEDDING_URL` is set, the gateway
   POSTs the specimen to an OpenAI-compatible `/v1/embeddings` endpoint and parses
   the returned vector. The IPC bus is skipped entirely (and `--bus` is ignored).
   This lets a GPU/model that `splinference` can't run locally serve the vectors.

> Running both paths at once is a planned feature; today setting the URL disables
> the bus path.

### Corpus cache

At startup each `--model` chunk is opened in turn, and every base **VARTEXT** key
with a non-zero embedding is copied into a shared in-memory cache. The cache is
built before any worker thread runs and is read-only thereafter, so the HTTP
workers scan it lock-free. Duplicate keys across chunks are deduped (first chunk
wins), so several separately-trained chunks load as one monolithic model.

A key's `.1` **order** companion carries a sensor's diagonal **variance** vector.
Because a base and its variance may live in different chunks, variances are stashed
during load and paired with their bases only after all chunks are in
(`attach_variances`).

### Scoring

For each request the query vector is compared against every cached key:

- **similarity** — cosine similarity.
- **distance** — standardized (variance-weighted) Euclidean distance for sensors
  that carry a variance; plain Euclidean for variance-less keys (shunts, etc.).
- **dotproduct** — raw dot product.

Results are ranked by ascending distance (ties broken by descending similarity).

Special key classes are treated differently by the gates, the limit, and the
elbow cut:

| Prefix         | Meaning                    | Behavior                                                                 |
| -------------- | -------------------------- | ------------------------------------------------------------------------ |
| `\|`           | Unidirectional axis pillar | Always returned — bypasses every gate, the limit, and the elbow.         |
| `__shunt_`     | Monolithic shunt tripwire  | Normally gated; exempted with `?protect_shunts=1`.                       |
| `~~shunt_`     | Intrinsic shunt (sensor)   | Scored like a sensor; exempted from gate/limit/elbow with `?protect_shunts=1`. |
| `__…`          | Maintenance / moderation   | Held out of the elbow math (magnitudes sit outside the valence spread).  |
| `<base>.<n>`   | Order companion            | Never returned raw; `.1` folds into its base as variance.                |

The optional **elbow cutoff** (`?elbow=1`) finds the knee of the sorted-distance
curve and truncates the noisy tail, keeping only the results above the elbow (plus
the always-kept special keys).

## HTTP API

### `GET /healthz`

Liveness probe. Returns `200 ok`.

### `POST /api/v1/score`

The **request body is the raw text specimen** (not JSON). Query parameters tune
filtering and post-processing:

| Param             | Default        | Effect                                                                          |
| ----------------- | -------------- | ------------------------------------------------------------------------------- |
| `strip_code`      | off            | `1` strips non-intent tokens (`{}[]()~^<>\#`) before embedding, saving context. |
| `limit`           | `0` (all)      | Cap the number of ranked results (immune keys are always kept beyond the cut).  |
| `min_similarity`  | −∞ (disabled)  | Drop keys with cosine similarity below this.                                    |
| `min_dot`         | −∞ (disabled)  | Drop keys with dot product below this.                                          |
| `protect_shunts`  | off            | `1` exempts the whole shunt bank from the gates, limit, and elbow (debugging).  |
| `elbow`           | off            | `1` applies the elbow cutoff to trim the noise tail.                            |

Response (`application/json`):

```json
{
  "uuid": "…",
  "query_chars": 123,
  "count": 12,
  "results": [
    { "key": "+joy", "similarity": 0.671000, "distance": 34.512000, "dotproduct": 0.812345 }
  ]
}
```

Error statuses: `400` (empty body), `413` (body over the bus payload cap, or a
specimen that tokenizes past the model's context window — the daemon's diagnostic
is relayed), `502`/`504` (external embedder failed / timed out), `503` (bus full),
`504` (IPC embedding timed out — is `splinference` running?).

## Journal

Every scored request is appended to the JSONL journal (`--journal`) as one record
holding the UUID, timestamp, the specimen text, the JSON result returned to the
client, and the full query vector — a durable trace of what was scored and how.
Appends are serialized across worker threads and flushed per line.

## Environment

| Var                     | Purpose                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| `SEMSAGE_EMBEDDING_URL` | Full URL of an OpenAI-compatible `/v1/embeddings` endpoint. Set ⇒ external mode (bus skipped). |
| `SEMSAGE_EMBEDDING_AUTH`| Optional bearer token for that endpoint.                                          |
| `SEMSAGE_EMBEDDING_MODEL`| Optional model name; sent as `"model"` (required by OpenAI/vLLM, ignored by TEI/llama.cpp). |

```sh
# External embedder instead of the IPC bus:
SEMSAGE_EMBEDDING_URL=http://127.0.0.1:8090/v1/embeddings \
SEMSAGE_EMBEDDING_MODEL=nomic-embed-text \
  ./dece-semsaged --model ../../dece/Aldous_1-2/Aldous_1-2.dece --port 8080
```
