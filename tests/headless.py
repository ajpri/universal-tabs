#!/usr/bin/env python3
"""Run integration checks in an isolated GNOME 51 Wayland session.

Requires the same GNOME/GJS libraries as the desktop; no new packages.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
UUID = "universal-tabs@extensions.local"
SCREENSHOTS_ONLY = "--screenshots-only" in sys.argv
DEMO_SCREENSHOTS = (
    "floating-tabs.png", "maximized-dark.png", "new-tab.png", "settings.png")


def copy_clean_png(source, destination):
    """Keep native screenshot pixels and drop ancillary PNG metadata chunks."""
    contents = source.read_bytes()
    signature = b"\x89PNG\r\n\x1a\n"
    if not contents.startswith(signature):
        raise ValueError("Documentation screenshot is not a PNG")
    output = bytearray(signature)
    cursor = len(signature)
    while cursor + 12 <= len(contents):
        length = struct.unpack(">I", contents[cursor:cursor + 4])[0]
        chunk_type = contents[cursor + 4:cursor + 8]
        end = cursor + length + 12
        if end > len(contents):
            raise ValueError("Truncated documentation PNG")
        # Critical chunks contain image data. tRNS contains pixel transparency.
        if not chunk_type[0] & 0x20 or chunk_type == b"tRNS":
            output.extend(contents[cursor:end])
        cursor = end
        if chunk_type == b"IEND":
            destination.write_bytes(output)
            return
    raise ValueError("Documentation PNG has no end chunk")

with tempfile.TemporaryDirectory(prefix="universal-tabs-test-") as temp:
    base = Path(temp)
    for name in ("runtime", "data", "config", "cache"):
        (base / name).mkdir(mode=0o700)
    extensions = base / "data/gnome-shell/extensions"
    applications = base / "data/applications"
    applications.mkdir()
    (applications / "org.gnome.Extensions.UniversalTabsTest.desktop").write_text(
        '[Desktop Entry]\nType=Application\nName=Universal Tabs Window Test\n'
        f'Exec=gjs -m "{ROOT / "tests/fixtures/windows.js"}"\n'
        'Icon=application-x-executable\nStartupNotify=false\nTerminal=false\n')
    (applications / "org.gnome.Extensions.UniversalTabsLaunchTest.desktop").write_text(
        '[Desktop Entry]\nType=Application\nName=Universal Tabs Launcher Test\n'
        f'Exec=gjs -m "{ROOT / "tests/fixtures/launch.js"}"\n'
        'Icon=application-x-executable\nStartupNotify=true\nTerminal=false\n')
    for desktop_id, name, flag in (
            ('org.gnome.Extensions.UniversalTabsLegacyLauncher', 'UniversalTabsLegacy', '--legacy'),
            ('org.gnome.Extensions.UniversalTabsFullscreenTest', 'Universal Tabs Fullscreen Test', '--fullscreen')):
        (applications / f'{desktop_id}.desktop').write_text(
            f'[Desktop Entry]\nType=Application\nName={name}\n'
            f'Exec=gjs -m "{ROOT / "tests/fixtures/launch.js"}" {flag}\n'
            'Icon=application-x-executable\nStartupNotify=false\nTerminal=false\n')
    if SCREENSHOTS_ONLY:
        demo_icons = base / "demo-icons"
        demo_icons.mkdir()
        for name, color in (
                ("Browser", "#3584e4"), ("Notes", "#c88821"), ("Files", "#4699a8"),
                ("Calendar", "#e06d57"), ("Calculator", "#687b90"), ("Mail", "#6b83cb"),
                ("Music", "#a568b7"), ("Photos", "#65a179"), ("Reference", "#537ca7"),
                ("Sketch", "#cf8298"), ("Terminal", "#58616f"), ("Videos", "#8a71bd")):
            icon = demo_icons / f"{name.lower()}.svg"
            icon.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
                            f'<rect x="4" y="4" width="56" height="56" rx="14" fill="{color}"/>'
                            '<text x="32" y="44" text-anchor="middle" font-family="sans-serif" '
                            f'font-size="34" font-weight="700" fill="white">{name[0]}</text></svg>')
            (applications / f"org.gnome.Extensions.UniversalTabsDemo.{name}.desktop").write_text(
                f'[Desktop Entry]\nType=Application\nName={name}\n'
                f'Exec=gjs -m "{ROOT / "tests/fixtures/demo-windows.js"}" {name}\n'
                f'Icon={icon}\nStartupNotify=false\nTerminal=false\n')
    production = extensions / UUID
    production.mkdir(parents=True)
    for name in ("metadata.json", "extension.js"):
        shutil.copy2(ROOT / name, production / name)
    source = base / "source"
    source.mkdir()
    runtime_source = Path(os.environ.get("UT_TEST_RUNTIME_SOURCE", ROOT))
    for name in ("runtime.js", "groups.js", "runtime.css"):
        shutil.copy2(runtime_source / name, source / name)
    (production / "runtime.json").write_text(json.dumps({"sourceDirectory": str(source)}))
    smoke = extensions / "universal-tabs-smoke@extensions.local"
    smoke.mkdir()
    (smoke / "metadata.json").write_text(json.dumps({
        "uuid": smoke.name, "name": "Universal Tabs isolated test",
        "description": "Integration fixture", "shell-version": ["51"],
        "session-modes": ["user", "unlock-dialog"],
    }))
    fixture = "screenshots-extension.js" if SCREENSHOTS_ONLY else "smoke-extension.js"
    shutil.copy2(ROOT / "tests/fixtures" / fixture, smoke / "extension.js")
    shutil.copy2(ROOT / "tests/fixtures/settings-checks.js", smoke / "settings-checks.js")
    shutil.copy2(ROOT / "tests/fixtures/monitor-checks.js", smoke / "monitor-checks.js")
    # The keyfile backend keeps settings and extension enablement off the user's bus.
    keyfile = base / "config/glib-2.0/settings/keyfile"
    keyfile.parent.mkdir(parents=True)
    keyfile.write_text("[org/gnome/shell]\nenabled-extensions=['universal-tabs-smoke@extensions.local']\n"
                       "welcome-dialog-last-shown-version='999'\n"
                       "[org/gnome/desktop/interface]\nenable-animations=false\n")
    if SCREENSHOTS_ONLY:
        with keyfile.open("a") as stream:
            stream.write("[org/gnome/desktop/background]\npicture-uri=''\npicture-uri-dark=''\n"
                         "picture-options='none'\nprimary-color='#dfe5ee'\nsecondary-color='#dfe5ee'\n"
                         "color-shading-type='solid'\n")
    demo_output = base / "screenshots"
    demo_output.mkdir()
    env = os.environ.copy()
    env.update({
        "XDG_RUNTIME_DIR": str(base / "runtime"), "XDG_DATA_HOME": str(base / "data"),
        "XDG_CONFIG_HOME": str(base / "config"), "XDG_CACHE_HOME": str(base / "cache"),
        "GSETTINGS_BACKEND": "keyfile", "WAYLAND_DISPLAY": "universal-tabs-test-0",
        "UT_TEST_RESULT": str(base / "result.json"),
        "UT_TEST_CONTROLS": str(base / "controls.json"),
        "UT_TEST_SETTINGS_ONLY": "1" if "--settings-only" in sys.argv else "0",
        "UT_TEST_MONITORS_ONLY": "1" if "--monitors-only" in sys.argv else "0",
        "UT_TEST_WINDOWS": str(ROOT / "tests/fixtures/windows.js"),
        "UT_TEST_SOURCE": str(source),
        "UT_TEST_SCREENSHOT": str(base / "desktop.png"),
        "UT_DEMO_WINDOWS": str(ROOT / "tests/fixtures/demo-windows.js"),
        "UT_DEMO_OUTPUT": str(demo_output),
        "GIO_USE_VFS": "local",
        "GTK_A11Y": "none",
        "NO_AT_BRIDGE": "1",
    })
    if SCREENSHOTS_ONLY:
        # Keep user-installed desktop entries and custom themes off the demo.
        env["XDG_DATA_DIRS"] = "/usr/local/share:/usr/share"
        env.pop("GTK_THEME", None)
    # Drop inherited bus, display, and session identifiers for the private compositor.
    for name in ("DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "XDG_SESSION_ID"):
        env.pop(name, None)
    bus_config = base / "bus.conf"
    bus_config.write_text(
        '<busconfig><type>session</type><listen>unix:tmpdir=' + str(base / "runtime") +
        '</listen><policy context="default"><allow send_destination="*"/>'
        '<allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
    with (base / "shell.log").open("w") as log:
        compositor = [
            "dbus-run-session", "--config-file=" + str(bus_config), "--", "gnome-shell", "--headless", "--wayland", "--no-x11",
            "--virtual-monitor", "1280x800", "--wayland-display", env["WAYLAND_DISPLAY"],
        ]
        if "--monitors-only" in sys.argv:
            compositor.extend(["--virtual-monitor", "1280x800"])
        process = subprocess.Popen(compositor, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        finally:
            # Never signal a process group after its leader has exited/reaped.
            # The private bus has no activated services; its clients exit with it.
            if process.poll() is None:
                import signal
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
    result_file = base / "result.json"
    if (base / "desktop.png").exists():
        (ROOT / "dist").mkdir(exist_ok=True)
        shutil.copy2(base / "desktop.png", ROOT / "dist/test-desktop.png")
    if (base / "desktop-maximized.png").exists():
        (ROOT / "dist").mkdir(exist_ok=True)
        shutil.copy2(base / "desktop-maximized.png", ROOT / "dist/test-maximized.png")
    if (base / "desktop-maximized-dark.png").exists():
        (ROOT / "dist").mkdir(exist_ok=True)
        shutil.copy2(base / "desktop-maximized-dark.png", ROOT / "dist/test-maximized-dark.png")
    if (base / "desktop-new-tab.png").exists():
        shutil.copy2(base / "desktop-new-tab.png", ROOT / "dist/test-new-tab.png")
    if (base / "desktop-app-grid.png").exists():
        shutil.copy2(base / "desktop-app-grid.png", ROOT / "dist/test-app-grid.png")
    if (base / "desktop-settings.png").exists():
        shutil.copy2(base / "desktop-settings.png", ROOT / "dist/test-settings.png")
    result = json.loads(result_file.read_text()) if result_file.exists() else {
        "ok": False, "error": "No result from isolated compositor"}
    if SCREENSHOTS_ONLY and result["ok"]:
        destination = ROOT / "docs/images"
        destination.mkdir(parents=True, exist_ok=True)
        for name in DEMO_SCREENSHOTS:
            copy_clean_png(demo_output / name, destination / name)
    print(json.dumps(result, indent=2))
    if not result["ok"]:
        print((base / "shell.log").read_text()[-18000:])
        raise SystemExit(1)
