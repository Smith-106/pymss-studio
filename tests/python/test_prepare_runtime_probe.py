import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch


class PrepareRuntimeProbeTests(unittest.TestCase):
    def test_windows_backend_extras_omit_missing_and_blank_requirements(self):
        powershell = shutil.which("powershell.exe") or shutil.which("pwsh")
        if powershell is None:
            self.skipTest("PowerShell is required for Windows runtime preparation tests")
        script = (Path(__file__).resolve().parents[2] / "scripts/prepare-python-runtime.ps1").read_text(encoding="utf-8")
        helper = re.search(r"^function Get-ManifestBackendExtras \{\r?\n.*?^\}", script, re.M | re.S)
        self.assertIsNotNone(helper)
        invocation = helper.group(0) + '''
$ErrorActionPreference = "Stop"
$runtimeManifest = '{"backends":{"rocm":{},"cpu":{"extras":[]},"cuda":{"extras":[null,"","  ","onnxruntime>=1"]}}}' | ConvertFrom-Json
$result = @{}
foreach ($backend in @("rocm", "cpu", "cuda", "unknown")) {
    $result[$backend] = @(Get-ManifestBackendExtras $backend)
}
$result | ConvertTo-Json -Compress
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "probe.ps1"
            path.write_text(invocation, encoding="utf-8-sig")
            result = subprocess.run([powershell, "-NoProfile", "-File", str(path)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), {"rocm": [], "cpu": [], "cuda": ["onnxruntime>=1"], "unknown": []})

    def test_probe_template_executes_after_production_replacement(self):
        script = (Path(__file__).resolve().parents[2] / "scripts/prepare-python-runtime.ps1").read_text(
            encoding="utf-8",
        )
        match = re.search(
            r"\$probeScript = @'\r?\n(.*?)\r?\n'@"
            r"\.Replace\('%NAMES%', \$manifestPackageJson\)"
            r"\.Replace\('%MAPPING%', \$manifestMappingJson\)",
            script,
            re.S,
        )
        self.assertIsNotNone(match, "exercise the production PowerShell heredoc and replacement chain")
        template = match.group(1)
        self.assertIn("names = %NAMES%", template)
        self.assertIn("mapping = %MAPPING%", template)
        self.assertNotIn("json.loads(%NAMES%)", template)
        self.assertNotIn("json.loads(%MAPPING%)", template)
        rendered = template.replace("%NAMES%", '["av", "pymss-core"]').replace(
            "%MAPPING%", '{"pymss-core":"pymss_core"}',
        )
        fake_torch = types.SimpleNamespace(
            __version__="test",
            version=types.SimpleNamespace(hip=None, cuda=None),
            cuda=types.SimpleNamespace(is_available=lambda: False),
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.dict("sys.modules", {"torch": fake_torch}):
            exec(compile(rendered, "rendered-runtime-probe.py", "exec"), {})
        result = json.loads(output.getvalue())
        self.assertEqual(result["torchBackend"], "cpu")
        self.assertIn("pymss-core", result["packages"])

    def test_shell_runtime_python_sets_home_only_for_standalone_macos_python(self):
        bash = shutil.which("bash")
        if bash is None:
            self.skipTest("Bash is required for runtime preparation tests")
        script = (Path(__file__).resolve().parents[2] / "scripts/prepare-python-runtime.sh").read_text(encoding="utf-8")
        helper = re.search(r"^runtime_python\(\) \{\n.*?^\}", script, re.M | re.S)
        self.assertIsNotNone(helper)
        with tempfile.TemporaryDirectory(prefix="pymss-runtime-home-") as directory:
            interpreter = Path(directory) / "python stub.sh"
            interpreter.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "${PYTHONHOME-unset}" "${PYTHONDONTWRITEBYTECODE-unset}" "$@"\n', encoding="utf-8")
            interpreter.chmod(0o755)
            for platform, expected_home in [("linux-gnu", "unset"), ("darwin23", "/standalone runtime")]:
                with self.subTest(platform=platform):
                    invocation = helper.group(0) + '\nPYTHONDONTWRITEBYTECODE=1 runtime_python "argument with spaces"\n'
                    result = subprocess.run(
                        [bash, "-c", invocation], capture_output=True, text=True, check=True,
                        env={**os.environ, "OSTYPE": platform, "RUNTIME_HOME": "/standalone runtime", "PY": interpreter.as_posix(), "PYTHONHOME": "/inherited home"},
                    )
                    self.assertEqual(result.stdout.splitlines(), [expected_home, "1", "argument with spaces"])


if __name__ == "__main__":
    unittest.main()
