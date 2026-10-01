---
name: run-segval
description: Start and drive the SegVal app (Neo4j + FastAPI backend + React UI, or the offline single-file demo) in a Linux container, then click through it with headless Chromium and take screenshots. Use when asked to run, start, open, screenshot or smoke-test SegVal, or to confirm a change works in the real app.
---

# Run SegVal

Verified on the Claude Code cloud container (Ubuntu, Docker binary present but daemon
stopped, Chromium at `/opt/pw-browsers/chromium`, outbound HTTPS through a TLS proxy).

## 1. Start everything

```bash
.claude/skills/run-segval/up.sh          # idempotent; seeds 5,000 customers if the graph is empty
```

It starts `dockerd` (via `sudo -n`), the `segval-neo4j` container on host networking
(`neo4j/segval-dev-pw`), creates `backend/.venv` with `uv`, seeds data, (re)starts the
API on `:8000` and Vite on `:5173`. Logs go to `/tmp/segval/`.

Smoke check:

```bash
curl -s localhost:8000/api/health        # {"status":"ok","graph":true,...}
curl -s localhost:8000/api/graph/start   # {"node":"Customer:…"}
```

## 2. Drive the UI

```bash
REPO=$PWD; cd "$(mktemp -d)" && npm i playwright@1 >/dev/null && \
  node "$REPO/.claude/skills/run-segval/drive.mjs"
```

Pass `file:///…/frontend/dist-demo/index.html` as the first argument to drive the
offline demo instead (build it with `npm run build:demo` in `frontend/`). The script
exits non-zero on any page error. **Look at the screenshots**; a blank frame is a failure.

## 3. Show it to the user

The container's ports are not reachable from the user's browser. To let them use the
app, publish the offline demo (`frontend/dist-demo/index.html`, with the
`<!doctype>/<html>/<head>/<body>` wrapper stripped and `<title>SegVal</title>` first)
as an Artifact. It runs the same UI and a parity-tested in-browser engine.

## Gotchas

- **Never `pkill -f uvicorn`** (or any pattern that appears in your own command line):
  it kills the shell running it. Restart by PID, filtering out `bash` (as `up.sh` does).
- **Integration tests wipe the graph**: `SEGVAL_IT=1 pytest` and
  `backend/tools/make_demo_fixture.py` load a small dataset. Re-run
  `.venv/bin/segval-seed --customers 5000` afterwards.
- **`docker build` fails TLS** inside this container (pip/npm see the proxy's
  self-signed CA). To validate images, build throwaway copies with
  `/root/.ccr/ca-bundle.crt` added (`PIP_CERT`, `NODE_EXTRA_CA_CERTS`); never commit that.
- **Playwright**: do not run `playwright install`; launch with
  `executablePath: "/opt/pw-browsers/chromium"`.
- The demo routes in memory (`MemoryRouter`) because artifact frames are
  `about:srcdoc` with a null origin; hash/browser routers crash there.
