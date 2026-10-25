#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/data}"
chown -R node:node "${DATA_DIR:-/data}"
# Kernel releases this lock even after a crash; the Railway service must have one replica.
case "${RECORDER_MODE:-engine}" in
  engine) recorder_entry=/app/apps/mcp/dist/index.js ;;
  hosted) recorder_entry=/app/apps/hosted/dist/index.js ;;
  backup-legacy) recorder_entry=/app/apps/hosted/dist/backup-legacy-cli.js; export RECORDER_MAINTENANCE_LOCK=held ;;
  backup-volume) recorder_entry=/app/apps/hosted/dist/backup-volume-cli.js; export RECORDER_MAINTENANCE_LOCK=held ;;
  init-empty) recorder_entry=/app/apps/hosted/dist/bootstrap-empty-cli.js; export RECORDER_MAINTENANCE_LOCK=held ;;
  *) echo "invalid_recorder_mode" >&2; exit 1 ;;
esac
exec gosu node flock -n "${DATA_DIR:-/data}/.process-lock" node "$recorder_entry"
