#!/usr/bin/env bash
# Read-only resource sampler for a running Selene app (macOS).
#
# Usage: scripts/perf/selene-baseline.sh [seconds=60] [label=run]
#
# Reports, for the Selene process tree:
#   - per-role CPU% (avg / p95) and RSS MB (avg / max) sampled every 2s
#   - request counts per endpoint (normalized ids) in debug.log during the window
#   - debug.log growth in bytes
# Nothing in the app or its data is modified.

set -euo pipefail
export LC_ALL=C

DURATION="${1:-60}"
LABEL="${2:-run}"
INTERVAL=2
DATA_DIR="${SELENE_USER_DATA:-$HOME/Library/Application Support/Selene}"
LOG="$DATA_DIR/debug.log"
OUT_DIR="${SELENE_PERF_OUT:-${TMPDIR:-/tmp}/selene-perf}"
mkdir -p "$OUT_DIR"
SAMPLES="$OUT_DIR/$LABEL-samples.tsv"
: > "$SAMPLES"

ROOT_PID="$(pgrep -f '/Selene.app/Contents/MacOS/Selene$' | head -1 || true)"
if [[ -z "$ROOT_PID" ]]; then
  echo "Selene is not running" >&2
  exit 1
fi

log_size() { [[ -f "$LOG" ]] && stat -f %z "$LOG" || echo 0; }
LOG_START_SIZE="$(log_size)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%S)"

# Classify every descendant of the Selene main process into a role.
sample() {
  ps -axo pid=,ppid=,%cpu=,rss=,command= | awk -v root="$ROOT_PID" -v ts="$1" '
    {
      pid=$1; ppid[pid]=$2; cpu[pid]=$3; gsub(",",".",cpu[pid]); rss[pid]=$4
      cmd=""; for (i=5;i<=NF;i++) cmd=cmd" "$i; command[pid]=cmd
    }
    END {
      for (pid in ppid) {
        p=pid; under=0
        while (p!="" && p!=0 && p!=1) { if (p==root) { under=1; break } p=ppid[p] }
        if (!under) continue
        c=command[pid]
        if (pid==root) role="main"
        else if (c ~ /--type=renderer/) role="renderer"
        else if (c ~ /--type=gpu-process/) role="gpu"
        else if (c ~ /--type=utility/) role="utility"
        else if (c ~ /next-server/) role="next-server"
        else if (c ~ /claude-agent-sdk.*\/claude/) role="claude-cli"
        else if (c ~ /mcp|npm exec|npx/) role="mcp"
        else role="other"
        printf "%s\t%s\t%s\t%s\t%s\n", ts, role, pid, cpu[pid], rss[pid]
      }
    }' >> "$SAMPLES"
}

echo "Sampling Selene (pid $ROOT_PID) for ${DURATION}s -> $SAMPLES"
end=$((SECONDS + DURATION))
while (( SECONDS < end )); do
  sample "$SECONDS"
  sleep "$INTERVAL"
done

LOG_END_SIZE="$(log_size)"

echo
echo "== $LABEL: per-role resources (summed per sample) =="
printf "%-12s %8s %8s %10s %10s %6s\n" role cpu_avg cpu_p95 rss_avgMB rss_maxMB procs
awk -F'\t' '
  { key=$1 SUBSEP $2; cpu[key]+=$4; rss[key]+=$5; procs[key]++; roles[$2]=1; ticks[$1]=1 }
  END {
    for (r in roles) {
      n=0; csum=0; rsum=0; rmax=0; pmax=0
      for (t in ticks) {
        k=t SUBSEP r; if (!(k in cpu)) continue
        n++; c[n]=cpu[k]; csum+=cpu[k]; rsum+=rss[k]
        if (rss[k]>rmax) rmax=rss[k]; if (procs[k]>pmax) pmax=procs[k]
      }
      # insertion sort for p95
      for (i=2;i<=n;i++) { v=c[i]; j=i-1; while (j>0 && c[j]>v) { c[j+1]=c[j]; j-- } c[j+1]=v }
      idx=int(0.95*n); if (idx<1) idx=1
      printf "%-12s %8.1f %8.1f %10.0f %10.0f %6d\n", r, csum/n, c[idx], rsum/n/1024, rmax/1024, pmax
      delete c
    }
  }' "$SAMPLES" | sort -k2 -nr

echo
echo "== $LABEL: requests during window (debug.log, since $START_ISO) =="
if [[ -f "$LOG" ]]; then
  awk -v start="$START_ISO" 'substr($0,2,19) >= start' "$LOG" \
    | grep -oE '(GET|POST|PUT|PATCH|DELETE) /api/[^ ?]*' \
    | sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27}/:id/g' \
    | sort | uniq -c | sort -nr | head -20 || true
  echo
  echo "debug.log growth: $((LOG_END_SIZE - LOG_START_SIZE)) bytes in ${DURATION}s"
else
  echo "no debug.log at $LOG"
fi
