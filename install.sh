#!/usr/bin/env bash
# Context installer — macOS, Linux, and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/darvh/context/main/install.sh | bash
#   bash install.sh [--local] [--targets <agents>] [--force] [--dry-run] [--hooks]

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "context: Bun is required (https://bun.sh/)" >&2
  exit 1
fi

source_path="${BASH_SOURCE[0]:-}"
source_dir=""
if [[ -n "$source_path" ]]; then
  source_dir="$(cd "$(dirname "$source_path")" 2>/dev/null && pwd)" || source_dir=""
fi

tmp_dir=""
cleanup() { [[ -z "$tmp_dir" ]] || rm -rf "$tmp_dir"; }
trap cleanup EXIT

if [[ -z "$source_dir" || ! -f "$source_dir/package.json" || ! -d "$source_dir/skill" ]]; then
  tmp_dir="$(mktemp -d)"
  git clone --depth 1 https://github.com/darvh/context.git "$tmp_dir/context" >/dev/null 2>&1 || {
    echo "context: clone failed (need git)" >&2
    exit 1
  }
  source_dir="$tmp_dir/context"
fi

mode="global"
targets="all"
force=0
dry_run=0
hooks=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode="local" ;;
    --targets) targets="${2:-all}"; shift ;;
    --targets=*) targets="${1#--targets=}" ;;
    --force) force=1 ;;
    --dry-run) dry_run=1 ;;
    --hooks) hooks=1 ;;
    *) echo "context: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

user_home="${HOME:?HOME is not set}"
install_root="$user_home/.local/share/context"
bin_dir="$user_home/.local/bin"

if [[ "$mode" == "global" && "$dry_run" == 0 ]]; then
  rm -rf "$install_root"
  mkdir -p "$install_root"
  cp -R "$source_dir/." "$install_root/"
  (cd "$install_root" && bun install --frozen-lockfile)
  mkdir -p "$bin_dir"
  (cd "$install_root" && bun run build >/dev/null)
  cat > "$bin_dir/context" <<EOF
#!/usr/bin/env bash
exec "$install_root/dist/context" "\$@"
EOF
  chmod 755 "$bin_dir/context"
fi

if [[ "$mode" == "local" ]]; then
  runtime_root="$source_dir"
  init_args=(--project --root "$PWD")
else
  runtime_root="$install_root"
  init_args=()
fi

if [[ "$dry_run" == 1 && "$mode" == "global" ]]; then
  echo "context install (global, dry-run; runtime would be $install_root)"
  echo "  command     install    $bin_dir/context"
else
  init_args+=(--targets "$targets")
  [[ "$force" == 1 ]] && init_args+=(--force)
  [[ "$dry_run" == 1 ]] && init_args+=(--dry-run)
  [[ "$hooks" == 1 ]] && init_args+=(--hooks)
  bun run "$runtime_root/src/cli.ts" init "${init_args[@]}"
fi

if [[ "$mode" == "global" && "$dry_run" == 0 ]]; then
  echo "context: installed command at $bin_dir/context"
  if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
    echo "context: add $bin_dir to PATH to use the command directly"
  fi
fi
