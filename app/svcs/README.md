# app/svcs — systemd units for semsage

This directory holds the [systemd](https://systemd.io/) **user** service units that
run a DECE model's two long-lived background processes: the **embedder** (turns
text into vectors) and the **scorer** (classifies those vectors). `semsage`
generates, wires, and controls these units for you — you rarely touch this
directory by hand — but here's what lives here and how it fits together.

## New to systemd?

systemd is the init system and service manager on most modern Linux distributions.
A *unit* is a description of something systemd manages; a `.service` unit describes
a process it should start, keep running, restart on failure, and capture logs from.

You almost certainly interact with it through `systemctl` and read its logs with
`journalctl`. The units here are **user** units (`systemctl --user ...`), meaning
they run under your login session rather than as root — no `sudo` required, and
they live in `~/.config/systemd/user/`.

A few links if this is unfamiliar:

- [systemd for Administrators / the basics](https://www.freedesktop.org/wiki/Software/systemd/) — upstream docs.
- [`systemd.service(5)`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) — the anatomy of a `[Unit]`/`[Service]`/`[Install]` file.
- [`systemd.unit(5)`](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html) — dependencies like `After=` and `WantedBy=`.
- [Managing user services (Arch Wiki)](https://wiki.archlinux.org/title/Systemd/User) — the `--user` model these units rely on.
- [Template units and `%i`](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#Specifiers) — why the filenames have an `@` in them (see below).

## Why these units exist

Scoring text with a DECE model is a two-stage pipeline, and each stage is a
separate program that needs to stay resident:

1. **embedder** — `splinferencep` loads the shared `gguf/nomic.gguf` embedding
   model and answers "turn this text into a vector" requests.
2. **scorer** — `dece-semsaged` loads the compiled `dece/<model>/<model>.dece`
   classifier and answers "which key does this vector belong to" requests.

The two talk over a shared-memory IPC bus under `app/ipc/<model>` (the
"Splinference" bus that `semsage uplink <model>` provisions). Because the scorer
is useless without embeddings, its unit declares `After=embedder@<model>.service`
so systemd starts them in the right order.

Running them as systemd units (rather than by hand) gives you automatic restart,
log capture via `journalctl`, and start-on-login — all keyed per model.

## Template units and the `@` in the filename

These are **template units**. One template serves every model. The `@` marks the
template; the text between `@` and `.service` when you actually use it is the
*instance name*, which systemd exposes to the unit as the `%i` specifier.

So the single template `scorer@.service` runs as, e.g.:

```
scorer@Aldous_1-2.service   →   %i = Aldous_1-2
```

Inside the unit, `%i` is the bare model name (no `.dece` suffix). That's how one
file scores `dece/Aldous_1-2/Aldous_1-2.dece` for one model and
`dece/SomethingElse/SomethingElse.dece` for the next, without editing anything.

## What's in this directory

```
configured/
  embedder@.service.in    template → the embedder unit (tracked in git)
  scorer@.service.in      template → the scorer unit   (tracked in git)
  embedder@.service       rendered from the .in  (generated, git-ignored)
  scorer@.service         rendered from the .in  (generated, git-ignored)
enabled/                  symlink → ~/.config/systemd/user  (generated, git-ignored)
```

### `configured/*.service.in` — the templates you edit

The `.in` files are the source of truth. They contain the placeholder
`@SEMSAGE_ROOT@` everywhere an absolute path is needed. **Edit these**, never the
generated `.service` files.

### `configured/*.service` — the rendered units

`semsage install` copies each `.in` to its `.service` sibling, substituting
`@SEMSAGE_ROOT@` with your real install path. These are generated artifacts and
are git-ignored — if you edit one directly, the next `semsage install` overwrites
it.

### `enabled/` — the bridge into systemd

After `semsage install`, `enabled/` is a symlink pointing at your systemd user
unit directory (`~/.config/systemd/user`). The rendered `.service` files are
symlinked in there so `systemctl --user` can find them. This is git-ignored
because it's specific to your machine and account.

## How `semsage` drives all of this

You should manage these units through `semsage`, which keeps the templates,
rendered units, and systemd's view of them in sync:

| Command | What it does with the units here |
|---|---|
| `semsage install` | Renders `*.in` → `*.service`, points `enabled/` at your systemd user dir, symlinks the units in, and runs `daemon-reload`. Nothing is started or enabled — everything stays **off** by default. |
| `semsage uplink <model>` | Provisions the `app/ipc/<model>` shared-memory bus the embedder and scorer talk over. |
| `semsage start <model>` | `systemctl --user start` the model's embedder and scorer, and verifies they actually came up. |
| `semsage stop <model>` | Stops them. |
| `semsage restart <model>` | Restarts them. |
| `semsage enable <model>` | Marks the model's units to start on login (`WantedBy=default.target`). |
| `semsage disable <model>` | Undoes that. |
| `semsage status <model>` | Queries `systemctl` about the model's units. |

Under the hood these run ordinary `systemctl --user` and `journalctl --user`
commands, so anything you'd normally do with systemd still works. For example, to
see live logs for a running model:

```sh
journalctl --user -u scorer@Aldous_1-2.service -f
```

## Editing a unit

1. Edit the `.in` template in `configured/` (change `ExecStart`, add an
   `Environment=` line, etc.). Keep `@SEMSAGE_ROOT@` for any absolute path — it's
   substituted at install time.
2. Run `semsage install` to re-render and `daemon-reload`.
3. `semsage restart <model>` to pick up the change on a running model.
