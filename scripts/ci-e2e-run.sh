#!/usr/bin/env bash
# WebdriverIO (tauri-driver) launch by filming the Xvfb screen; the video is only kept in case of failure.
#
#   xvfb-run -a -s "-screen 0 1280x800x24" scripts/ci-e2e-run.sh [<config.ts>] [arguments wdio…]
#
# Must be run SOUS xvfb-run (DISPLAY defined). First argument: config file if it ends with `.ts`
# (default wdio.conf.ts); the rest is transmitted to `wdio run` (e.g. --shard 2/4).
# Variables: GITMINI_E2E_VIDEO (path of .mp4, default $RUNNER_TEMP/gitmini-video/screen.mp4 or /tmp/gitmini-video/screen.mp4),
# GITMINI_E2E_NO_VIDEO=1 disables recording. The output code is wdio.
set -uo pipefail

conf=wdio.conf.ts
case "${1:-}" in
  *.ts)
    conf=$1
    shift
    ;;
esac

video=${GITMINI_E2E_VIDEO:-${RUNNER_TEMP:-/tmp}/gitmini-video/screen.mp4}
ffmpeg_pid=
if [ "${GITMINI_E2E_NO_VIDEO:-0}" != 1 ] && [ -n "${DISPLAY:-}" ] && command -v ffmpeg >/dev/null 2>&1; then
  mkdir -p "$(dirname "$video")"
  ffmpeg -nostdin -loglevel error -y -f x11grab -video_size 1280x800 -framerate 8 -i "$DISPLAY" \
    -c:v libx264 -preset ultrafast -crf 34 -pix_fmt yuv420p "$video" &
  ffmpeg_pid=$!
fi

pnpm --dir tests/e2e exec wdio run "$conf" "$@"
status=$?

if [ -n "$ffmpeg_pid" ]; then
  # SIGTERM (not SIGINT, ignored by default in a non-interactive script for background jobs):
  # ffmpeg properly terminates the mp4 container.
  kill -TERM "$ffmpeg_pid" 2>/dev/null || true
  wait "$ffmpeg_pid" 2>/dev/null || true
  if [ "$status" -eq 0 ]; then rm -f "$video"; fi
fi
exit "$status"
