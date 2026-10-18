#!/usr/bin/env bash
# Run at the start of every builder agent: checks disk cap and free space.
set -euo pipefail
cap_kb=$((2 * 1024 * 1024))
used_kb=$(du -sk . | cut -f1)
free_gb=$(df -BG --output=avail . | tail -1 | tr -dc 0-9)
echo "worktree: $((used_kb / 1024)) MB used of 2048 MB; disk free: ${free_gb} GB"
if (( used_kb > cap_kb )); then echo "STOP: worktree over the 2 GB cap" >&2; exit 1; fi
if (( free_gb < 10 )); then echo "STOP: less than 10 GB free on disk" >&2; exit 1; fi
