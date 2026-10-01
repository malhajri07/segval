#!/usr/bin/env bash
# Idempotent cold start of the whole SegVal stack in a Linux container.
# Usage: .claude/skills/run-segval/up.sh [customers]   (default 5000)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="${SEGVAL_LOG_DIR:-/tmp/segval}"; mkdir -p "$LOG"
CUSTOMERS="${1:-5000}"

# 1. Docker daemon (cloud containers ship the binary but do not start it)
if ! docker info >/dev/null 2>&1; then
  (sudo -n dockerd >"$LOG/dockerd.log" 2>&1 &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

# 2. Neo4j 5 community on host networking (bolt 7687, browser 7474)
if ! docker ps --format '{{.Names}}' | grep -qx segval-neo4j; then
  if docker ps -a --format '{{.Names}}' | grep -qx segval-neo4j; then
    docker start segval-neo4j >/dev/null
  else
    docker run -d --name segval-neo4j --network host \
      -e NEO4J_AUTH=neo4j/segval-dev-pw -e NEO4J_server_memory_heap_max__size=1G \
      neo4j:5-community >/dev/null
  fi
fi

# 3. Backend venv
cd "$ROOT/backend"
if [ ! -x .venv/bin/python ]; then
  uv venv -q .venv && uv pip install -q -e '.[dev]'
fi
for _ in $(seq 1 60); do
  .venv/bin/python - <<'PY' 2>/dev/null && break
from segval.config import get_settings
from segval.graph.client import Neo4jClient
raise SystemExit(0 if Neo4jClient(get_settings()).ping() else 1)
PY
  sleep 2
done

# 4. Data (only when the graph is empty)
COUNT=$(.venv/bin/python -c "
from segval.config import get_settings; from segval.graph.client import Neo4jClient
print(Neo4jClient(get_settings()).read('MATCH (s:Subscription) RETURN count(s) AS n')[0]['n'])")
if [ "$COUNT" = "0" ]; then .venv/bin/segval-seed --customers "$CUSTOMERS"; fi

# 5. API on :8000 (restart by PID; never `pkill -f uvicorn`, it matches your own shell)
for p in $(pgrep -f "bin/uvicorn" || true); do [ "$(cat /proc/$p/comm)" != "bash" ] && kill "$p" || true; done
nohup .venv/bin/uvicorn segval.api.app:app --host 0.0.0.0 --port 8000 >"$LOG/api.log" 2>&1 &
for _ in $(seq 1 30); do curl -sf localhost:8000/api/health >/dev/null && break; sleep 1; done

# 6. Web UI on :5173 (Vite proxies /api to :8000)
cd "$ROOT/frontend"
[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null
if ! curl -sf -o /dev/null localhost:5173/; then
  nohup npx vite --host 0.0.0.0 --port 5173 >"$LOG/vite.log" 2>&1 &
  for _ in $(seq 1 30); do curl -sf -o /dev/null localhost:5173/ && break; sleep 1; done
fi

curl -s localhost:8000/api/health; echo
echo "UI: http://localhost:5173  API: http://localhost:8000/docs  Neo4j: http://localhost:7474"
