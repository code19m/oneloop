#!/bin/sh
# launchd starts the job again after any failure. When a restart can't help,
# exit 0 instead, which stops the job, and say why in the log. Run with the
# plist's exact environment, then replace this shell with the server.
if [ "$#" -ne 1 ]; then
  echo 'usage: oneloop-launchd.sh /absolute/path/to/oneloop' >&2
  exit 0
fi
stop() {
  echo "oneloop: $1, then unload the job with launchctl bootout and load it again with launchctl bootstrap" >&2
  exit 0
}
[ -f "$1" ] && [ -x "$1" ] || stop "cannot run $1; fix the path in the plist"
output=$("$1" serve --check)
status=$?
[ -n "$output" ] && printf '%s\n' "$output"
case "$status" in
  0) ;;
  2) stop 'configuration check failed; fix the plist' ;;
  *) exit "$status" ;;
esac
case "$output" in
  *'database is not initialized'*)
    stop 'the data folder has no database; check ONELOOP_DATA_DIR in the plist, or create a new instance with oneloop db migrate' ;;
esac
exec "$1" serve
