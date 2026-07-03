-- Aldous_1-x sensor provisioner.
--
-- Invoked once per SENSOR by model_funcs.sh:
--   splinterpctl --use models/<name> lua trainers/Aldous_1-0.lua <base_key> <payload> <label>
--
-- The payload is a '^'-delimited list of coherent phrases. Each phrase is
-- embedded individually (by the splinference butler, which must already be
-- running against this store), then collapsed into two vectors:
--
--   base_key      <- centroid (mean) of the phrase embeddings   -> "where"
--   base_key..".1" <- diagonal variance around that centroid     -> "spread"
--
-- The scorer's standardized (diagonal-Mahalanobis) distance reads both.
--

-- Splinter's special harness (defined in splinter_cli_cmd_lua.c) is already 
-- visible here, but it has to be brought into the scope of this runtime 
-- instance; it isn't automatic.
local model = require("splinter")

-- nomic-embed-text-1.5 currently which uses OpenAI-style embeddings
local DIMS       = 768
-- gap between checks on what splinference has accomplished
local POLL_MS    = 50
-- when should a butler request be considered stalled?
local REPULSE_MS = 1000
-- after this, assume the request was skipped
local TIMEOUT_MS = 60000
-- temporary bloom mask for bumping temporary keys
local TEMP_MASK  = 1

-- Split on '^', trim each phrase, drop empties.
local function split_phrases(s)
    local out = {}
    for chunk in string.gmatch(s, "([^%^]+)") do
        chunk = chunk:match("^%s*(.-)%s*$")
        if chunk ~= "" then out[#out + 1] = chunk end
    end
    return out
end

-- Block until the butler has embedded every key, nudging it if it goes quiet.
local function wait_for_embeddings(keys)
    local vecs    = {}
    local pending = #keys
    local waited  = 0
    local since_pulse = 0
    while pending > 0 do
        for _, key in ipairs(keys) do
            if not vecs[key] then
                local v = model.get_embedding(key)
                -- get_embedding returns a zero-magnitude vector until the butler
                -- fills it; treat a present, non-empty table as "embedded".
                if v and #v == DIMS then
                    vecs[key] = v
                    pending = pending - 1
                end
            end
        end
        if pending > 0 then
            if waited >= TIMEOUT_MS then
                error(string.format("timed out: %d/%d embeddings still pending under %s",
                                    pending, #keys, keys[1]))
            end
            model.sleep(POLL_MS)
            waited      = waited + POLL_MS
            since_pulse = since_pulse + POLL_MS
            -- A pulse can be missed if the butler was mid-scan; re-bump a pending
            -- key to wake it again. Cheap insurance against a stall.
            if since_pulse >= REPULSE_MS then
                for _, key in ipairs(keys) do
                    if not vecs[key] then model.bump(key); break end
                end
                since_pulse = 0
            end
        end
    end
    return vecs
end

local function provision(base_key, payload)
    local phrases = split_phrases(payload)
    local n = #phrases
    if n == 0 then
        error("no phrases (nothing between '^' delimiters) for " .. base_key)
    end

    -- Deposit each phrase into a temp slot and flag it for the butler.
    local temps = {}
    for i, phrase in ipairs(phrases) do
        local k = base_key .. "_tmp_" .. i
        model.set(k, phrase)
        model.label(k, TEMP_MASK)
        model.bump(k)            -- advance epoch + pulse group 0
        temps[i] = k
    end

    -- Wait for the embeddings to land.
    local vecs = wait_for_embeddings(temps)

    -- Centroid = mean of the phrase vectors.
    local centroid = {}
    for d = 1, DIMS do centroid[d] = 0.0 end
    for _, k in ipairs(temps) do
        local v = vecs[k]
        for d = 1, DIMS do centroid[d] = centroid[d] + v[d] end
    end
    for d = 1, DIMS do centroid[d] = centroid[d] / n end

    -- Diagonal sample variance around the centroid. We hold a sample of a
    -- population (a handful of phrases, not every possible phrasing), so we
    -- divide by N-1 (Bessel's correction) to undo the downward bias small
    -- samples have. N=1 has no spread to estimate: the lone diff is zero, so
    -- the variance is all zeros regardless of the divisor -- guard the divisor
    -- only to avoid 1/0. A zero variance vector falls below the scorer's
    -- "present" threshold, so that sensor cleanly falls back to plain
    -- euclidean under the distance floor.
    local variance = {}
    for d = 1, DIMS do variance[d] = 0.0 end
    for _, k in ipairs(temps) do
        local v = vecs[k]
        for d = 1, DIMS do
            local diff = v[d] - centroid[d]
            variance[d] = variance[d] + diff * diff
        end
    end
    local denom = n > 1 and (n - 1) or 1
    for d = 1, DIMS do variance[d] = variance[d] / denom end

    -- Write the math: centroid into the base slot, variance into the .1 order.
    -- (model_funcs.sh has already allocated the 2-order tandem and set types.)
    model.set_embedding(base_key, centroid)
    model.set_embedding(base_key .. ".1", variance)

    -- Tear down the scaffolding.
    for _, k in ipairs(temps) do model.unset(k) end

    print(string.format("Provisioned sensor '%s' (phrases=%d)", base_key, n))
end

-- Main executable part of the code (launcher)

local base_key = arg[1]
local payload  = arg[2]

if not base_key or not payload then
    error("usage: lua Aldous_1-0.lua <base_key> <payload> [label]")
end

provision(base_key, payload)
