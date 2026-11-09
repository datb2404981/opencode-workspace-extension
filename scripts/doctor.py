#!/usr/bin/env python3
"""Check which OpenCode configuration actually registers the extension."""

import argparse
import json
import os
import re
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="OpenCode config used by the launcher")
    args = parser.parse_args()

    launcher = Path(shutil.which("opencode") or "")
    default_config = Path.home() / ".config/opencode/opencode.json"
    wrapper_launcher = (launcher.name == "opencode" and launcher.parent.name == "bin"
                        and launcher.parent.parent.name == ".opencode")
    if wrapper_launcher:
        default_config = launcher.parent.parent / "opencode.json"

    configured = Path(os.environ["OPENCODE_CONFIG"]) if os.environ.get("OPENCODE_CONFIG") else default_config
    config_path = (args.config or configured).expanduser()
    print(f"Config: {config_path}")
    if not config_path.is_file():
        print("FAIL: Config file not found. Use --config to specify the launcher's file.")
        return 1

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"FAIL: Cannot parse config ({type(exc).__name__}).")
        return 1
    if not isinstance(config, dict) or not isinstance(config.get("plugins", []), list):
        print("FAIL: Config must be an object with a plugins array.")
        return 1

    registered = [plugin for plugin in config.get("plugins", [])
                  if isinstance(plugin, str) and Path(plugin).is_absolute()
                  and (Path(plugin) / "workspace-server.ts").is_file()]
    print(f"Workspace extension: {'registered' if registered else 'missing'}")

    if wrapper_launcher and config_path.resolve() != default_config.resolve() and not os.environ.get("OPENCODE_CONFIG"):
        print(f"NOTICE: The wrapper launcher normally uses a different config: {default_config}")

    if launcher.is_file() and launcher.name == "opencode" and launcher.stat().st_size < 16_384:
        try:
            script = launcher.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            script = ""
        match = re.search(r"^export OPENCODE_CONFIG_CONTENT='([^']+)'", script, re.M)
        if match:
            try:
                overrides = json.loads(match.group(1))
                compaction = overrides.get("compaction", {})
                if isinstance(compaction, dict) and compaction.get("auto") is False:
                    print("NOTICE: Launcher disables automatic compaction through an environment override.")
                if overrides.get("lsp") is False:
                    print("NOTICE: Launcher disables LSP through an environment override.")
            except (ValueError, AttributeError):
                print("NOTICE: Launcher has a config override that could not be parsed.")

    if not registered:
        print("To install for this config, run OPENCODE_CONFIG=<config path> bash scripts/install.sh")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
