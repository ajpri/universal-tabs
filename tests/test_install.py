"""Regressions for keeping a running installation separate from edited source."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import subprocess

SPEC = importlib.util.spec_from_file_location("extensionctl", Path(__file__).resolve().parents[1] / "extensionctl.py")
CTL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CTL)


class InstallationIsolation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "source"
        self.source.mkdir()
        self.installed = Path(self.temp.name) / "installed"
        self.original_root = CTL.ROOT
        self.addCleanup(setattr, CTL, "ROOT", self.original_root)
        CTL.ROOT = self.source
        for name in (*CTL.FILES, "extension.js", "metadata.json"):
            (self.source / name).write_text("{}" if name.endswith(".json") else f"// {name}\n")

    def test_edits_do_not_change_install_until_publish(self):
        first = CTL.stage(self.installed)
        manifest = (self.installed / "runtime.json").read_bytes()
        original = self.installed / "revisions" / first / "runtime.js"
        original_bytes = original.read_bytes()
        original_inode = original.stat().st_ino
        CTL.stage(self.installed)
        self.assertEqual(original.stat().st_ino, original_inode)
        (self.source / "runtime.js").write_text("// changed source\n")
        self.assertEqual((self.installed / "runtime.json").read_bytes(), manifest)
        self.assertEqual(original.read_bytes(), original_bytes)
        second = CTL.stage(self.installed)
        self.assertNotEqual(first, second)
        self.assertEqual(original.read_bytes(), original_bytes)
        self.assertEqual(original.stat().st_ino, original_inode)
        self.assertEqual(json.loads((self.installed / "runtime.json").read_text())["revision"], second)

    def test_normal_update_removes_development_link(self):
        CTL.stage(self.installed, development=True)
        self.assertIn("sourceDirectory", json.loads((self.installed / "runtime.json").read_text()))
        CTL.stage(self.installed)
        self.assertNotIn("sourceDirectory", json.loads((self.installed / "runtime.json").read_text()))

    def test_tampered_revision_is_not_overwritten(self):
        revision = CTL.stage(self.installed)
        file = self.installed / "revisions" / revision / "runtime.js"
        file.write_text("// locally modified installed file\n")
        with self.assertRaisesRegex(SystemExit, "refusing to overwrite"):
            CTL.stage(self.installed)
        self.assertEqual(file.read_text(), "// locally modified installed file\n")


class InstallationIdentity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.extensions = self.data / 'gnome-shell/extensions'
        self.environment = patch.dict(CTL.os.environ, {'UNIVERSAL_TABS_INSTALL_DIR': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def existing(self, name='existing-tabs@extensions.example'):
        directory = self.extensions / name
        CTL.stage(directory, extension_uuid=name)
        return directory

    def test_existing_install_keeps_identity_and_recovery_data(self):
        directory = self.existing()
        recovery = directory / 'window-controls-backup.json'
        recovery.write_text('{"saved": "layout"}')
        found = CTL.find_install(self.data)
        self.assertEqual(found, directory)
        CTL.stage(found, extension_uuid=found.name)
        self.assertEqual(json.loads((found / 'metadata.json').read_text())['uuid'], directory.name)
        self.assertEqual(recovery.read_text(), '{"saved": "layout"}')

    def test_new_packages_keep_the_project_identity(self):
        self.existing()
        packaged = self.data / 'packaged'
        CTL.stage(packaged)
        self.assertEqual(json.loads((packaged / 'metadata.json').read_text())['uuid'], CTL.UUID)

    def test_canonical_install_takes_priority(self):
        self.existing()
        canonical = self.existing(CTL.UUID)
        self.assertEqual(CTL.find_install(self.data), canonical)

    def test_unrelated_bootstrap_is_not_reused(self):
        directory = self.existing()
        (directory / 'extension.js').write_text('// different extension\n')
        self.assertEqual(CTL.find_install(self.data), self.extensions / CTL.UUID)

    def test_ambiguous_installs_need_explicit_selection(self):
        self.existing()
        chosen = self.existing('another-tabs@extensions.example')
        with self.assertRaisesRegex(SystemExit, 'Multiple compatible installations'):
            CTL.find_install(self.data)
        with patch.dict(CTL.os.environ, {'UNIVERSAL_TABS_INSTALL_DIR': str(chosen)}):
            self.assertEqual(CTL.find_install(self.data), chosen)


class WindowControlRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.install = Path(self.temp.name)
        self.backup = self.install / 'window-controls-backup.json'

    def save(self, previous):
        self.backup.write_text(json.dumps({'version': 1, 'previousUser': previous, 'applied': ':appmenu'}))

    @patch('builtins.print')
    def test_default_recovery_uses_detected_installation(self, _print):
        with patch.object(CTL, 'find_install', return_value=self.install) as find:
            CTL.restore_controls()
        find.assert_called_once_with()

    @patch('builtins.print')
    def test_restores_custom_layout_without_shell_interpolation(self, _print):
        self.save('close,minimize:appmenu')
        with patch.object(CTL.subprocess, 'run', return_value=SimpleNamespace(stdout="':appmenu'\n")) as run:
            CTL.restore_controls(self.install)
        self.assertEqual(run.call_args_list[-1].args[0],
            ['gsettings', 'set', 'org.gnome.desktop.wm.preferences', 'button-layout', "'close,minimize:appmenu'"])
        self.assertFalse(self.backup.exists())

    @patch('builtins.print')
    def test_restores_unset_preference_with_reset(self, _print):
        self.save(None)
        with patch.object(CTL.subprocess, 'run', return_value=SimpleNamespace(stdout="':appmenu'\n")) as run:
            CTL.restore_controls(self.install)
        self.assertEqual(run.call_args_list[-1].args[0],
            ['gsettings', 'reset', 'org.gnome.desktop.wm.preferences', 'button-layout'])

    @patch('builtins.print')
    def test_preserves_a_newer_layout(self, _print):
        self.save('close,minimize:appmenu')
        with patch.object(CTL.subprocess, 'run', return_value=SimpleNamespace(stdout="'maximize:close'\n")) as run:
            CTL.restore_controls(self.install)
        self.assertEqual(run.call_count, 1)
        self.assertFalse(self.backup.exists())

    def test_keeps_backup_when_restore_fails(self):
        self.save('close,minimize:appmenu')
        with patch.object(CTL.subprocess, 'run', side_effect=[SimpleNamespace(stdout="':appmenu'\n"),
                subprocess.CalledProcessError(1, ['gsettings'])]):
            with self.assertRaises(subprocess.CalledProcessError):
                CTL.restore_controls(self.install)
        self.assertTrue(self.backup.exists())

    def test_rejects_invalid_recovery_data_without_changing_settings(self):
        self.backup.write_text(json.dumps({'version': 1, 'applied': ':appmenu', 'previousUser': 42}))
        with patch.object(CTL.subprocess, 'run') as run:
            with self.assertRaises(SystemExit):
                CTL.restore_controls(self.install)
        run.assert_not_called()
        self.assertTrue(self.backup.exists())


if __name__ == "__main__":
    unittest.main()
