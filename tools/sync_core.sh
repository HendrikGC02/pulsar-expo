#!/bin/sh
# Copy the shared processing core from this repo to its sister repo, which must
# sit next to it (C:/Pulsar_Web/pulsar-studio and C:/Pulsar_Web/pulsar-expo).
#   sh tools/sync_core.sh
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
case "$(basename "$HERE")" in
  pulsar-studio) THERE="$HERE/../pulsar-expo" ;;
  pulsar-expo)   THERE="$HERE/../pulsar-studio" ;;
  *) echo "run this from inside pulsar-studio or pulsar-expo"; exit 1 ;;
esac
[ -d "$THERE/js" ] || { echo "$THERE not found"; exit 1; }
n=0
for f in dsp_core engine app_core audio pulsars colormaps demos; do
  if ! cmp -s "$HERE/js/$f.js" "$THERE/js/$f.js"; then
    cp "$HERE/js/$f.js" "$THERE/js/$f.js"; echo "copied js/$f.js"; n=$((n + 1))
  fi
done
[ "$n" -gt 0 ] && echo "Now commit and push $(basename "$THERE") too." || echo "Already in sync."
