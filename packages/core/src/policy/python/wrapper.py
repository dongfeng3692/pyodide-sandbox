"""Trusted per-call execution wrapper for pyodide-sandbox.

Concatenated after policy.py, encode.py, hints.py and state.py by the
runtime; exposes two callables:

    SBX_WRAP(code, names_json) -> str (JSON payload)
    SBX_RESET() -> str (JSON {"restored": [...], "broken": str|None})

Contract per call:
  - fresh globals dict (zero persistence between calls)
  - builtins replaced per policy (safe list, or full in `raw`)
  - modules exposed per policy via a pre-built mapping (never via import)
  - files arrive as a read-only mapping name -> file object; every lookup
    returns a fresh BytesIO, so reading the same file twice works
  - result must be a dict (unless policy.resultMustBeDict is false)
  - numpy/pandas/datetime values are converted to JSON natively; unknown
    objects degrade to marked placeholders with a warnings[] channel
  - errors are structured {type, code?, line, symbol, message, hint,
    retryable} for model self-correction
  - after every call SBX_RESET restores shared library state (state.py)
"""

import io
import json
import os as _os
from collections.abc import Mapping as _Mapping

# NOTE: runs as one concatenated source, so engine symbols (load_policy,
# PolicyError, validate), encode(), policy_hint()/runtime_hint() and the
# state snapshot()/reset() helpers are already in this namespace.

try:
    _EXPOSED_MODULES  # noqa: F821 — injected by the runtime as a JS-built dict
except NameError:
    _EXPOSED_MODULES = {}
try:
    _POLICY_FLAGS  # noqa: F821 — injected by buildWrapperSource()
except NameError:
    _POLICY_FLAGS = {"builtinsMode": "safe", "resultMustBeDict": True}

_ENGINE_POLICY = load_policy()  # noqa: F821
_RESULT_MAX_BYTES = _POLICY_FLAGS.get("resultMaxBytes", 24576)


class MissingFile(KeyError):
    """files["x"] for a name that was not uploaded (reported as KeyError)."""


class ResultContractError(ValueError):
    """`result` is missing or not a dict (reported as ValueError)."""

    def __init__(self, hint):
        super().__init__("result_must_be_dict")
        self.hint = hint


class Files(_Mapping):
    """Uploaded files: name -> fresh BytesIO on every access.

    pandas readers consume the stream; handing out a new one per lookup
    means `pd.read_csv(files["a.csv"])` works any number of times.
    """

    def __init__(self, blobs):
        self._blobs = blobs

    def __getitem__(self, name):
        try:
            return io.BytesIO(self._blobs[name])
        except KeyError:
            raise MissingFile(name) from None

    def __iter__(self):
        return iter(self._blobs)

    def __len__(self):
        return len(self._blobs)

    def __repr__(self):
        return f"files({sorted(self._blobs)})"


def _user_line(exc):
    tb = exc.__traceback__
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "<sbx>":
            return tb.tb_lineno
        tb = tb.tb_next
    return None


def _warm_import(name, globals=None, locals=None, fromlist=(), level=0):
    """Caged import: hand out ONLY modules that are already in sys.modules.

    Library internals use deferred imports (e.g. numpy's _methods does
    `import numpy as np` at call time) which need an `__import__` builtin.
    This one can never load anything new — modules absent from sys.modules
    are refused, and the bridge modules (js/pyodide/micropip) were deleted
    from sys.modules at harden time, so they stay unreachable through it.
    """
    import sys

    if level and isinstance(globals, dict):
        # resolve a relative import against the caller's package
        pkg = globals.get("__package__")
        if not pkg:
            pkg = str(globals.get("__name__") or "").rsplit(".", 1)[0]
        for _ in range(level - 1):
            pkg = pkg.rsplit(".", 1)[0] if "." in pkg else ""
        name = f"{pkg}.{name}".strip(".") if name else pkg
    if not name:
        raise ImportError("sandbox imports are limited to preloaded modules")
    if fromlist:
        mod = sys.modules.get(name)
    else:
        mod = sys.modules.get(name.split(".", 1)[0])
    if mod is None:
        raise ImportError(
            f"no module named {name!r}: sandbox imports are limited to preloaded modules"
        )
    return mod


def _build_env(files):
    import builtins as _b

    if _POLICY_FLAGS.get("builtinsMode") == "full":
        env_builtins = dict(_b.__dict__)
    else:
        names = list(_POLICY_FLAGS.get("safeBuiltins", [])) + list(_POLICY_FLAGS.get("builtinsExtra", []))
        env_builtins = {n: getattr(_b, n) for n in names if hasattr(_b, n)}
        env_builtins["__import__"] = _warm_import
    # `__name__` is metadata the class machinery reads from the calling frame;
    # without it every `class` statement dies with NameError.
    env = {"__builtins__": env_builtins, "files": files, "__name__": "sbx"}
    for alias, mod in _EXPOSED_MODULES.items():
        env[alias] = mod
    return env


def _hint_context(file_names):
    return {
        "modules": {alias: getattr(mod, "__name__", alias) for alias, mod in _EXPOSED_MODULES.items()},
        "files": file_names,
        "max_code_bytes": _ENGINE_POLICY["maxCodeBytes"],
        "result_max_bytes": _RESULT_MAX_BYTES,
    }


def _check_result(env):
    if not _POLICY_FLAGS.get("resultMustBeDict", True):
        return env.get("result")  # raw: anything (including a missing result → null)
    if "result" not in env:
        raise ResultContractError(
            "assign the answer to a top-level variable named `result`, e.g. result = {\"answer\": value}"
        )
    result = env["result"]
    if not isinstance(result, dict):
        raise ResultContractError(
            f"`result` must be a dict but is {type(result).__name__}; wrap it, e.g. result = {{\"value\": ...}}"
        )
    return result


def _error_payload(exc, warnings, file_names):
    ctx = _hint_context(file_names)
    if isinstance(exc, PolicyError):  # noqa: F821
        error = {"type": "PolicyError", "code": exc.code, "symbol": exc.name,
                 "line": exc.lineno, "message": str(exc), "retryable": True}
        hint = policy_hint(exc, ctx)  # noqa: F821
    else:
        kind = type(exc)
        type_name = ("KeyError" if kind is MissingFile
                     else "ValueError" if kind in (ResultContractError, ResultTooLarge)  # noqa: F821
                     else kind.__name__)
        error = {"type": type_name,
                 "line": getattr(exc, "lineno", None) or _user_line(exc),
                 "symbol": getattr(exc, "name", None),
                 "message": str(exc)[:600], "retryable": True}
        if isinstance(exc, ResultContractError):
            error["code"] = "result_must_be_dict"
        elif isinstance(exc, ResultTooLarge):  # noqa: F821 - defined in encode.py
            # code aligns with result_must_be_dict so size failures are
            # distinguishable from generic ValueErrors in the logs/metrics
            error["code"] = "result_too_large"
        try:
            hint = runtime_hint(exc, ctx)  # noqa: F821
        except Exception:  # noqa: BLE001 - a hint must never mask the real error
            hint = None
    if hint:
        error["hint"] = hint
    return {"ok": False, "warnings": warnings, "error": error}


def SBX_WRAP(code, names_json):
    warnings = []
    file_names = []
    try:
        validate(code, _ENGINE_POLICY)  # noqa: F821
        blobs = {}
        for name in json.loads(names_json):
            with open("/scratch/" + name, "rb") as fh:
                blobs[name] = fh.read()
        file_names = sorted(blobs)
        env = _build_env(Files(blobs))
        exec(compile(code, "<sbx>", "exec"), env)  # noqa: S102 - the whole point
        encoded = encode(_check_result(env), warnings)  # noqa: F821
        size = len(json.dumps(encoded, ensure_ascii=False).encode("utf-8"))
        if size > _RESULT_MAX_BYTES:
            raise ResultTooLarge(f"{size} bytes")  # noqa: F821
        return json.dumps({"ok": True, "result": encoded, "warnings": warnings})
    except BaseException as exc:  # noqa: BLE001 - surface everything to the caller
        return json.dumps(_error_payload(exc, warnings, file_names))
    finally:
        # A trailing partial line (print(..., end="")) must be attributed to
        # THIS call. Pyodide's batched stdout handler only fires on complete
        # lines: the flush has to happen in TWO layers — sys.stdout.flush()
        # moves the TextIO buffer into the FS StringWriter, then os.fsync()
        # makes StringWriter.fsync() hand the remainder to the callback.
        # Without this the partial line sits until some LATER call prints a
        # newline — leaking into that call's stdout (cross-call channel,
        # breaks the zero-persistence invariant).
        try:
            _sys.stdout.flush()  # noqa: F821 - imported by state.py in this namespace
            _os.fsync(_sys.stdout.fileno())  # noqa: F821 - os imported below
        except Exception:  # noqa: BLE001 - capture must never fail a call
            pass


_STATE_BASELINE = snapshot()  # noqa: F821 - after harden/preimport/exposeModules


def SBX_RESET():
    return json.dumps(reset(_STATE_BASELINE))  # noqa: F821
