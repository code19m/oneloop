#!/usr/bin/env bash
# Run the Docker install steps from docs/src/install.md against a locally built image.
#
# Usage: scripts/check-quickstart.sh [IMAGE]
#
# IMAGE (default oneloop:check) is tagged as the image deploy/compose.yaml names.
# Every shell block marked <!-- quickstart --> then runs, in order, in a temporary
# folder next to an unchanged copy of deploy/compose.yaml. The script waits for
# /healthz and removes the containers, volume and tag it created. It uses its own
# Compose project and volume names, so an existing oneloop setup is not touched.
# Set QUICKSTART_PORT to publish on a host port other than 8080.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
image=${1:-oneloop:check}
port=${QUICKSTART_PORT:-8080}
guide="$root/docs/src/install.md"
id="oneloop-quickstart-$$"

fail() { echo "check-quickstart: $*" >&2; exit 1; }
docker image inspect "$image" >/dev/null 2>&1 || fail "image $image not found; build it first"

mkdir -p "$root/target"
work=$(mktemp -d "$root/target/quickstart.XXXXXX")
compose_image="" previous_image=""
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  status=$?
  cd "$work"
  if [ -f compose.override.yaml ]; then
    if [ "$status" -ne 0 ]; then docker compose logs --no-color >&2 2>/dev/null || true; fi
    docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker volume rm "$id-data" >/dev/null 2>&1 || true
  fi
  if [ -n "$previous_image" ]; then
    docker tag "$previous_image" "$compose_image" || true
  elif [ -n "$compose_image" ]; then
    docker image rm "$compose_image" >/dev/null 2>&1 || true
  fi
  cd "$root" && rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
cp "$root/deploy/compose.yaml" "$work/compose.yaml"

# The marked blocks, in document order. A marker must be followed by a shell block.
awk '
  /^<!-- quickstart -->$/ { marked = 1; next }
  marked && /^```(sh|bash|shell)$/ { marked = 0; inside = 1; blocks++; next }
  marked && !/^$/ { print "quickstart marker at line " NR " is not followed by a shell block" > "/dev/stderr"; bad = 1; exit 1 }
  inside && /^```$/ { inside = 0; next }
  inside { print }
  END { if (bad) exit 1; if (!blocks) { print "no quickstart blocks found" > "/dev/stderr"; exit 1 } }
' "$guide" > "$work/quickstart.sh"

export COMPOSE_PROJECT_NAME="$id"
cd "$work"
images=$(docker compose config --images)
[ -n "$images" ] || fail "deploy/compose.yaml names no image"
# Keep the documented file unchanged; point the port, URL and volume at test values.
cat > compose.override.yaml <<EOF
services:
  oneloop:
    ports: !override
      - "127.0.0.1:$port:8080"
    environment:
      ONELOOP_PUBLIC_URL: http://localhost:$port
volumes:
  oneloop-data:
    name: $id-data
EOF

compose_image=${images%%$'\n'*}
previous_image=$(docker image inspect --format '{{.Id}}' "$compose_image" 2>/dev/null || true)
docker tag "$image" "$compose_image"

echo "Running the quick start with $image as $compose_image"
bash -euxo pipefail quickstart.sh < /dev/null

echo "Waiting for http://localhost:$port/healthz"
for _ in $(seq 60); do
  if health=$(curl -fsS -H "Host: localhost:$port" "http://127.0.0.1:$port/healthz" 2>/dev/null); then
    case "$health" in
      '{"status":"ok"'*) echo "Quick start passed: $health"; exit 0 ;;
    esac
  fi
  sleep 1
done
fail "/healthz did not report ok within 60 seconds"
