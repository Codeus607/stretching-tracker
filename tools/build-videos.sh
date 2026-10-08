#!/usr/bin/env bash
# Turn the stretch videos into web-ready loops and write the stretch list.
#   source:  $STRETCH_VIDEOS (default ~/Videos/Stretching-App), one video per stretch,
#            named after the stretch: Active-Frog.mov -> "Active Frog"
#   output:  public/videos/<id>-<hash>.mp4 + .jpg poster, public/stretches.json
# Output names include a hash of the source, so a replaced video gets a new URL
# (Hostinger's CDN keeps serving old copies of overwritten files).
# Only changed videos are re-encoded.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${STRETCH_VIDEOS:-$HOME/Videos/Stretching-App}"
OUT=public/videos
ENC=v1 # bump to re-encode everything after changing the settings below
mkdir -p "$OUT"

shopt -s nullglob nocaseglob
files=("$SRC"/*.{mov,mp4,m4v,webm,mkv})
shopt -u nocaseglob
[ ${#files[@]} -gt 0 ] || { echo "No videos in $SRC" >&2; exit 1; }

entries=()
keep=()
for f in "${files[@]}"; do
  base=$(basename "$f"); base=${base%.*}
  name=$(sed -E 's/[-_]+/ /g; s/ +/ /g; s/^ //; s/ $//' <<<"$base")
  id=$(tr '[:upper:]' '[:lower:]' <<<"$name" | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g')
  hash=$( (cat "$f"; echo "$ENC") | md5sum | cut -c1-8)
  mp4="$id-$hash.mp4"; jpg="$id-$hash.jpg"
  if [ ! -s "$OUT/$mp4" ]; then
    echo "encoding $base"
    # square-ish phone clips: max 720 px, 30 fps, no sound, moov atom first so it starts fast
    ffmpeg -nostdin -loglevel error -y -i "$f" -an \
      -vf "scale='min(720,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p" \
      -c:v libx264 -profile:v high -preset slow -crf 26 -movflags +faststart "$OUT/$mp4.tmp.mp4"
    mv "$OUT/$mp4.tmp.mp4" "$OUT/$mp4"
    ffmpeg -nostdin -loglevel error -y -ss 0.5 -i "$OUT/$mp4" -frames:v 1 -vf scale=240:-2 -q:v 4 "$OUT/$jpg"
  fi
  keep+=("$mp4" "$jpg")
  entries+=("$(jq -nc --arg id "$id" --arg name "$name" --arg v "videos/$mp4" --arg p "videos/$jpg" \
    '{id: $id, name: $name, video: $v, poster: $p}')")
done

# drop outputs of videos that were removed or replaced
for o in "$OUT"/*; do
  n=$(basename "$o")
  printf '%s\n' "${keep[@]}" | grep -qxF "$n" || { echo "removing $n"; rm -f "$o"; }
done

printf '%s\n' "${entries[@]}" | jq -s 'sort_by(.name | ascii_downcase) | {stretches: .}' > public/stretches.json
echo "$(jq '.stretches | length' public/stretches.json) stretches in public/stretches.json"
