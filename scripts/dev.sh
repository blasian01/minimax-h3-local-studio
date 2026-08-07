#!/bin/sh
set -eu

is_compatible_node() {
  [ -x "$1" ] || return 1
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' >/dev/null 2>&1
}

current_node="$(command -v node 2>/dev/null || true)"

for candidate in "$current_node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if is_compatible_node "$candidate"; then
    if [ "$candidate" != "$current_node" ]; then
      echo "Using compatible Node runtime: $($candidate --version) ($candidate)"
    fi
    exec "$candidate" scripts/studio.mjs
  fi
done

echo "MiniMax Studio requires Node.js 22.13 or newer." >&2
echo "Install it with: brew install node" >&2
exit 1
