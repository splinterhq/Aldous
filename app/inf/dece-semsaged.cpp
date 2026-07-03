/**
 * HTTP scoring gateway. See README before changing.
 * License: Apache 2 
 */
#ifndef SPLINTER_EMBEDDINGS
#define SPLINTER_EMBEDDINGS
#endif

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#include <unistd.h>

#include "httplib.h"

/* Bridge C11 / C++ Atomic types */
using atomic_uint_least64_t = std::atomic_uint_least64_t;
using atomic_uint_least32_t = std::atomic_uint_least32_t;
using atomic_uint_least8_t  = std::atomic_uint_least8_t;
using atomic_int_least32_t  = std::atomic_int_least32_t;

#include "splinter.h"

/* Bit 0 == "embed this slot" — the label splinference watches. Must match the
 * daemon's splinter_watch_label_register(EMBED_LABEL, group). */
static constexpr uint64_t EMBED_LABEL   = 0x1ULL;
/* signal-data-waiting: marks a slot as awaiting downstream inference. */
static constexpr uint64_t WAITING_LABEL = 0x40ULL;
/* context-exceeded: splinference stamps this when a specimen tokenizes past the
 * model's context window. It can't embed an oversized sequence, so it zeroes the
 * vector, overwrites the slot value with a diagnostic string, raises this bloom,
 * and clears WAITING like any serviced deposit (see splinference.cpp's
 * mark_context_exceeded / CONTEXT_EXCEEDED_LABEL). Must match that value. */
static constexpr uint64_t ERROR_LABEL = 0x80ULL;

/* Mirror splinference.cpp's needs_embedding(): a slot is "not yet embedded"
 * when its vector magnitude is below 1e-6. The same threshold makes the
 * gateway's notion of "embedding present" agree with the daemon's. */
static constexpr double EMBED_PRESENT_EPS = 1e-6;

/* The cached corpus: one entry per VARTEXT key with a nonzero vector. Built
 * once at startup (before any worker thread runs) and read-only thereafter, so
 * the HTTP workers share it lock-free. */
struct CachedKey {
    std::string key;
    float       vec[SPLINTER_EMBED_DIM];        /* centroid (sensor) or tripwire (shunt) */
    bool        has_variance = false;           /* true once a ".1" variance is attached */
    float       variance[SPLINTER_EMBED_DIM];   /* diagonal variance; valid iff has_variance */
};

static std::vector<CachedKey> g_cache;

/* Captured once at startup from the IPC bus header. */
static uint32_t g_slots   = 0;
static uint32_t g_max_val = 0;

/* For signal-driven shutdown. */
static httplib::Server *g_server = nullptr;

/* Append-only JSONL journal. Workers serialize their appends on this mutex. */
static FILE       *g_journal = nullptr;
static std::mutex  g_journal_mu;

/* ---- External embedder (optional) --------------------------------------
 * When SEMSAGE_EMBEDDING_URL is set, specimens are embedded by POSTing them to
 * an OpenAI-compatible /v1/embeddings endpoint over HTTP instead of round-
 * tripping through the splinference IPC bus. This lets an external GPU/model
 * serve vectors splinference can't produce locally. The two paths are mutually
 * exclusive today (URL set => IPC bus skipped); running both at once is a
 * planned feature, so the handle_score branch is kept isolated to one path. */
static bool        g_external_embed = false;
static std::string g_embed_url;      /* full URL, for logging/errors                  */
static std::string g_embed_origin;   /* scheme://host[:port] for httplib::Client      */
static std::string g_embed_path;     /* request path, e.g. /v1/embeddings             */
static std::string g_embed_auth;     /* bearer token (SEMSAGE_EMBEDDING_AUTH)          */
static std::string g_embed_model;    /* optional model name (SEMSAGE_EMBEDDING_MODEL)  */

/* Payload cap used when serving without an IPC bus (no bus header to read a
 * max_val_sz from). Bounds the request body an external embedder must accept. */
static constexpr uint32_t EXTERNAL_DEFAULT_MAX_VAL = 1u << 20;  /* 1 MiB */


static std::string json_escape(const char *s, size_t n) {
    std::string o;
    o.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    return o;
}

static std::string json_escape(const std::string &s) { return json_escape(s.data(), s.size()); }

/* Optionally strip non intent-load-bearing tokens from specimens to save context */
static std::string strip_code_tokens(const std::string &in) {
    static const std::string drop = "{}[]()~^<>\\#";
    std::string out;
    out.reserve(in.size());
    for (char c : in)
        if (drop.find(c) == std::string::npos) out.push_back(c);
    return out;
}

static double vec_magnitude(const float *v, int dim) {
    double s = 0.0;
    for (int i = 0; i < dim; ++i) s += (double)v[i] * (double)v[i];
    return std::sqrt(s);
}

static bool embedding_present(const float *v, int dim) {
    return vec_magnitude(v, dim) >= EMBED_PRESENT_EPS;
}

static float cosine_similarity(const float *a, const float *b, int dim) {
    float dot = 0.f, ma = 0.f, mb = 0.f;
    for (int i = 0; i < dim; ++i) { dot += a[i]*b[i]; ma += a[i]*a[i]; mb += b[i]*b[i]; }
    float denom = std::sqrt(ma) * std::sqrt(mb);
    return (denom < 1e-9f) ? 0.f : dot / denom;
}

/**
 * Fast and only requires two sets of vectors, but assumes a perfect circle. "good enough"
 * but not ideal for precision. Ideally the model has variance vectors, here if it doesn't.
 */
static float fast_euclidean_distance(const float *a, const float *b, int dim) {
    float sum = 0.f;
    for (int i = 0; i < dim; ++i) { float d = a[i] - b[i]; sum += d * d; }
    return std::sqrt(sum);
}

static float standardized_euclidean_distance(const float *query, 
                                             const float *centroid, 
                                             const float *variance, 
                                             int dim) {
    float sum = 0.0f;
    
    // An operational floor. If a dimension's variance is smaller than this, 
    // we treat it as this to prevent the dimension from acting as an infinite multiplier.
    // This may need adjusting to be aligned with the embedding model's spread.
    const float variance_floor = 0.01f; 

    for (int i = 0; i < dim; ++i) {
        float diff = query[i] - centroid[i];
        
        // Clamp the variance to the floor
        float effective_variance = variance[i] > variance_floor ? variance[i] : variance_floor;
        
        sum += (diff * diff) / effective_variance; 
    }
    
    return std::sqrt(sum);
}

static float dot_product(const float *a, const float *b, int dim) {
    float dot = 0.f;
    for (int i = 0; i < dim; ++i) dot += a[i] * b[i];
    return dot;
}

/**
 * Strips the semantic direction of 'motif' from 'specimen' using vector rejection.
 * @param specimen     The original 768D text vector.
 * @param motif        The 768D vector representing the concept to remove.
 * @param out_purified A pre-allocated 768D buffer to store the resulting vector.
 * @param dim          The dimensionality (SPLINTER_EMBED_DIM).
 */
void vector_reject(const float* specimen, const float* motif, 
                   float* out_purified, int dim) {
    float dot_sm = 0.0f; // specimen dot motif
    float dot_mm = 0.0f; // motif dot motif (magnitude squared)
    
    // Calculate the dot products simultaneously
    for (int i = 0; i < dim; ++i) {
        dot_sm += specimen[i] * motif[i];
        dot_mm += motif[i] * motif[i];
    }
    
    // Don't bother with zero vectors
    if (dot_mm < 1e-9f) {
        for (int i = 0; i < dim; ++i) {
            out_purified[i] = specimen[i];
        }
        return;
    }
    
    // Calculate the projection scalar
    float scalar = dot_sm / dot_mm;
    
    // Subtract the projected vector from the original specimen
    for (int i = 0; i < dim; ++i) {
        out_purified[i] = specimen[i] - (scalar * motif[i]);
    }
}

/* RFC 4122 v4 UUID. Fits comfortably in SPLINTER_KEY_MAX (36 + NUL < 64). The
 * RNG is thread_local so concurrent workers never share generator state. */
static std::string make_uuid() {
    static thread_local std::mt19937_64 rng(
        std::random_device{}() ^
        (uint64_t)std::chrono::steady_clock::now().time_since_epoch().count() ^
        ((uint64_t)(uintptr_t)&rng));
    uint64_t hi = rng(), lo = rng();
    hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL; /* version 4 */
    lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL; /* variant 1  */
    char b[37];
    snprintf(b, sizeof(b),
             "%08x-%04x-%04x-%04x-%012llx",
             (unsigned)(hi >> 32),
             (unsigned)((hi >> 16) & 0xFFFF),
             (unsigned)(hi & 0xFFFF),
             (unsigned)(lo >> 48),
             (unsigned long long)(lo & 0xFFFFFFFFFFFFULL));
    return std::string(b);
}


enum EmbedResult { EMBED_OK, EMBED_CONTEXT_EXCEEDED, EMBED_TIMEOUT };

static EmbedResult wait_for_embedding(const char *key, float *out, int timeout_ms) {
    using namespace std::chrono;
    const auto deadline = steady_clock::now() + milliseconds(timeout_ms);
    for (;;) {
        splinter_slot_snapshot_t snap = {};
        if (splinter_get_slot_snapshot(key, &snap) == 0 &&
            !(snap.bloom & WAITING_LABEL)) {
            /* Daemon has serviced this deposit. Distinguish the refusal marker
             * from a real embedding before trusting the vector. */
            if (snap.bloom & ERROR_LABEL)
                return EMBED_CONTEXT_EXCEEDED;
            if (embedding_present(snap.embedding, SPLINTER_EMBED_DIM)) {
                std::memcpy(out, snap.embedding, sizeof(snap.embedding));
                return EMBED_OK;
            }
        }
        if (steady_clock::now() >= deadline) return EMBED_TIMEOUT;
        std::this_thread::sleep_for(milliseconds(2));
    }
}

/* Read the current VARTEXT value of a slot into `out`. Used to surface the
 * diagnostic string splinference parks in a context-exceeded slot. Returns
 * false if the value can't be read. */
static bool read_slot_value(const char *key, std::string &out) {
    size_t sz = 0;
    if (splinter_get(key, nullptr, 0, &sz) != 0) return false;
    out.resize(sz);
    size_t got = 0;
    if (splinter_get(key, out.empty() ? nullptr : &out[0], out.size(), &got) != 0)
        return false;
    out.resize(got);
    return true;
}

/* Retry an unset across transient odd-epoch contention (errno==EAGAIN). */
static void unset_scratch(const char *key) {
    for (int i = 0; i < 64; ++i) {
        int rc = splinter_unset(key);
        if (rc >= 0 || errno != EAGAIN) return;
        std::this_thread::sleep_for(std::chrono::microseconds(50));
    }
}

/* Split "scheme://host[:port]/path?query" into its scheme, origin
 * ("scheme://host[:port]") and request path ("/path?query", defaulting to "/").
 * httplib::Client is constructed from the origin; Post() takes the path
 * separately (the Client ctor ignores any path in the string). Returns false
 * if the URL has no "://" or no host. */
static bool split_embed_url(const std::string &url, std::string &scheme,
                            std::string &origin, std::string &path) {
    size_t sp = url.find("://");
    if (sp == std::string::npos || sp == 0) return false;
    scheme.assign(url, 0, sp);
    size_t host = sp + 3;
    if (host >= url.size() || url[host] == '/') return false;   /* need a host */
    size_t slash = url.find('/', host);
    if (slash == std::string::npos) { origin = url; path = "/"; }
    else { origin.assign(url, 0, slash); path.assign(url, slash, std::string::npos); }
    return true;
}

/* Pull the first "embedding" array out of a JSON body into out[dim]. Handles
 * both the OpenAI shape {"data":[{"embedding":[...]}]} and a bare
 * {"embedding":[...]} — we seek the first "embedding" key and read the numeric
 * array that follows. Returns false unless exactly `dim` values parse (a short
 * or long vector means the endpoint's model disagrees with SPLINTER_EMBED_DIM). */
static bool parse_embedding_array(const std::string &body, float *out, int dim) {
    size_t p = body.find("\"embedding\"");
    if (p == std::string::npos) return false;
    p = body.find('[', p);
    if (p == std::string::npos) return false;
    ++p;
    const char *base = body.c_str();
    size_t n = body.size();
    int i = 0;
    while (p < n) {
        while (p < n) {                                  /* skip ws and commas */
            char c = body[p];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',') ++p;
            else break;
        }
        if (p >= n || body[p] == ']') break;
        char *end = nullptr;
        double v = std::strtod(base + p, &end);
        if (end == base + p) return false;               /* not a number */
        if (i < dim) out[i] = (float)v;
        ++i;                                             /* count past dim to detect overflow */
        p = (size_t)(end - base);
    }
    return i == dim;
}

/* Embed `text` by POSTing an OpenAI-compatible request to the configured
 * external endpoint. On success fills out[SPLINTER_EMBED_DIM] and returns true.
 * On failure returns false with an HTTP status to relay to our own client
 * (504 for connect/read timeouts, 502 for everything else) and a message. */
static bool embed_via_http(const std::string &text, int timeout_ms,
                           float *out, int &err_status, std::string &err_msg) {
    httplib::Client cli(g_embed_origin);
    cli.set_keep_alive(true);
    time_t sec  = timeout_ms / 1000;
    time_t usec = (time_t)(timeout_ms % 1000) * 1000;
    cli.set_connection_timeout(sec, usec);
    cli.set_read_timeout(sec, usec);
    cli.set_write_timeout(sec, usec);
    if (!g_embed_auth.empty()) cli.set_bearer_token_auth(g_embed_auth);

    /* OpenAI-compatible request: {"input": <specimen>[, "model": <name>]}.
     * The model field is sent only when SEMSAGE_EMBEDDING_MODEL is set (OpenAI
     * and vLLM require it; TEI/llama.cpp ignore it). */
    std::string reqbody = "{\"input\":\"" + json_escape(text) + "\"";
    if (!g_embed_model.empty())
        reqbody += ",\"model\":\"" + json_escape(g_embed_model) + "\"";
    reqbody += "}";

    auto r = cli.Post(g_embed_path, reqbody, "application/json");
    if (!r) {
        httplib::Error e = r.error();
        bool timed_out = (e == httplib::Error::Read || e == httplib::Error::Write ||
                          e == httplib::Error::Connection ||
                          e == httplib::Error::ConnectionTimeout ||
                          e == httplib::Error::Timeout);
        err_status = timed_out ? 504 : 502;
        err_msg = std::string("external embedder request failed: ") + httplib::to_string(e);
        return false;
    }
    if (r->status != 200) {
        err_status = 502;
        err_msg = "external embedder returned HTTP " + std::to_string(r->status);
        return false;
    }
    if (!parse_embedding_array(r->body, out, SPLINTER_EMBED_DIM)) {
        err_status = 502;
        err_msg = "external embedder response lacked a " +
                  std::to_string(SPLINTER_EMBED_DIM) + "-dim embedding array";
        return false;
    }
    return true;
}

struct Scored {
    const std::string *key;
    float similarity;
    float distance;
    float dotproduct;
};

/* Keys prefixed "|" are unidirectional axis pillars (e.g. the |polarity tiers).
 * They must always be returned regardless of the min_similarity / min_dot gates,
 * the result limit, or the elbow cut, so the client's polarity slider always has
 * its full tier set no matter how faint the specimen's match. */
static inline bool is_unidirectional_key(const std::string &k) {
    return !k.empty() && k[0] == '|';
}

/* Shunt tripwire pillars are named "__shunt_<type>" (see trainers' SHUNT()).
 * They are normally subject to the value gates like any other key, but with
 * ?protect_shunts=1 the caller can exempt every shunt from min_similarity /
 * min_dot / limit so the full sensor bank is always visible for debugging. */
static inline bool is_shunt_key(const std::string &k) {
    return k.rfind("__shunt_", 0) == 0;
}

/* Intrinsic shunts are named "~~shunt_<type>". They behave like monolithic
 * shunts but carry the computed centroid + variance vectors the other sensors
 * do, so they are scored as ordinary sensors and — unlike "__" keys — are not
 * caught by is_special_key. They must therefore be exempted from the elbow
 * explicitly, and only when the caller asks for it via ?protect_shunts=1. */
static inline bool is_intrinsic_shunt_key(const std::string &k) {
    return k.rfind("~~shunt_", 0) == 0;
}

/*
 * Score the query vector against every cached corpus key. O(cache) per request.
 * Results are ranked by descending similarity (ties broken by ascending
 * distance), matching the `search` CLI's ordering.
 *
 * min_similarity and min_dot are independent low-water gates: a key is kept
 * only if its cosine sim is >= min_similarity AND its raw dot product is
 * >= min_dot. Pass -infinity for either to disable it (the caller does this
 * when the corresponding UI checkbox is off), so a default value can sit in the
 * box without filtering anything.
 *
 * Unidirectional ("|") keys bypass every gate, the limit, and (later) the elbow
 * cut — see is_unidirectional_key — so they are always present in the response.
 * When protect_shunts is set, both monolithic ("__shunt_") and intrinsic
 * ("~~shunt_") shunts get the same exemption from the value gates and the limit
 * (see is_shunt_key / is_intrinsic_shunt_key); the elbow honors the same flag.
 */
static std::vector<Scored> score_cache(const float *query, int limit,
                                       float min_similarity, float min_dot,
                                       bool protect_shunts) {
    auto immune_of = [protect_shunts](const std::string &k) {
        return is_unidirectional_key(k) ||
               (protect_shunts && (is_shunt_key(k) || is_intrinsic_shunt_key(k)));
    };

    std::vector<Scored> out;
    out.reserve(g_cache.size());

    for (const CachedKey &c : g_cache) {
        const bool immune = immune_of(c.key);
        float sim = cosine_similarity(query, c.vec, SPLINTER_EMBED_DIM);
        if (!immune && sim < min_similarity) continue;
        float dp = dot_product(query, c.vec, SPLINTER_EMBED_DIM);
        if (!immune && dp < min_dot) continue;
        /* Sensors carry a diagonal variance: score them with the standardized
         * (variance-weighted) distance. Shunts and any variance-less key keep
         * the plain euclidean metric their thresholds were tuned against. */
        float dist = c.has_variance
            ? standardized_euclidean_distance(query, c.vec, c.variance, SPLINTER_EMBED_DIM)
            : fast_euclidean_distance(query, c.vec, SPLINTER_EMBED_DIM);
        out.push_back({ &c.key, sim, dist, dp });
    }

    std::sort(out.begin(), out.end(), [](const Scored &a, const Scored &b) {
        if (a.distance != b.distance) return a.distance < b.distance;
        return a.similarity > b.similarity; // Tie-breaker
    });

    // Apply the result limit, but never drop an immune key: keep the top `limit`
    // ranked rows plus every immune ("|", or protected shunt) key below the cut.
    if (limit > 0 && (int)out.size() > limit) {
        std::vector<Scored> kept;
        kept.reserve(out.size());
        for (size_t i = 0; i < out.size(); ++i)
            if ((int)i < limit || immune_of(*out[i].key))
                kept.push_back(out[i]);
        out.swap(kept);
    }
    return out;
}

/* Build the JSON body returned to the client. */
static std::string build_response_json(const std::string &uuid, const std::string &text,
                                       const std::vector<Scored> &results) {
    std::string body = "{\"uuid\":\"" + uuid + "\""
                       ",\"query_chars\":" + std::to_string(text.size()) +
                       ",\"count\":" + std::to_string(results.size()) +
                       ",\"results\":[";
    for (size_t i = 0; i < results.size(); ++i) {
        char sim[32], dist[32], dotp[32];
        snprintf(sim,  sizeof(sim),  "%.6f", results[i].similarity);
        snprintf(dist, sizeof(dist), "%.6f", results[i].distance);
        snprintf(dotp, sizeof(dotp), "%.6f", results[i].dotproduct);
        body += "{\"key\":\"" + json_escape(*results[i].key) +
                "\",\"similarity\":" + sim +
                ",\"distance\":" + dist +
                ",\"dotproduct\":" + dotp + "}";
        if (i + 1 < results.size()) body += ",";
    }
    body += "]}";
    return body;
}

/*
 * Append one journal record per scored request to the JSONL file. The record
 * captures the UUID, the JSON-encoded result sent to the client, the original
 * text specimen, and the splinference vector — the durable equivalent of the
 * "UUID = result (type JSON), UUID.1 = specimen + vectors" tandem in the spec.
 */
static void journal_record(const std::string &uuid, const std::string &text,
                           const float *vec, const std::string &result_json) {
    if (!g_journal) return;

    auto now = std::chrono::system_clock::now().time_since_epoch();
    long ts = (long)std::chrono::duration_cast<std::chrono::seconds>(now).count();

    std::string line = "{\"uuid\":\"" + uuid + "\""
                       ",\"ts\":" + std::to_string(ts) +
                       ",\"specimen\":\"" + json_escape(text) + "\""
                       ",\"result\":" + result_json +
                       ",\"vectors\":[";
    char f[32];
    for (int i = 0; i < SPLINTER_EMBED_DIM; ++i) {
        snprintf(f, sizeof(f), "%.7g", (double)vec[i]);
        line += f;
        if (i + 1 < SPLINTER_EMBED_DIM) line += ',';
    }
    line += "]}\n";

    std::lock_guard<std::mutex> lk(g_journal_mu);
    fwrite(line.data(), 1, line.size(), g_journal);
    fflush(g_journal);
}

/* Keys prefixed "__" (e.g. __shunt_{hate_type}) are maintenance/moderation
 * slots written with different capture strategies. Their magnitudes sit outside
 * the valence distribution, so they must never feed the elbow math nor be
 * truncated by it. */
static inline bool is_special_key(const std::string &k) {
    return k.size() >= 2 && k[0] == '_' && k[1] == '_';
}

/* Tandem/order keys use SPL_ORDER_ACCESSOR ("." by convention): a base key
 * "foo" carries ordered companions "foo.1", "foo.2", … and splinter stores each
 * order as its own slot, so splinter_list() surfaces them right alongside real
 * corpus keys. The ".1" order parks per-base out-of-band data: a sensor's
 * diagonal variance vector (VARTEXT, real embedding) or a __shunt's MODE config
 * blob (distance_method:…, min_dot:… — typed JSON, no embedding). Either way an
 * order key must be held aside at cache time and must never reach a client raw;
 * a variance is folded into its base, a config is read only on a deliberate
 * lookup. Match "<base><accessor><digits>" so the guard is robust even if a
 * future order key is mistyped or carries residue in its embedding region.
 *
 * split_order_key splits "<base><accessor><digits>" into base + order suffix
 * (e.g. "tension.1" -> base="tension", order="1") and returns false for any key
 * that isn't an order key. is_order_key is the boolean shorthand. */
static bool split_order_key(const std::string &k, std::string &base, std::string &order) {
    static const std::string acc = SPL_ORDER_ACCESSOR;
    if (acc.empty()) return false;
    size_t pos = k.rfind(acc);
    if (pos == std::string::npos || pos == 0) return false;  /* need a base */
    size_t d = pos + acc.size();
    if (d >= k.size()) return false;                         /* nothing after */
    for (size_t i = d; i < k.size(); ++i)
        if (!std::isdigit((unsigned char)k[i])) return false;
    base.assign(k, 0, pos);
    order.assign(k, d, k.size() - d);
    return true;
}

static inline bool is_order_key(const std::string &k) {
    std::string base, order;
    return split_order_key(k, base, order);
}

static void apply_elbow_cutoff(std::vector<Scored> &results, bool protect_shunts) {
    std::vector<Scored> special;
    std::vector<Scored> valence;
    special.reserve(results.size());
    valence.reserve(results.size());
    for (const Scored &s : results) {
        // "__" and "|" keys are ALWAYS held out of the elbow math; intrinsic
        // ("~~") shunts are held out only when the caller protects shunts.
        // "|" axis tiers must never be cut by the distance curve: (1) a random
        // skip in the series breaks consumer math that expects the full tier
        // set, and (2) absence of signal/phase across collectors is itself
        // meaningful, so dropping a tier on distance alone destroys both uses.
        if (s.key && (is_special_key(*s.key) || is_unidirectional_key(*s.key) ||
                      (protect_shunts && is_intrinsic_shunt_key(*s.key))))
            special.push_back(s);
        else
            valence.push_back(s);
    }

    // Need at least 3 valence points to locate an elbow; below that we leave the
    // valence results intact and simply fold the special keys back in.
    // Assumes the incoming array is sorted by distance ascending.
    if (valence.size() >= 3) {
        float min_dist = valence.front().distance; // valence stays sorted ascending by distance
        float max_dist = valence.back().distance;
        float dist_range = max_dist - min_dist;

        // Skip the cut if all valence scores are identical (avoids div-by-zero).
        if (dist_range >= 1e-6f) {
            float max_perp_distance = -1.0f;
            size_t elbow_index = 0;
            size_t n = valence.size();

            // Constant for sqrt(2)
            const float sqrt2 = 1.41421356f;

            for (size_t i = 0; i < n; ++i) {
                float x_norm = static_cast<float>(i) / (n - 1);
                float y_norm = (valence[i].distance - min_dist) / dist_range;

                // Calculate perpendicular distance from the curve to the line y = x.
                // Because good matches have low distance that slowly rises before spiking 
                // into noise, the curve bows below the line, meaning x_norm > y_norm.
                float perp_distance = (x_norm - y_norm) / sqrt2;

                if (perp_distance > max_perp_distance) {
                    max_perp_distance = perp_distance;
                    elbow_index = i;
                }
            }

            // Truncate the valence tail to drop the noise
            valence.resize(elbow_index + 1);
        }
    }

    // Reassemble: surviving valence results plus the always-kept special keys,
    // restoring ascending-distance order (ties broken by descending similarity).
    valence.insert(valence.end(), special.begin(), special.end());
    std::sort(valence.begin(), valence.end(), [](const Scored &a, const Scored &b) {
        if (a.distance != b.distance) return a.distance < b.distance;
        return a.similarity > b.similarity;
    });
    results.swap(valence);
}

static void handle_score(const httplib::Request &req, httplib::Response &res,
                         int embed_timeout_ms) {
    /* The request body IS the text specimen to embed + score. With ?strip_code=1
     * we first strip code-ish tokens (see strip_code_tokens); the stripped text
     * is what we embed, count, and journal, so query_chars reflects the real
     * savings. The no-strip path keeps referencing req.body without a copy. */
    const bool do_strip = req.has_param("strip_code") &&
                          req.get_param_value("strip_code") == "1";
    std::string stripped;
    if (do_strip) stripped = strip_code_tokens(req.body);
    const std::string &text = do_strip ? stripped : req.body;

    if (text.empty()) {
        res.status = 400;
        res.set_content(do_strip ? "{\"error\":\"empty body after strip_code\"}"
                                 : "{\"error\":\"empty body\"}",
                        "application/json");
        return;
    }
    if (text.size() > g_max_val) {  /* also enforced by set_payload_max_length */
        res.status = 413;
        res.set_content("{\"error\":\"body exceeds bus max_val_sz\"}", "application/json");
        return;
    }

    /* Optional filters. Both score gates default to -infinity (disabled) so
     * every cached key is returned ("...for each cached key") unless the caller
     * sends min_similarity / min_dot. The dev UI only sends each param when its
     * enable checkbox is ticked, so a default can sit in the box unused. */
    int   limit   = 0;        /* 0 => all cached keys */
    float min_sim = -std::numeric_limits<float>::infinity();
    float min_dot = -std::numeric_limits<float>::infinity();
    if (req.has_param("limit")) limit = std::atoi(req.get_param_value("limit").c_str());
    if (req.has_param("min_similarity"))
        min_sim = (float)std::atof(req.get_param_value("min_similarity").c_str());
    if (req.has_param("min_dot"))
        min_dot = (float)std::atof(req.get_param_value("min_dot").c_str());
    /* protect_shunts exempts the __shunt_ sensor bank from the value gates and
     * the limit — handy for debugging/development when you want every shunt in
     * view regardless of how high or low its similarity lands. */
    const bool protect_shunts = req.has_param("protect_shunts") &&
                                req.get_param_value("protect_shunts") == "1";

    /* A fresh UUID identifies this request in the response and journal. In IPC
     * mode it doubles as the scratch slot key on the bus; the external HTTP
     * path never touches the bus. */
    const std::string uuid = make_uuid();
    float query_vec[SPLINTER_EMBED_DIM];

    if (g_external_embed) {
        /* External embedder: fetch the vector over HTTP, relaying any upstream
         * failure to our own client with the mapped status. */
        int err_status = 502;
        std::string err_msg;
        if (!embed_via_http(text, embed_timeout_ms, query_vec, err_status, err_msg)) {
            res.status = err_status;
            res.set_content("{\"error\":\"" + json_escape(err_msg) + "\"}",
                            "application/json");
            return;
        }
    } else {
        /* Deposit the specimen under the UUID slot. The key is private to this
         * request until the bump, so these writes are uncontended. */
        const char *key = uuid.c_str();

        if (splinter_set(key, text.data(), text.size()) != 0) {
            res.status = 503;  /* bus full or geometry mismatch */
            res.set_content("{\"error\":\"could not write to bus (full?)\"}", "application/json");
            return;
        }
        splinter_set_named_type(key, SPL_SLOT_TYPE_VARTEXT);
        splinter_set_label(key, EMBED_LABEL);    /* wakes splinference          */
        splinter_set_label(key, WAITING_LABEL);  /* marks slot awaiting inference */
        splinter_bump_slot(key);                 /* pulse the embed signal group */

        EmbedResult er = wait_for_embedding(key, query_vec, embed_timeout_ms);
        if (er == EMBED_CONTEXT_EXCEEDED) {
            /* The specimen tokenized past the model's context window; splinference
             * refused it and left a diagnostic string in the slot value. Surface
             * that verbatim and reject the request as too large. */
            std::string diag;
            std::string err = read_slot_value(key, diag)
                ? json_escape(diag)
                : "specimen exceeds model context window";
            unset_scratch(key);
            res.status = 413;  /* payload too large: too many tokens to embed */
            res.set_content("{\"error\":\"" + err + "\"}", "application/json");
            return;
        }
        if (er == EMBED_TIMEOUT) {
            unset_scratch(key);
            res.status = 504;  /* embedding daemon didn't respond in time */
            res.set_content("{\"error\":\"embedding timed out; is splinference running?\"}",
                            "application/json");
            return;
        }
    }

    std::vector<Scored> results = score_cache(query_vec, limit, min_sim, min_dot, protect_shunts);
    // Apply elbow if requested by the client
    if (req.has_param("elbow") && req.get_param_value("elbow") == "1") {
        apply_elbow_cutoff(results, protect_shunts);
    }
    std::string body = build_response_json(uuid, text, results);

    res.status = 200;
    res.set_content(body, "application/json");

    /* Journal every request; free the UUID scratch slot only in IPC mode (the
     * external path never allocated one). */
    journal_record(uuid, text, query_vec, body);
    if (!g_external_embed) unset_scratch(uuid.c_str());
}

/* A sensor's diagonal variance ('.1' order) lifted out of a model chunk, held
 * until every chunk is loaded so it can be paired with its base key no matter
 * which chunk that base lives in. The embedding is copied out of the snapshot
 * because the store is closed before attachment happens. */
struct PendingVariance {
    std::string base;
    float       vec[SPLINTER_EMBED_DIM];
};

/* Open one model chunk, fold its base VARTEXT keys into the shared g_cache, and
 * stash any '.1' variance orders for later attachment, then close the store.
 *
 * The corpus may now be split across several chunks (trained separately but
 * loaded as one monolithic model). base_index and pending therefore persist
 * across calls: base_index maps every cached base key to its g_cache slot (so
 * duplicate keys across chunks are deduped), and pending accumulates variance
 * vectors whose base may not be cached until a *later* chunk — which is why
 * attachment is deferred to attach_variances() rather than done inline here.
 *
 * Returns the number of base keys this chunk added, or -1 on a fatal store
 * error. Note g_cache may reallocate as chunks load, but base_index stores
 * indices (not pointers), so earlier entries stay valid. */
static long cache_model_chunk(const char *model,
                              std::unordered_map<std::string, size_t> &base_index,
                              std::vector<PendingVariance> &pending) {
    if (splinter_open(model) != 0) {
        fprintf(stderr, "fatal: could not open model store '%s'\n", model);
        return -1;
    }

    splinter_header_snapshot_t hdr = {};
    if (splinter_get_header_snapshot(&hdr) != 0 || hdr.slots == 0) {
        fprintf(stderr, "fatal: could not read model geometry for '%s'\n", model);
        splinter_close();
        return -1;
    }

    std::vector<char *> keys(hdr.slots);
    size_t n = 0;
    if (splinter_list(keys.data(), keys.size(), &n) != 0) {
        fprintf(stderr, "fatal: could not list model keys for '%s'\n", model);
        splinter_close();
        return -1;
    }

    g_cache.reserve(g_cache.size() + n);

    long added = 0;
    for (size_t i = 0; i < n; ++i) {
        splinter_slot_snapshot_t snap = {};
        if (splinter_get_slot_snapshot(keys[i], &snap) != 0) continue;
        if (!(snap.type_flag & SPL_SLOT_TYPE_VARTEXT)) continue;
        if (!embedding_present(snap.embedding, SPLINTER_EMBED_DIM)) continue;

        std::string base, order;
        if (split_order_key(snap.key, base, order)) {
            /* A ".1" order with a real embedding is a sensor's diagonal
             * variance; defer attachment so its base may live in any chunk. A
             * shunt's MODE config (".1", JSON, no embedding) was already
             * filtered above, so shunts keep has_variance=false. Other orders
             * are not consumed here. */
            if (order == "1") {
                PendingVariance pv;
                pv.base = std::move(base);
                std::memcpy(pv.vec, snap.embedding, sizeof(pv.vec));
                pending.push_back(std::move(pv));
            }
            continue;
        }

        /* A base (non-order) VARTEXT key: centroid for sensors, tripwire for
         * shunts. Dedupe in case the same key surfaces in more than one chunk;
         * the first chunk to define it wins. */
        if (base_index.count(snap.key)) continue;
        CachedKey c;
        c.key.assign(snap.key);
        std::memcpy(c.vec, snap.embedding, sizeof(c.vec));
        base_index.emplace(c.key, g_cache.size());
        g_cache.push_back(std::move(c));
        ++added;
    }

    splinter_close();
    return added;
}

/* Pair every stashed variance with its base key now that all chunks are loaded.
 * A variance whose base never appeared in any chunk is dropped (the base keeps
 * fast euclidean). We can't do this inline in cache_model_chunk because
 * splinter_list() does not order companions after their base and, more
 * importantly, a base and its variance may live in different chunks. */
static void attach_variances(const std::vector<PendingVariance> &pending,
                             const std::unordered_map<std::string, size_t> &base_index) {
    for (const PendingVariance &pv : pending) {
        auto it = base_index.find(pv.base);
        if (it == base_index.end()) continue;
        CachedKey &c = g_cache[it->second];
        std::memcpy(c.variance, pv.vec, sizeof(c.variance));
        c.has_variance = true;
    }
}

static void on_signal(int) { if (g_server) g_server->stop(); }

int main(int argc, char **argv) {
    std::vector<std::string> models;            /* corpus store chunks, e.g. "Aldous_1-0" */
    const char *bus         = nullptr;          /* live IPC bus for splinference     */
    const char *journal     = "scorer-journal.jsonl";
    const char *addr        = "127.0.0.1";      /* loopback only; the proxy reaches us here */
    int   port              = 3271;
    int   threads           = 0;                /* 0 => auto (see below) */
    int   timeout_ms        = 10000;            /* how long to wait for splinference per request */

    /* External embedder (optional): if SEMSAGE_EMBEDDING_URL is set we embed via
     * HTTP and skip the splinference IPC bus entirely — for now; running both at
     * once is a planned feature. SEMSAGE_EMBEDDING_AUTH is an optional bearer
     * token; SEMSAGE_EMBEDDING_MODEL names the model for OpenAI-compatible
     * servers that require it (ignored by those that don't). */
    if (const char *u = std::getenv("SEMSAGE_EMBEDDING_URL"); u && *u) {
        g_embed_url = u;
        std::string scheme;
        if (!split_embed_url(g_embed_url, scheme, g_embed_origin, g_embed_path)) {
            fprintf(stderr, "fatal: SEMSAGE_EMBEDDING_URL is not a valid URL: %s\n", u);
            return 2;
        }
#ifndef CPPHTTPLIB_SSL_ENABLED
        if (scheme == "https") {
            fprintf(stderr, "fatal: SEMSAGE_EMBEDDING_URL uses https but this build has no "
                            "TLS support; rebuild with OpenSSL or point it at an http URL\n");
            return 2;
        }
#endif
        if (const char *a = std::getenv("SEMSAGE_EMBEDDING_AUTH"))  g_embed_auth  = a;
        if (const char *m = std::getenv("SEMSAGE_EMBEDDING_MODEL")) g_embed_model = m;
        g_external_embed = true;
    }

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](const char *what) -> const char * {
            if (i + 1 >= argc) { fprintf(stderr, "%s requires a value\n", what); exit(2); }
            return argv[++i];
        };
        if      (a == "--model") {
            /* Consume one or more chunk names: --model a b c. Repeating the flag
             * (--model a --model b) also appends, so both spellings compose into
             * one logical corpus. Stop at the next "--" option. */
            if (i + 1 >= argc || std::strncmp(argv[i + 1], "--", 2) == 0) {
                fprintf(stderr, "--model requires at least one value\n");
                return 2;
            }
            while (i + 1 < argc && std::strncmp(argv[i + 1], "--", 2) != 0)
                models.push_back(argv[++i]);
        }
        else if (a == "--bus")        bus        = next("--bus");
        else if (a == "--journal")    journal    = next("--journal");
        else if (a == "--addr")       addr       = next("--addr");
        else if (a == "--port")       port       = std::atoi(next("--port"));
        else if (a == "--threads")    threads    = std::atoi(next("--threads"));
        else if (a == "--timeout-ms") timeout_ms = std::atoi(next("--timeout-ms"));
        else { fprintf(stderr, "unknown arg: %s\n", a.c_str()); return 2; }
    }
    /* --bus is required for the IPC path but optional when an external embedder
     * is configured (SEMSAGE_EMBEDDING_URL), since we never open the bus then. */
    if (models.empty() || (!bus && !g_external_embed)) {
        fprintf(stderr,
            "Usage: %s --model <name> [<name> ...] --bus <ipc_name>\n"
            "          [--journal scorer-journal.jsonl] [--addr 127.0.0.1] [--port 8080]\n"
            "          [--threads N] [--timeout-ms 2000]\n"
            "  --bus is optional when SEMSAGE_EMBEDDING_URL is set (external embedder).\n", argv[0]);
        return 2;
    }
    if (bus && g_external_embed)
        fprintf(stderr, "note: SEMSAGE_EMBEDDING_URL is set; ignoring --bus '%s' "
                        "(simultaneous IPC + external embedding is not yet implemented)\n", bus);

    /* Phase 1: read the corpus out of each model chunk, merging them into one
     * cache, then pair up variances across chunks. Each chunk is opened and
     * closed in turn; the result is identical to loading one monolithic store. */
    std::unordered_map<std::string, size_t> base_index;
    std::vector<PendingVariance> pending;
    for (const std::string &m : models) {
        if (cache_model_chunk(m.c_str(), base_index, pending) < 0) return 1;
    }
    attach_variances(pending, base_index);

    long cached = (long)g_cache.size();
    if (cached == 0) {
        fprintf(stderr, "fatal: model chunks have no embedded VARTEXT keys to score against\n");
        return 1;
    }

    /* Open the append-only journal before serving. */
    g_journal = fopen(journal, "a");
    if (!g_journal) {
        fprintf(stderr, "fatal: could not open journal '%s': %s\n", journal, std::strerror(errno));
        return 1;
    }

    /* Phase 2: open the live IPC bus and keep it mapped for the server lifetime.
     * Skipped entirely in external-embedder mode — there is no bus to read a
     * geometry from, so the payload cap falls back to a fixed default. */
    if (g_external_embed) {
        g_max_val = EXTERNAL_DEFAULT_MAX_VAL;
    } else {
        if (splinter_open(bus) != 0) {
            fprintf(stderr, "fatal: could not open IPC bus '%s'\n", bus);
            fclose(g_journal);
            return 1;
        }
        splinter_header_snapshot_t hdr = {};
        if (splinter_get_header_snapshot(&hdr) != 0 || hdr.max_val_sz == 0) {
            fprintf(stderr, "fatal: could not read IPC bus geometry\n");
            splinter_close();
            fclose(g_journal);
            return 1;
        }
        g_slots   = hdr.slots;
        g_max_val = hdr.max_val_sz;
    }

    /*
     * Thread-pool sizing. Each request spends most of its wall-clock time PARKED
     * waiting for splinference to return a vector, not on CPU; the only CPU work
     * here is the cosine scan over the in-memory cache. So oversubscribing past
     * core count is correct — it hides embedding latency. Default to 2x cores.
     * (The proxy's upstream connection pool bounds how many are ever in flight.)
     */
    if (threads <= 0) {
        unsigned hw = std::thread::hardware_concurrency();
        threads = (int)std::max(8u, hw ? hw * 2 : 8u);
    }

    httplib::Server svr;
    g_server = &svr;
    svr.new_task_queue = [threads] { return new httplib::ThreadPool((size_t)threads); };
    svr.set_payload_max_length((size_t)g_max_val);

    svr.Get("/healthz", [](const httplib::Request &, httplib::Response &r) {
        r.set_content("ok\n", "text/plain");
    });
    svr.Post("/api/v1/score", [timeout_ms](const httplib::Request &req, httplib::Response &res) {
        handle_score(req, res, timeout_ms);
    });

    std::signal(SIGINT,  on_signal);
    std::signal(SIGTERM, on_signal);

    std::string model_list;
    for (size_t i = 0; i < models.size(); ++i) {
        if (i) model_list += ',';
        model_list += models[i];
    }
    if (g_external_embed)
        fprintf(stderr,
            "scorer: model=%s chunks=%zu cached=%ld embed=external:%s listen=%s:%d threads=%d max_val=%u journal=%s\n",
            model_list.c_str(), models.size(), cached, g_embed_url.c_str(), addr, port, threads, g_max_val, journal);
    else
        fprintf(stderr,
            "scorer: model=%s chunks=%zu cached=%ld bus=%s listen=%s:%d threads=%d slots=%u max_val=%u journal=%s\n",
            model_list.c_str(), models.size(), cached, bus, addr, port, threads, g_slots, g_max_val, journal);

    if (!svr.listen(addr, port)) {
        fprintf(stderr, "fatal: could not bind %s:%d\n", addr, port);
        if (!g_external_embed) splinter_close();
        fclose(g_journal);
        return 1;
    }

    if (!g_external_embed) splinter_close();
    fclose(g_journal);
    return 0;
}
