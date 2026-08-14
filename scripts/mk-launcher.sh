#!/usr/bin/env bash
# Generate the self-testing `context` launcher. Used by install.sh (and its
# tests). The launcher tries the compiled binary first; when the host cannot
# execute it (wrong arch, missing loader, killed: 126/127/137), it falls back
# to the Bun source entrypoint. Plan: "installed command self-tests the
# compiled binary and falls back to the Bun source entrypoint".
set -euo pipefail
root="$1"
bin_dir="$2"

mkdir -p "$bin_dir"
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
if [[ -f "$root/src/cli.ts" ]] && command -v bun >/dev/null 2>&1; then
  [[ -d "$root/node_modules" ]] || (cd "$root" && bun install --frozen-lockfile >/dev/null 2>&1 || true)
  exec bun run "$root/src/cli.ts" "\$@"
fi
echo "context: cannot execute compiled binary and Bun source fallback is unavailable" >&2
exit 1
EOF
chmod 755 "$bin_dir/context"
echo "context: wrote launcher -> $bin_dir/context"
