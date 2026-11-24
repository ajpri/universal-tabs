#!/usr/bin/env python3
"""Install, update, package, or inspect Universal Tabs without third-party tools."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
UUID = "universal-tabs@extensions.local"
FILES = ("runtime.js", "groups.js", "runtime.css")
DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
INSTALL = DATA / "gnome-shell/extensions" / UUID


def find_install(data=DATA):
    """Reuse a compatible local install without embedding its historical UUID."""
    override = os.environ.get("UNIVERSAL_TABS_INSTALL_DIR")
    if override:
        return Path(override).expanduser()
    extensions = Path(data) / "gnome-shell/extensions"
    canonical = extensions / UUID
    if canonical.exists():
        return canonical
    candidates = []
    if extensions.is_dir():
        bootstrap = (ROOT / "extension.js").read_bytes()
        for directory in extensions.iterdir():
            try:
                metadata = json.loads((directory / "metadata.json").read_text())
                if (isinstance(metadata, dict) and metadata.get("name") == "Universal Tabs" and metadata.get("uuid") == directory.name
                        and (directory / "extension.js").read_bytes() == bootstrap):
                    candidates.append(directory)
            except (OSError, ValueError, TypeError):
                continue
    if len(candidates) > 1:
        raise SystemExit("Multiple compatible installations found. Set UNIVERSAL_TABS_INSTALL_DIR to select one.")
    return candidates[0] if candidates else canonical


def atomic_write(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(contents)
    temporary.chmod(0o644)
    os.replace(temporary, path)


def stage(destination, development=False, extension_uuid=None):
    contents = [(ROOT / name).read_text() for name in FILES]
    digest = hashlib.sha256(json.dumps(contents, ensure_ascii=False,
        separators=(",", ":")).encode()).hexdigest()[:20]
    bootstrap = ROOT / "extension.js"
    installed = destination / "extension.js"
    if installed.exists() and installed.read_bytes() != bootstrap.read_bytes():
        raise SystemExit("The stable bootstrap differs from the installed version. "
                         "Runtime updates remain supported; bootstrap changes need an explicit migration.")
    destination.mkdir(parents=True, exist_ok=True)
    revision = destination / "revisions" / digest
    revision.parent.mkdir(parents=True, exist_ok=True)

    def verify_revision():
        for name, content in zip(FILES, contents):
            file = revision / name
            if not file.is_file() or file.read_bytes() != content.encode():
                raise SystemExit(f"Installed revision {digest} has been modified; refusing to overwrite it.")

    if revision.exists():
        verify_revision()
    else:
        # Stage outside the running revision and publish the entire directory
        # at once. Never modify files belonging to an installed revision.
        with tempfile.TemporaryDirectory(prefix=".staging-", dir=revision.parent) as temp:
            candidate = Path(temp)
            for name, content in zip(FILES, contents):
                (candidate / name).write_bytes(content.encode())
            candidate.chmod(0o755)
            try:
                candidate.rename(revision)
            except OSError:
                if not revision.exists():
                    raise
                verify_revision()
    if not installed.exists():
        atomic_write(installed, bootstrap.read_bytes())
    metadata = (ROOT / "metadata.json").read_bytes()
    if extension_uuid:
        metadata = json.dumps({**json.loads(metadata), "uuid": extension_uuid}, indent=2).encode() + b"\n"
    atomic_write(destination / "metadata.json", metadata)
    manifest = {"revision": digest}
    existing = destination / "runtime.json"
    if existing.exists():
        manifest.update(json.loads(existing.read_text()))
    manifest["revision"] = digest
    # Normal installs/updates explicitly detach any previous development link.
    manifest.pop("sourceDirectory", None)
    if development:
        manifest["sourceDirectory"] = str(ROOT)
    # Publish the pointer only after every file in the immutable revision exists.
    atomic_write(existing, (json.dumps(manifest, indent=2) + "\n").encode())
    return digest


def restore_controls(destination=None):
    if destination is None:
        destination = find_install()
    backup = destination / 'window-controls-backup.json'
    if not backup.exists():
        print('No saved window-button layout to restore.')
        return
    state = json.loads(backup.read_text())
    if (state.get('version') != 1 or not isinstance(state.get('applied'), str)
            or ('previousUser' not in state or state['previousUser'] is not None
                and not isinstance(state['previousUser'], str))):
        raise SystemExit('Invalid window-button recovery file; no settings were changed.')
    schema, key = 'org.gnome.desktop.wm.preferences', 'button-layout'
    current = ast.literal_eval(subprocess.run(['gsettings', 'get', schema, key],
        check=True, capture_output=True, text=True).stdout.strip())
    if current == state['applied']:
        if state['previousUser'] is None:
            command = ['gsettings', 'reset', schema, key]
        else:
            command = ['gsettings', 'set', schema, key, repr(state['previousUser'])]
        subprocess.run(command, check=True)
        print('Restored the saved GNOME window-button layout.')
    else:
        print('Preserved the newer GNOME window-button layout.')
    backup.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "update", "pack", "status", "restore-controls"))
    parser.add_argument("--development", action="store_true",
                        help="Watch runtime.js, groups.js, and runtime.css in this checkout")
    args = parser.parse_args()
    destination = find_install() if args.command != 'pack' else None
    extension_uuid = destination.name if destination else UUID
    if args.command == 'restore-controls':
        restore_controls(destination)
        return
    if args.command == "pack":
        output = ROOT / "dist" / f"{UUID}.shell-extension.zip"
        output.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="universal-tabs-pack-") as temp:
            directory = Path(temp)
            stage(directory)
            for name in ("README.md", "LICENSE"):
                shutil.copy2(ROOT / name, directory / name)
            screenshots = ROOT / "docs/images"
            if screenshots.is_dir():
                shutil.copytree(screenshots, directory / "docs/images")
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                for file in sorted(directory.rglob("*")):
                    if file.is_file():
                        archive.write(file, file.relative_to(directory))
        print(output)
        return
    if args.command == "status":
        print(f"Install: {destination}")
        for name in ("runtime.json", "runtime-status.json"):
            file = destination / name
            if file.exists():
                print(f"{name}:\n{file.read_text()}")
        result = subprocess.run(["gnome-extensions", "info", extension_uuid], check=False)
        raise SystemExit(result.returncode)
    if args.command == "update" and not (destination / "extension.js").exists():
        raise SystemExit("Install first: python3 extensionctl.py install")
    revision = stage(destination, args.development, extension_uuid)
    print(f"Installed runtime {revision} in {destination}", flush=True)
    if args.command == "install":
        result = subprocess.run(["gnome-extensions", "enable", extension_uuid], capture_output=True, text=True)
        if result.returncode:
            # GNOME does not discover an entirely new local UUID until its next
            # session. Queue only this UUID and preserve every other preference.
            for key, include in (("enabled-extensions", True), ("disabled-extensions", False)):
                current = subprocess.run(["gsettings", "get", "org.gnome.shell", key],
                    check=True, capture_output=True, text=True).stdout.strip()
                values = ast.literal_eval(current.removeprefix("@as "))
                updated = [value for value in values if value != extension_uuid]
                if include:
                    updated.append(extension_uuid)
                if updated != values:
                    subprocess.run(["gsettings", "set", "org.gnome.shell", key, repr(updated)], check=True)
            print("Files are installed. GNOME has not registered this new extension yet. "
                  "One initial sign-out/sign-in may be required; subsequent runtime updates reload live.")
            if result.stderr.strip():
                print(result.stderr.strip())
        else:
            print("Extension enabled. Future runtime updates reload automatically.")
    else:
        print("The enabled extension will reload automatically; groups and window sizes are preserved.")


if __name__ == "__main__":
    main()
