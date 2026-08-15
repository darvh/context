#!/usr/bin/env bash
# Generate the `context` launcher. Used by install.sh (and its tests), one
# source of truth. Args: root, bin_dir, mode (default "global").
#   global — binary-first: try the compiled binary, fall back to the Bun
#            source entrypoint when the host cannot execute it (wrong arch,
#            missing loader, killed: 126/127/137).
#   local  — source-first: in a checkout install the source IS the install, so
#            a stale checkout dist must never shadow it.
set -euo pipefail
root="$1"
bin_dir="$2"
mode="${3:-global}"
src="$root/src/cli.ts"

mkdir -p "$bin_dir"
if [[ "$mode" == "local" ]]; then
  cat > "$bin_dir/context" <<EOF
#!/usr/bin/env bash
# local (checkout) install: the Bun source is the install
if [[ -f "$src" ]] && command -v bun >/dev/null 2>&1; then
  [[ -d "$root/node_modules" ]] || (cd "$root" && bun install --frozen-lockfile >/dev/null 2>&1 || true)
  exec bun run "$src" "\$@"
fi
echo "context: local install needs bun (source at $root)" >&2
exit 1
EOF
else
  cat > "$bin_dir/context" <<EOF
#!/usr/bin/env bash
binary="$root/dist/context"
if [[ -x "\$binary" ]]; then
  "\$binary" "\$@"
  status=\$?
  if [[ \$status -ne 137 && \$status -ne 126 && \$status -ne 127 ]]; then
    exit \$status
  fi
  echo "context: compiled binary could not run (exit \$status); falling back to source" >&2
fi
if [[ -f "$src" ]] && command -v bun >/dev/null 2>&1; then
  [[ -d "$root/node_modules" ]] || (cd "$root" && bun install --frozen-lockfile >/dev/null 2>&1 || true)
  exec bun run "$src" "\$@"
fi
echo "context: cannot execute compiled binary and Bun source fallback is unavailable" >&2
exit 1
EOF
fi
chmod 755 "$bin_dir/context"
echo "context: wrote launcher -> $bin_dir/context"
