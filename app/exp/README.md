# exp — the DECE explorer

The DECE dashboard and its server. A small Deno app that serves the
static explorer and proxies scoring requests to the loopback-only
`dece-semsaged` HTTP gateway (see `app/inf`).

## Run

```sh
deno task dev      # watch + serve on http://127.0.0.1:8000
# or
deno task start    # no --watch
```

Then open <http://127.0.0.1:8000>. Start the `dece-semsaged` gateway separately
(default `http://127.0.0.1:8080`); paste a specimen and hit **Score**. If the
gateway is unreachable the dashboard falls back to seeded demo data so the UI
is never empty.

## Environment

| Var          | Default                 | Purpose                      |
| ------------ | ----------------------- | ---------------------------- |
| `PORT`       | `8000`                  | port this UI listens on      |
| `HOST`       | `127.0.0.1`             | interface to bind            |
| `SCORER_URL` | `http://127.0.0.1:8080` | base URL of the scorer       |
| `PUBLIC_DIR` | `./public`              | static root                  |

```sh
SCORER_URL=http://127.0.0.1:9090 PORT=3000 deno task start
```

## Dependencies

The dashboard pulls **ECharts** and the **Rajdhani / Space Mono** fonts from a
CDN (`<script>`/`<link>` in `public/index.html`). For a fully offline /
air-gapped deployment, download `echarts.min.js` and the font files into
`public/vendor/` and repoint those two tags at the local copies — no server
change required.
