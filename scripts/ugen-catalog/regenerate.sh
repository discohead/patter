#!/bin/sh
# Regenerate ugen-catalog.json from sclang and verify it against sclang-compiled SynthDef bytes.
# sclang ALWAYS runs with an overridden HOME so the user's startup.scd (which boots a server)
# is never executed. No server is booted by any of these scripts.
set -eu
D=$(cd "$(dirname "$0")" && pwd)
SCLANG=${SCLANG:-/Applications/SuperCollider.app/Contents/MacOS/sclang}
SCHOME=${SCHOME:-$(mktemp -d)}
ENGINE=${ENGINE:-$D/engine_ugens.txt}  # the units compiled into SuperSonic's engine
mkdir -p "$SCHOME"
run() { HOME="$SCHOME" timeout 900 "$SCLANG" --include-path "$D/ext-classes" "$@" > "$D/sclang-last.log" 2>&1; }

echo "1/6 probe constructors";        run "$D/probe.scd" "$ENGINE" "$D/probe_raw.jsonl"
echo "2/6 probe special cases";       run "$D/probe_special.scd" "$D/special_raw.jsonl"
echo "3/6 operator specialIndex";     run "$D/ops.scd" "$D/ops_raw.json"
echo "4/6 build catalog";             node "$D/build-catalog.mjs"
echo "5/6 compile verification defs"; node "$D/verify.mjs" gen && run "$D/verify_cases.scd" "$D/verify_out.jsonl"
echo "6/6 compare with catalog";      node "$D/verify.mjs" check
echo "done: copy $D/ugen-catalog.json to src/sc/ugen-catalog.json when it looks right"
