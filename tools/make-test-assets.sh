#!/usr/bin/env bash
# Generates the test assets with Blender's Python module (pip install bpy).
# Usage: tools/make-test-assets.sh <python-with-bpy> <outDir>
set -e
PY=${1:-python3}; OUT=${2:-./test-assets}
mkdir -p "$OUT/testfiles" "$OUT/assets" "$OUT/zoo"
D=$(cd "$(dirname "$0")/blender" && pwd)
"$PY" "$D/make_blends.py" -- "$OUT/testfiles"
"$PY" "$D/make_mirror.py" -- "$OUT/testfiles"
"$PY" "$D/make_subsurf.py" -- "$OUT/testfiles"
"$PY" "$D/make_assets.py" -- "$OUT/assets"
"$PY" "$D/make_zoo.py" -- "$OUT/zoo"
mkdir -p "$OUT/zoo/fbxtex" && "$PY" "$D/make_fbxtex.py" -- "$OUT/zoo/fbxtex"
"$PY" "$D/make_bvh.py" -- "$OUT/zoo" "$OUT/assets/hero.blend"
mkdir -p "$OUT/mmd" && "$PY" "$D/make_mmd_style.py" -- "$OUT/mmd" && (cd "$OUT/mmd" && rm -f goatchan.zip && zip -qr goatchan.zip goat)
echo "Assets in $OUT (zip the objpack / gltfsep / fbxtex folders for the zip tests)"
