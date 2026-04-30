#!/bin/sh
# BillHive container entrypoint.
#
# Runs as root only long enough to ensure /data is writable by the `node` user,
# then drops privileges and exec's the app. This handles three cases cleanly:
#   1. Fresh install — empty volume, ownership set on first run
#   2. Upgrade from pre-1.x images that ran as root — fixes legacy root-owned files
#   3. Host bind-mounts with mismatched ownership
#
# After this script, the actual node process runs as uid 1000 (non-root).
set -e

if [ -d /data ]; then
  chown -R node:node /data
fi

exec su-exec node:node "$@"
