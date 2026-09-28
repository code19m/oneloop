#!/bin/sh
# launchd distinguishes success from failure, but cannot select exit code 2.
# Run with the plist's exact environment, then replace this shell with the server.
if [ "$#" -ne 1 ]; then
  echo 'usage: oneloop-launchd.sh /absolute/path/to/oneloop' >&2
  exit 0
fi
"$1" serve --check
status=$?
case "$status" in
  0) exec "$1" serve ;;
  2)
    echo 'oneloop: configuration check failed; fix the plist and bootstrap the job again' >&2
    exit 0 ;;
  *) exit "$status" ;;
esac
