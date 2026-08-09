#!/usr/bin/env bash
set -euo pipefail
ROOT="$1"
BINDING="$2"
OUT="$ROOT/evidence/hourly"
REPORT="$ROOT/shadow/${BINDING}.json"
PIDFILE="$ROOT/evidence/shadow.pid"
for i in 1 2; do
  sleep 3600
  ts=$(date -u +%Y-%m-%dT%H%M%SZ)
  if [[ -f "$REPORT" ]]; then
    cp "$REPORT" "$OUT/hour-${i}-${ts}.json"
  else
    echo "{\"ok\":false,\"note\":\"report missing at hour $i\",\"at\":\"$ts\"}" > "$OUT/hour-${i}-${ts}.json"
  fi
  # Abort companion if shadow died
  if [[ -f "$PIDFILE" ]] && ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "shadow gone at hour $i" > "$OUT/companion-stop.txt"
    exit 0
  fi
done
