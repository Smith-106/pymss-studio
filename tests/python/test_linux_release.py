from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("linux_update_metadata", ROOT / "scripts/generate-update-metadata.py")
METADATA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(METADATA)


class LinuxReleaseTests(unittest.TestCase):
    def test_signed_appimage_advertises_manual_install_even_when_auto_updates_requested(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = Path(temporary)
            asset = "Pymss-Studio-1.2.3-linux-x64.AppImage"
            (artifacts / asset).write_bytes(b"AppImage")
            (artifacts / f"{asset}.sig").write_text("release-signature", encoding="utf-8")
            generated = METADATA.generate(artifacts, {
                "RELEASE_TAG": "v1.2.3", "RELEASE_AUTO_UPDATE_SUPPORTED": "true",
                "RELEASE_MACOS_AUTO_UPDATE_SUPPORTED": "true",
            })
            self.assertEqual(set(generated), {
                "stable-v1-linux-x64-update.json", "prerelease-v1-linux-x64-update.json",
            })
            data = json.loads((artifacts / generated[0]).read_text(encoding="utf-8"))
            self.assertFalse(data["pymss_update_supported"])
            self.assertTrue(data["pymss_requires_manual_install"])
            self.assertEqual(set(data["platforms"]), {"linux-x86_64"})
            self.assertTrue(data["platforms"]["linux-x86_64"]["url"].endswith('/' + asset))
            self.assertEqual(data["pymss_manual_install_url"], "https://github.com/pymss-project/pymss-studio/releases/tag/v1.2.3")

    def test_linux_prerelease_does_not_overwrite_stable_channel(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = Path(temporary)
            asset = "Pymss-Studio-1.2.3-rc.1-linux-x64.AppImage"
            (artifacts / asset).touch()
            (artifacts / f"{asset}.sig").write_text("release-signature", encoding="utf-8")
            self.assertEqual(METADATA.generate(artifacts, {
                "RELEASE_TAG": "v1.2.3-rc.1", "RELEASE_PRERELEASE": "true",
            }), ["prerelease-v1-linux-x64-update.json"])

    def test_linux_channel_rejects_a_missing_signature(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = Path(temporary)
            (artifacts / "Pymss-Studio-1.2.3-linux-x64.AppImage").touch()
            with self.assertRaises(FileNotFoundError):
                METADATA.generate(artifacts, {"RELEASE_TAG": "v1.2.3"})
