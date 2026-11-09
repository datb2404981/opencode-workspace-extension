#!/usr/bin/env bash
set -euo pipefail

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="${OPENCODE_PLUGIN_DIR:-$HOME/.config/opencode/workspace-plugin}"

if [[ -n "${OPENCODE_CONFIG:-}" ]]; then
  config_file="$OPENCODE_CONFIG"
elif [[ -f "$HOME/.config/opencode/opencode.json" ]]; then
  config_file="$HOME/.config/opencode/opencode.json"
elif [[ -f "$HOME/.opencode/opencode.json" ]]; then
  config_file="$HOME/.opencode/opencode.json"
else
  config_file="$HOME/.config/opencode/opencode.json"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The native file picker requires macOS. See README.md for platform support." >&2
  exit 1
fi

for command_name in python3 xcrun; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing $command_name. Install Python 3 and Xcode Command Line Tools." >&2
    exit 1
  fi
done

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Swift compiler not found. Run: xcode-select --install" >&2
  exit 1
fi

if [[ "$plugin_dir" != /* || "$config_file" != /* || "$plugin_dir" == / || "$plugin_dir" == "$HOME" ]]; then
  echo "OPENCODE_PLUGIN_DIR and OPENCODE_CONFIG must be safe, absolute paths." >&2
  exit 1
fi

python3 - "$config_file" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if path.exists():
    with path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict) or not isinstance(config.get("plugins", []), list):
        raise SystemExit("OpenCode config must be a JSON object with an optional plugins array")
PY

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencode-workspace.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT

find "$repository_dir" -maxdepth 1 -type f -name '*.ts' ! -name '*.test.ts' -exec cp {} "$staging_dir"/ \;
cp "$repository_dir/package.json" "$repository_dir/FilePicker.swift" "$staging_dir/"
mkdir -p "$staging_dir/OpenCodeFilePicker.app/Contents/MacOS"
cp "$repository_dir/macos/Info.plist" "$staging_dir/OpenCodeFilePicker.app/Contents/Info.plist"
xcrun swiftc -O "$repository_dir/FilePicker.swift" -o "$staging_dir/OpenCodeFilePicker.app/Contents/MacOS/OpenCodeFilePicker"

mkdir -p "$(dirname "$plugin_dir")" "$(dirname "$config_file")"
backup_dir=""
if [[ -e "$plugin_dir" ]]; then
  if [[ ! -d "$plugin_dir" || ! -f "$plugin_dir/workspace-server.ts" ]]; then
    echo "An unrelated file or directory already occupies $plugin_dir. Choose OPENCODE_PLUGIN_DIR." >&2
    exit 1
  fi
  backup_dir="${plugin_dir}.backup-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$plugin_dir" "$backup_dir"
fi

mv "$staging_dir" "$plugin_dir"

if ! python3 - "$config_file" "$plugin_dir" <<'PY'
import json
import os
import shutil
import stat
import sys
import tempfile
from datetime import datetime
from pathlib import Path

path = Path(sys.argv[1])
plugin = str(Path(sys.argv[2]).resolve())
config = {}
mode = 0o600
if path.exists():
    with path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    mode = stat.S_IMODE(path.stat().st_mode)
    backup = path.with_name(path.name + ".backup-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    shutil.copy2(path, backup)

plugins = config.setdefault("plugins", [])
if plugin not in plugins:
    plugins.append(plugin)

fd, temporary_path = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(temporary_path, mode)
    os.replace(temporary_path, path)
finally:
    if os.path.exists(temporary_path):
        os.unlink(temporary_path)
PY
then
  mv "$plugin_dir" "${staging_dir}.failed"
  if [[ -n "$backup_dir" ]]; then
    mv "$backup_dir" "$plugin_dir"
  fi
  echo "Could not update $config_file. Previous plugin installation was restored." >&2
  exit 1
fi

printf 'Installed OpenCode extension at %s\n' "$plugin_dir"
printf 'Registered plugin in %s\n' "$config_file"
if [[ -n "$backup_dir" ]]; then
  printf 'Previous plugin backup: %s\n' "$backup_dir"
fi
printf 'Restart OpenCode to load the extension.\n'
