#!/usr/bin/env bash
# Context installer — macOS, Linux, and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/darvh/context/main/install.sh | bash
#   bash install.sh [--local] [--targets <agents>] [--version <tag>]
#                   [--force] [--dry-run] [--hooks]

set -euo pipefail

mode="global"
targets="all"
version=""
force=0
dry_run=0
hooks=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode="local" ;;
    --targets) targets="${2:-all}"; shift ;;
    --targets=*) targets="${1#--targets=}" ;;
    --version) version="${2:-}"; shift ;;
    --version=*) version="${1#--version=}" ;;
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
source_path="${BASH_SOURCE[0]:-}"
source_dir=""
if [[ -n "$source_path" ]]; then
  source_dir="$(cd "$(dirname "$source_path")" 2>/dev/null && pwd)" || source_dir=""
fi

tmp_dir=""
cleanup() { [[ -z "$tmp_dir" ]] || rm -rf "$tmp_dir"; }
trap cleanup EXIT

platform=""
case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64) platform="darwin-arm64" ;;
  Darwin:x86_64) platform="darwin-x64" ;;
  Linux:x86_64|Linux:amd64) platform="linux-x64" ;;
  Linux:arm64|Linux:aarch64) platform="linux-arm64" ;;
  *) platform="unsupported" ;;
esac

valid_source() {
  [[ -n "$source_dir" && -f "$source_dir/package.json" && -d "$source_dir/skill" ]]
}

acquire_source() {
  if valid_source; then return; fi
  command -v git >/dev/null 2>&1 || { echo "context: source fallback requires git" >&2; exit 1; }
  [[ -n "$tmp_dir" ]] || tmp_dir="$(mktemp -d)"
  git clone --depth 1 https://github.com/darvh/context.git "$tmp_dir/source" >/dev/null 2>&1 || {
    echo "context: source clone failed" >&2
    exit 1
  }
  source_dir="$tmp_dir/source"
}

install_from_source() {
  command -v bun >/dev/null 2>&1 || {
    echo "context: Bun is required for source installation (https://bun.sh/)" >&2
    exit 1
  }
  acquire_source
  if [[ "$mode" == "global" ]]; then
    rm -rf "$install_root"
    mkdir -p "$install_root"
    cp -R "$source_dir/." "$install_root/"
    (cd "$install_root" && bun install --frozen-lockfile)
    mkdir -p "$bin_dir"
    (cd "$install_root" && bun run build >/dev/null)
    cat > "$bin_dir/context" <<EOF
#!/usr/bin/env bash
binary="$install_root/dist/context"
if [[ -x "\$binary" ]]; then
  "\$binary" "\$@" 2>/dev/null
  status=\$?
  if [[ \$status -ne 137 && \$status -ne 126 && \$status -ne 127 ]]; then
    exit \$status
  fi
fi
exec bun run "$install_root/src/cli.ts" "\$@"
EOF
    chmod 755 "$bin_dir/context"
  fi
  runtime_root="${install_root:-$source_dir}"
  if [[ "$mode" == "local" ]]; then runtime_root="$source_dir"; fi
  init_args=(--targets "$targets")
  [[ "$mode" == "local" ]] && init_args+=(--project --root "$PWD")
  [[ "$force" == 1 ]] && init_args+=(--force)
  [[ "$dry_run" == 1 ]] && init_args+=(--dry-run)
  [[ "$hooks" == 1 ]] && init_args+=(--hooks)
  bun run "$runtime_root/src/cli.ts" init "${init_args[@]}"
}

install_from_release() {
  [[ "$platform" != "unsupported" ]] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v unzip >/dev/null 2>&1 || return 1
  [[ -n "$tmp_dir" ]] || tmp_dir="$(mktemp -d)"
  local tag="$version"
  if [[ -z "$tag" ]]; then
    tag="$(curl -fsSL https://api.github.com/repos/darvh/context/releases/latest | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  local asset="context-${tag}-${platform}.zip"
  local archive="$tmp_dir/$asset"
  curl -fL --silent --show-error "https://github.com/darvh/context/releases/download/${tag}/${asset}" -o "$archive" || return 1
  unzip -q "$archive" -d "$tmp_dir/extract"
  [[ -d "$tmp_dir/extract/context/dist" && -f "$tmp_dir/extract/context/skill/SKILL.md" ]] || return 1
  rm -rf "$install_root"
  mkdir -p "$(dirname "$install_root")"
  mv "$tmp_dir/extract/context" "$install_root"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/context" <<EOF
#!/usr/bin/env bash
exec "$install_root/dist/context" "\$@"
EOF
  chmod 755 "$bin_dir/context"
  runtime_root="$install_root"
  return 0
}

if [[ "$dry_run" == 1 ]]; then
  echo "context install (scope: $mode, targets: $targets, platform: $platform)"
  [[ "$mode" == "global" ]] && echo "  release asset: context-${version:-latest}-${platform}.zip"
  [[ "$hooks" == 1 ]] && echo "  hooks: source fallback required"
  exit 0
fi

if [[ "$mode" == "local" || "$hooks" == 1 ]]; then
  install_from_source
elif [[ "$mode" == "global" ]]; then
  runtime_root=""
  if install_from_release; then
    init_args=(init --targets "$targets")
    [[ "$force" == 1 ]] && init_args+=(--force)
    "$install_root/dist/context" "${init_args[@]}"
  else
    echo "context: release unavailable; falling back to source installation" >&2
    install_from_source
  fi
fi

if [[ "$mode" == "global" ]]; then
  echo "context: installed command at $bin_dir/context"
  if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
    echo "context: add $bin_dir to PATH to use the command directly"
  fi
fi
