#!/usr/bin/env bash
# macOS only: `bun build --compile` output is rejected by dyld ("Code Signature
# Invalid") on recent macOS and SIGKILLed at launch. Re-sign ad hoc so the
# packaged binary actually runs. No-op elsewhere (codesign absent).
set -e

if ! command -v codesign >/dev/null 2>&1; then
  echo "sign: codesign not found (not macOS?) — nothing to do"
  exit 0
fi

bin="${1:-dist/context}"
if [[ ! -f "$bin" ]]; then
  echo "sign: $bin not found" >&2
  exit 1
fi

codesign --force -s - "$bin"
echo "sign: re-signed $bin"
