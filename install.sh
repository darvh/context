#!/usr/bin/env bash
# Context installer — macOS, Linux, and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/darvh/context/main/install.sh | bash
#   bash install.sh [--local] [--targets <agents>] [--version <tag>]
#                   [--force|--no-force] [--dry-run] [--hooks|--no-hooks]
#                   [--from-source] [--no-modify-path] [--uninstall] [--help]
#
# Global installs are binary-first: download the release ZIP for this OS/arch,
# verify its published SHA-256, unpack to ~/.local/share/context, and write a
# launcher into ~/.local/bin. Source installs (checkout, --from-source, or a
# missing/incompatible release) require Bun. Hooks are self-hosted by the
# compiled binary, so `--hooks` no longer forces a source build.

set -euo pipefail

mode="global"
targets="all"
version=""
force=1 # installer intent: bring installed copies up to date; --no-force opts out
dry_run=0
hooks=1 # hooks install by default; --no-hooks opts out
from_source=0
modify_path=1
uninstall=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) mode="local" ;;
    --targets) targets="${2:-all}"; shift ;;
    --targets=*) targets="${1#--targets=}" ;;
    --version) version="${2:-}"; shift ;;
    --version=*) version="${1#--version=}" ;;
    --force) force=1 ;;
    --no-force) force=0 ;;
    --dry-run) dry_run=1 ;;
    --hooks) hooks=1 ;;
    --no-hooks) hooks=0 ;;
    --from-source) from_source=1 ;;
    --no-modify-path) modify_path=0 ;;
    --uninstall) uninstall=1 ;;
    -h|--help)
      cat <<'EOF'
context install.sh

Installs the `context` command and its agent skill.

USAGE:
    install.sh [OPTIONS]

OPTIONS:
    --local                 Install into the current project (requires Bun)
    --targets <agents>      Comma-separated agents (default: all)
    --version <tag>         Release tag to install, for example v0.1.0
    --force / --no-force    Overwrite an existing install (default: force)
    --dry-run               Print the plan, install nothing
    --hooks / --no-hooks    Wire host hooks (default: hooks)
    --from-source           Install from a source checkout (requires Bun)
    --no-modify-path        Do not add the bin dir to your shell PATH
    --uninstall             Remove the install, launcher, and PATH entry
    -h, --help              Show this help

ENVIRONMENT:
    CONTEXT_HOME            Install prefix (default: ~/.local/share/context)
    CONTEXT_BIN_DIR         Launcher dir (default: ~/.local/bin)
    CONTEXT_NO_MODIFY_PATH  Set to 1 to skip PATH setup
    CONTEXT_VERSION         Release tag, same as --version
    CONTEXT_INSTALL_ALLOW_SUDO  Set to 1 to allow running as root via sudo
EOF
      exit 0
      ;;
    *) echo "context: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

user_home="${HOME:?HOME is not set}"
# This installer writes into $HOME. Running it with sudo typically resolves
# HOME to root's home, leaving root-owned files the user's shell can't use.
if [[ "$(id -u)" == 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" && "${CONTEXT_INSTALL_ALLOW_SUDO:-0}" != "1" ]]; then
  echo "context: do not run this installer with sudo." >&2
  echo "context: it installs into your home directory and needs no root access." >&2
  echo "context: to intentionally install for root, set CONTEXT_INSTALL_ALLOW_SUDO=1." >&2
  exit 1
fi
install_root="${CONTEXT_HOME:-${XDG_DATA_HOME:-$user_home/.local/share}/context}"
bin_dir="${CONTEXT_BIN_DIR:-${XDG_BIN_HOME:-$user_home/.local/bin}}"
[[ -n "${CONTEXT_VERSION:-}" && -z "$version" ]] && version="$CONTEXT_VERSION"
[[ "${CONTEXT_NO_MODIFY_PATH:-0}" == "1" ]] && modify_path=0
legacy_root="$user_home/.context"

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
  [[ -n "$source_dir" && -f "$source_dir/package.json" && -f "$source_dir/src/cli.ts" ]]
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

# Self-testing launcher: global installs try the compiled binary and fall
# back to the Bun source entrypoint if the host cannot execute it; local
# installs are source-first (the checkout is the install). Shared template
# lives in scripts/build/mk-launcher.sh so the installer and its tests use
# one source of truth.
write_launcher() {
  local root="$1"
  local mode="${2:-global}"
  local mk="${source_dir}/scripts/build/mk-launcher.sh"
  if [[ ! -f "$mk" ]]; then mk="$root/scripts/build/mk-launcher.sh"; fi
  bash "$mk" "$root" "$bin_dir" "$mode"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# Verify a downloaded artifact against its published .sha256 (first field).
# Fail closed on mismatch; warn and continue only when no tool/checksum exists.
verify_checksum() {
  local file="$1" checksum_file="$2"
  local expected=""
  if [[ -f "$checksum_file" ]]; then
    expected="$(awk '{print $1; exit}' "$checksum_file")"
  fi
  if [[ -z "$expected" ]]; then
    echo "context: no published checksum; skipping verification" >&2
    return 0
  fi
  local actual
  if ! actual="$(sha256_of "$file")"; then
    echo "context: no sha256 tool available; skipping verification" >&2
    return 0
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "context: checksum mismatch for $(basename "$file")" >&2
    echo "context:   expected $expected" >&2
    echo "context:   actual   $actual" >&2
    return 1
  fi
  echo "context: verified sha256 $(basename "$file")"
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
    write_launcher "$install_root"
  fi
  runtime_root="$source_dir"
  if [[ "$mode" == "global" ]]; then runtime_root="$install_root"; fi
  init_args=(--targets "$targets" --create)
  [[ "$force" == 1 ]] && init_args+=(--force)
  [[ "$dry_run" == 1 ]] && init_args+=(--dry-run)
  [[ "$hooks" == 0 ]] && init_args+=(--no-hooks)
  # run init from the current source: the installed dist may be a stale
  # release build, and local mode means "from this checkout". The global
  # install just rebuilt dist/context, so its binary is fresh — it self-hosts
  # the hook commands ("<binary>" hook-user) so the installed system needs
  # no bun or node.
  if [[ "$mode" == "local" ]]; then
    bun run "$source_dir/src/cli.ts" init "${init_args[@]}"
    # point PATH `context` at the checkout so the command is never stale
    write_launcher "$source_dir" local
  elif [[ -x "$install_root/dist/context" ]]; then
    "$install_root/dist/context" init "${init_args[@]}"
  else
    bun run "$runtime_root/src/cli.ts" init "${init_args[@]}"
  fi
}

install_from_release() {
  [[ "$platform" != "unsupported" ]] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v unzip >/dev/null 2>&1 || return 1
  [[ -n "$tmp_dir" ]] || tmp_dir="$(mktemp -d)"
  local tag="$version"
  if [[ -z "$tag" ]]; then
    tag="$(curl -fsSL https://api.github.com/repos/darvh/context/releases/latest 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  fi
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  local asset="context-${tag}-${platform}.zip"
  local archive="$tmp_dir/$asset"
  local base="https://github.com/darvh/context/releases/download/${tag}"
  curl -fL --silent --show-error "$base/$asset" -o "$archive" || return 1
  if curl -fL --silent --show-error "$base/$asset.sha256" -o "$archive.sha256"; then
    # a mismatch is fatal: do not silently fall back to a source clone
    verify_checksum "$archive" "$archive.sha256" || { rm -f "$archive"; return 2; }
  else
    echo "context: no checksum asset published for ${tag}; skipping verification" >&2
  fi
  unzip -q "$archive" -d "$tmp_dir/extract"
  [[ -f "$tmp_dir/extract/context/dist/context" && -f "$tmp_dir/extract/context/skill/SKILL.md" ]] || return 1
  rm -rf "$install_root"
  mkdir -p "$(dirname "$install_root")"
  mv "$tmp_dir/extract/context" "$install_root"
  mkdir -p "$bin_dir"
  write_launcher "$install_root"
  runtime_root="$install_root"
  return 0
}

# Prepend bin_dir to PATH via an env script sourced from shell rc files.
# Mirrors uv's approach: idempotent, late-bound to $HOME, silently skipped
# when bin_dir is already on PATH or --no-modify-path is set.
setup_path() {
  if [[ ":$PATH:" == *":$bin_dir:"* ]]; then return 0; fi
  if [[ -n "${GITHUB_PATH:-}" ]]; then printf '%s\n' "$bin_dir" >> "$GITHUB_PATH"; fi
  [[ "$modify_path" == 1 ]] || return 0
  mkdir -p "$bin_dir"
  local env_script="$bin_dir/context-env.sh"
  cat > "$env_script" <<EOF
#!/usr/bin/env sh
# Added by the context installer: prepend the context bin dir to PATH once.
if [ -d "$bin_dir" ]; then
  case ":\$PATH:" in
    *:"$bin_dir":*) ;;
    *) PATH="$bin_dir:\$PATH"; export PATH ;;
  esac
fi
EOF
  chmod 644 "$env_script"
  local line=". \"$env_script\""
  local added=0
  for rc in "$user_home/.profile" "$user_home/.bashrc" "$user_home/.bash_profile" "$user_home/.zshrc" "$user_home/.zshenv"; do
    [[ -f "$rc" ]] || continue
    if grep -qxF "$line" "$rc" 2>/dev/null; then continue; fi
    printf '\n%s\n' "$line" >> "$rc"
    added=1
  done
  if [[ $added == 0 && ! -f "$user_home/.profile" ]]; then
    printf '\n%s\n' "$line" >> "$user_home/.profile"
  fi
}

remove_path() {
  local env_script="$bin_dir/context-env.sh"
  for rc in "$user_home/.profile" "$user_home/.bashrc" "$user_home/.bash_profile" "$user_home/.zshrc" "$user_home/.zshenv"; do
    [[ -f "$rc" ]] || continue
    if grep -qF ". \"$env_script\"" "$rc" 2>/dev/null; then
      grep -vF ". \"$env_script\"" "$rc" > "$rc.context-tmp" || true
      mv "$rc.context-tmp" "$rc"
    fi
  done
  rm -f "$env_script"
}

do_uninstall() {
  echo "context uninstall (scope: $mode)"
  if [[ "$dry_run" == 1 ]]; then
    echo "  would remove $install_root and $bin_dir/context"
    exit 0
  fi
  rm -f "$bin_dir/context"
  remove_path
  if [[ "$mode" == "global" ]]; then
    rm -rf "$install_root"
    echo "context: removed $install_root"
    [[ -d "$legacy_root" ]] && echo "context: legacy install still present at $legacy_root"
  else
    echo "context: removed launcher $bin_dir/context"
  fi
  echo "context: done"
}

if [[ "$uninstall" == 1 ]]; then
  do_uninstall
  exit 0
fi

if [[ -d "$legacy_root" && ! -d "$install_root" ]]; then
  echo "context: note: found legacy install at $legacy_root (now $install_root); re-run with --uninstall to clean it up" >&2
fi

if [[ "$dry_run" == 1 ]]; then
  echo "context install (scope: $mode, targets: $targets, platform: $platform)"
  echo "  install root: $install_root"
  echo "  launcher: $bin_dir/context"
  if [[ "$mode" == "global" ]]; then
    if [[ "$from_source" == 1 ]]; then
      echo "  source install (--from-source)"
    else
      echo "  release asset: context-${version:-latest}-${platform}.zip (sha256 verified)"
    fi
  fi
  echo "  hooks: $([[ "$hooks" == 1 ]] && echo "yes" || echo "no")"
  exit 0
fi

if [[ "$mode" == "local" || "$from_source" == 1 ]]; then
  install_from_source
elif [[ "$mode" == "global" ]]; then
  runtime_root=""
  release_status=0
  install_from_release || release_status=$?
  if [[ "$release_status" == 0 ]]; then
    init_args=(init --targets "$targets" --create)
    [[ "$force" == 1 ]] && init_args+=(--force)
    [[ "$hooks" == 0 ]] && init_args+=(--no-hooks)
    "$install_root/dist/context" "${init_args[@]}"
  elif [[ "$release_status" == 2 ]]; then
    echo "context: aborting: release checksum verification failed" >&2
    exit 1
  else
    echo "context: release unavailable; falling back to source installation" >&2
    install_from_source
  fi
fi

if [[ "$mode" == "global" ]]; then
  setup_path
  # a pre-XDG install put its launcher under ~/.context/bin; if that dir is on
  # PATH it would shadow the new launcher, so remove the stale file (the tree
  # itself is left for --uninstall to clean up)
  if [[ "$legacy_root" != "$install_root" && -f "$legacy_root/bin/context" ]]; then
    rm -f "$legacy_root/bin/context"
    echo "context: removed legacy launcher $legacy_root/bin/context"
  fi
  echo "context: installed command at $bin_dir/context"
  if [[ "$modify_path" == 1 && -f "$bin_dir/context-env.sh" ]]; then
    echo "context: added $bin_dir to PATH; restart your shell or run: . \"$bin_dir/context-env.sh\""
  elif [[ ":$PATH:" != *":$bin_dir:"* ]]; then
    echo "context: add $bin_dir to PATH to use the command directly"
  fi
fi
