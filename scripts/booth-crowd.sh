#!/bin/bash
# Crowd sounds for the booth (docs/commentary.md): trims the CC0 Freesound previews listed in THIRD_PARTY.md and
# levels them to a fixed loudness, mono 24 kHz 48 kbit/s like the voice clips, into web/vendor/crowd-audio/.
#   scripts/booth-crowd.sh SOURCE_DIR      (SOURCE_DIR holds <role>-<freesound id>/<id>-hq.mp3)
# The files are read only by ffmpeg. Loudness targets: the bed sits 7 dB under the voices (about -20 LUFS) before the
# player ducks it; the reactions are louder and duck too.
set -euo pipefail
src=${1:?source dir}
out=$(cd "$(dirname "$0")/.." && pwd)/web/vendor/crowd-audio
mkdir -p "$out"

lufs() { ffmpeg -v info -nostats -i "$1" -af ebur128=framelog=quiet -f null - 2>&1 | awk '/Integrated loudness/{f=1} f&&/I:/{print $2; exit}'; }

MONO="aresample=24000,pan=mono|c0=0.5*c0+0.5*c1"

# name, source, filter graph that trims and shapes it (the source is inputs 0 and 1), target LUFS
make() {
  local name=$1 file=$2 shape=$3 target=$4 tmp gain
  tmp=$(mktemp --suffix=.wav)
  ffmpeg -v error -y -i "$src/$file" -i "$src/$file" -filter_complex "[0:a]$shape" -ac 1 "$tmp"
  gain=$(awk -v t="$target" -v i="$(lufs "$tmp")" 'BEGIN{printf "%.2f", t - i}')
  ffmpeg -v error -y -i "$tmp" -af "volume=${gain}dB,alimiter=limit=0.89:level=false" -ar 24000 -ac 1 -b:a 48k "$out/$name.mp3"
  rm -f "$tmp"
  echo "$name: gain ${gain} dB, $(lufs "$out/$name.mp3") LUFS, $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/$name.mp3") s"
}

# bed: 0 to 80 s is steady; its last 2 s crossfade into its first 2 s, so the loop has no seam
make bed bed-206003/206003-hq.mp3 "$MONO,atrim=2:80,asetpts=N/SR/TB[x];[1:a]$MONO,atrim=0:2,asetpts=N/SR/TB[y];[x][y]acrossfade=d=2:c1=tri:c2=tri" -27
make anticipation anticipation-829453/829453-hq.mp3 "$MONO,atrim=44:54,asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=9:d=1" -24
make ooh ooh-494362/494362-hq.mp3 "$MONO,atrim=2.5:8,asetpts=N/SR/TB,afade=t=in:d=0.15,afade=t=out:st=3.5:d=2" -22
make roar roar-528799/528799-hq.mp3 "$MONO,atrim=2:24,asetpts=N/SR/TB,afade=t=in:d=0.3,afade=t=out:st=16:d=6" -20
make whistle whistle-218318/218318-hq.mp3 "aresample=24000,atrim=0:1.6,asetpts=N/SR/TB,afade=t=out:st=1.0:d=0.6" -16
