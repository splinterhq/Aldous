/**
 * A basic visualizer and explorer for Aldous' (and other) DECE files
 * License: Apache 2.0
 * Copyright 2024 Tim Post
 */

import { serveDir } from "jsr:@std/http/file-server";

const PORT = Number(Deno.env.get("PORT") ?? "3270");
const HOST = Deno.env.get("HOST") ?? "127.0.0.1";
// The scorer (dece-semsaged) listens on 3271 by default. This MUST differ from
// PORT above (the visualizer's own port) — if they collide, proxyScore forwards
// /api/v1/score back into this server, where serveDir answers 405 to the POST.
const SCORER_URL = (Deno.env.get("SCORER_URL") ?? "http://127.0.0.1:3271")
  .replace(/\/$/, "");
const PUBLIC_DIR = Deno.env.get("PUBLIC_DIR") ?? `${import.meta.dirname}/public`;

/** Proxy the pasted specimen through to the scorer, preserving query params. */
async function proxyScore(req: Request, url: URL): Promise<Response> {
  // Forward caller params (limit, min_similarity, elbow, …) verbatim. The dev
  // UI decides whether to ask for elbow/kneedle truncation via its checkbox;
  // we must not impose it here, or strong shunt hits collapse the whole view.
  const target = `${SCORER_URL}/api/v1/score${url.search}`;
  try {
    const upstream = await fetch(target, {
      method: "POST",
      body: await req.text(),
      headers: { "content-type": req.headers.get("content-type") ?? "text/plain" },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return Response.json(
      { error: `could not reach scorer at ${SCORER_URL}: ${detail}` },
      { status: 502 },
    );
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/score") {
    return proxyScore(req, url);
  }

  // Everything else is a static asset; serveDir returns index.html for "/"
  // and a 404 for anything missing. This is a dev-only visualization tool:
  // force every asset to revalidate so edits to the dece-*.js / .css
  // files show up on a plain reload instead of being served stale from the
  // browser cache (serveDir emits an etag but no Cache-Control of its own).
  const res = await serveDir(req, { fsRoot: PUBLIC_DIR, quiet: true });
  res.headers.set("cache-control", "no-store, must-revalidate");
  res.headers.set("pragma", "no-cache");
  res.headers.set("expires", "0");
  // Drop the validators too, so no conditional request can yield a 304.
  res.headers.delete("etag");
  res.headers.delete("last-modified");
  return res;
}

Deno.serve({ port: PORT, hostname: HOST }, handler);
