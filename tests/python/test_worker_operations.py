"""Round 5: worker_operations commands (list/describe/run) against the real
pymss runtime, using the same stdout-capture pattern as test_worker_tools.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

import worker_operations

def _loudnorm_fixture(root: Path) -> Path:
    """Self-contained audio operation for worker I/O and parameter transport."""
    fixture = root / "source" / "loudnorm"
    fixture.mkdir(parents=True)
    (fixture / "pyproject.toml").write_text(
        '[project]\n'
        'name="pymss-plugin-loudnorm"\n'
        'version="0.2.0"\n'
        'requires-python=">=3.10"\n'
        'dependencies=[]\n\n'
        '[project.entry-points."pymss.plugins"]\n'
        'loudnorm="loudnorm"\n\n'
        '[tool.pymss.plugin]\n'
        'id="pymss.loudnorm"\n'
        'api_version=1\n'
    )
    (fixture / "__init__.py").write_text(
        'import numpy as np\n\n'
        'def _peak_normalize(audio_in, params):\n'
        '    from pymss.graph.core import audio_to_numpy, numpy_to_audio\n'
        '    waveform, sr = audio_to_numpy(audio_in)\n'
        '    target = float(params.get("target_lufs", -14.0))\n'
        '    # A deterministic peak target isolates the worker transport.\n'
        '    peak = float(np.max(np.abs(waveform))) or 1.0\n'
        '    scale = (10 ** (target / 20.0)) / max(peak, 1e-9)\n'
        '    out = np.asarray(waveform * scale, dtype=np.float32)\n'
        '    return {"audio": numpy_to_audio(out, sr)}\n'
        '\n'
        'def setup(plugin):\n'
        '    plugin.register_operation(\n'
        '        id="pymss.loudnorm.normalize", title="Normalize Loudness (LUFS)",\n'
        '        description="LUFS loudness normalization",\n'
        '        inputs={"audio": {"type": "audio"}},\n'
        '        params={"type": "object", "properties": {\n'
        '            "target_lufs": {"type": "number", "default": -14.0, "minimum": -70.0, "maximum": -5.0},\n'
        '        }, "additionalProperties": False},\n'
        '        outputs={"audio": {"type": "audio"}},\n'
        '        run=lambda ctx, inputs, params: _peak_normalize(inputs["audio"], params),\n'
        '    )\n'
    )
    return fixture


_LOUDNORM_SRC = None  # resolved lazily via _loudnorm_fixture()


def _read_event(output: io.StringIO) -> dict:
    return json.loads(output.getvalue())


class ListOperationsTests(unittest.TestCase):
    def test_lists_operations_from_installed_plugin(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            plugins = Path(d) / "plugins"
            plugins.mkdir()
            shutil.copytree(_loudnorm_fixture(Path(d)), plugins / "loudnorm")
            old = os.environ.get("PYMSS_PLUGINS_DIR")
            os.environ["PYMSS_PLUGINS_DIR"] = str(plugins)
            try:
                # Fresh runtime per call: reset module-level default runtime
                import pymss.operations as ops
                ops._DEFAULT_RUNTIME = None
                import pymss.plugins as plugs
                plugs.reset()

                output = io.StringIO()
                with redirect_stdout(output):
                    code = worker_operations.cmd_list_operations({})
                event = _read_event(output)
            finally:
                if old is None:
                    os.environ.pop("PYMSS_PLUGINS_DIR", None)
                else:
                    os.environ["PYMSS_PLUGINS_DIR"] = old
                import pymss.operations as ops
                ops._DEFAULT_RUNTIME = None
                import pymss.plugins as plugs
                plugs.reset()
        self.assertEqual(code, 0)
        self.assertTrue(event["payload"]["pymssOperationsAvailable"])
        ids = [op["id"] for op in event["payload"]["operations"]]
        self.assertIn("pymss.loudnorm.normalize", ids)

    def test_reports_unavailable_when_pymss_missing(self) -> None:
        output = io.StringIO()
        with (
            mock.patch.dict("sys.modules", {"pymss": None, "pymss.plugins": None}),
            redirect_stdout(output),
        ):
            code = worker_operations.cmd_list_operations({})
        event = _read_event(output)
        self.assertEqual(code, 0)
        self.assertFalse(event["payload"]["pymssOperationsAvailable"])


class RunOperationTests(unittest.TestCase):
    def _install_plugin(self, d: Path) -> None:
        plugins = d / "plugins"
        plugins.mkdir()
        shutil.copytree(_loudnorm_fixture(d), plugins / "loudnorm")
        os.environ["PYMSS_PLUGINS_DIR"] = str(plugins)

    def _reset_runtime(self) -> None:
        import pymss.operations as ops
        import pymss.plugins as plugs

        ops._DEFAULT_RUNTIME = None
        plugs.reset()

    def test_run_operation_normalizes_file_input(self) -> None:
        import numpy as np
        import soundfile as sf

        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            self._install_plugin(work)
            self._reset_runtime()
            try:
                sr = 44100
                t = np.arange(sr * 2, dtype=np.float32) / sr
                tone = (0.3 * np.stack([np.sin(2 * np.pi * 440 * t)] * 2)).astype(np.float32)
                wav = work / "tone.wav"
                sf.write(str(wav), tone.T, sr)

                out_dir = work / "configured-output"
                output = io.StringIO()
                with (
                    mock.patch.dict(os.environ, {"PYMSS_STUDIO_DEFAULT_OUTPUT_DIR": str(out_dir)}),
                    redirect_stdout(output),
                ):
                    code = worker_operations.cmd_run_operation({
                        "operation": "pymss.loudnorm.normalize",
                        "inputs": {"audio": {"kind": "file", "path": str(wav)}},
                        "params": {"target_lufs": -18.0},
                        "requestId": "req-1",
                    })
                events = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
                self.assertEqual(code, 0, events)
                result_event = next(e for e in events if e["type"] == "operation_result")
                audio_out = result_event["payload"]["outputs"]["audio"]
                self.assertEqual(audio_out["kind"], "audio_file")
                self.assertEqual(Path(audio_out["path"]).parent, out_dir)

                data, srr = sf.read(audio_out["path"], dtype="float32")
                self.assertEqual(srr, sr)
                self.assertEqual(data.shape, (sr * 2, 2))
                self.assertTrue(np.isfinite(data).all())
                self.assertAlmostEqual(float(abs(data).max()), 10 ** (-18.0 / 20.0), places=4)
            finally:
                self._reset_runtime()
                os.environ.pop("PYMSS_PLUGINS_DIR", None)

    def test_run_operation_missing_input_fails_with_code(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            self._install_plugin(work)
            self._reset_runtime()
            try:
                output = io.StringIO()
                with redirect_stdout(output):
                    code = worker_operations.cmd_run_operation({
                        "operation": "pymss.loudnorm.normalize",
                        "inputs": {},
                        "params": {},
                        "outputDir": str(work / "out"),
                    })
                event = _read_event(output)
                self.assertEqual(code, 1)
                self.assertEqual(event["payload"]["code"], "OPERATION_FAILED")
                self.assertIn("audio", event["payload"]["message"])
            finally:
                self._reset_runtime()
                os.environ.pop("PYMSS_PLUGINS_DIR", None)


if __name__ == "__main__":
    unittest.main()
