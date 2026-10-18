#!/usr/bin/env bash
# One Chromium and one heavy build at a time on this 8 GB machine.
# Usage: scripts/with-lock.sh chromium|build <command...>
set -euo pipefail
kind=$1; shift
case $kind in chromium|build) ;; *) echo "lock kind must be chromium or build" >&2; exit 2;; esac
mkdir -p "$HOME/.cache/studiodesk"
exec flock "$HOME/.cache/studiodesk/$kind.lock" "$@"
