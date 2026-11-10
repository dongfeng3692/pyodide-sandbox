"""Actionable error hints for pyodide-sandbox (trusted, concatenated before wrapper.py).

Every structured error may carry a ``hint``: one sentence telling the model
what to change. Without it a model sees ``forbidden_name: print`` or
``NameError: divmod`` and guesses — usually by resending near-identical code.

Hints never echo user data beyond the offending symbol/identifier.
"""

import builtins as _builtins

# Stdlib modules models reach for, and the pre-bound equivalent to suggest.
_MODULE_ALTERNATIVES = {
    "math": "use numpy instead (np.sqrt, np.log, np.pi, np.floor, ...)",
    "statistics": "use pandas/numpy instead (s.mean(), s.median(), s.std(), np.percentile)",
    "datetime": "use pandas instead (pd.Timestamp, pd.to_datetime, pd.Timedelta)",
    "time": "use pandas instead (pd.Timestamp.now())",
    "json": "return data through the `result` dict; it is serialized to JSON for you",
    "re": "use pandas string methods instead (s.str.contains/extract/replace with regex=True)",
    "collections": "use dict/list, or pandas (s.value_counts(), df.groupby(...))",
    "itertools": "use comprehensions, zip/enumerate, or pandas",
    "random": "use numpy instead (np.random.default_rng(seed))",
    "csv": "use pd.read_csv(files[\"name.csv\"])",
    "io": "uploaded files are already file objects: pd.read_csv(files[\"name.csv\"])",
    "os": "there is no filesystem or OS access; read uploads via the `files` dict",
    "sys": "there is no interpreter access in this sandbox",
}

_BANNED_NAME_HINTS = {
    "print": "print() is disabled in this preset; put the values you want to see into the `result` dict",
    "type": "use isinstance(x, SomeType) instead of type(x)",
    "repr": "use str(x) or an f-string instead of repr(x)",
    "format": "use an f-string (f\"{x:.2f}\") or str.format instead of format()",
    "getattr": "access attributes directly (obj.name); string-based attribute access is disabled",
    "setattr": "attribute assignment is disabled; build a new object instead",
    "delattr": "attribute deletion is disabled",
    "hasattr": "use `'col' in df.columns` or try/except AttributeError",
    "open": "there is no filesystem; uploaded files are in the `files` dict: pd.read_csv(files[\"name.csv\"])",
    "iter": "use a for-loop or list(...) instead of iter()",
    "next": "use a for-loop, list(...)[0], or s.iloc[0] instead of next()",
    "eval": "dynamic code execution is disabled; write the expression directly",
    "exec": "dynamic code execution is disabled; write the code directly",
    "compile": "dynamic code execution is disabled; write the code directly",
    "globals": "introspection is disabled; reference variables directly",
    "locals": "introspection is disabled; reference variables directly",
    "vars": "introspection is disabled; reference attributes directly",
    "dir": "dir() is not available; inspect a DataFrame with list(df.columns), or probe a name with try/except NameError",
    "input": "there is no interactive input; data must come from `files` or the code itself",
    "object": "use dict/list or a plain class (if the preset allows `class`)",
    "super": "inheritance helpers are disabled; use plain functions or dicts",
}

_SYNTAX_NAMES = {
    "functiondef": "`def`", "asyncfunctiondef": "`async def`", "classdef": "`class`",
    "lambda": "`lambda`", "global": "`global`", "nonlocal": "`nonlocal`",
}


def _module_list(ctx):
    mods = ctx.get("modules") or {}
    if not mods:
        return "no modules are pre-bound in this preset"
    return "pre-bound globals: " + ", ".join(f"{a} ({m})" for a, m in mods.items())


def _files_list(ctx):
    names = ctx.get("files") or []
    return ", ".join(repr(n) for n in names) if names else "none (no files were sent with this call)"


def _import_hint(ctx, module=None):
    alt = _MODULE_ALTERNATIVES.get((module or "").split(".")[0])
    base = f"import statements are disabled; {_module_list(ctx)} — use them directly without importing"
    return f"{base}. For {module}: {alt}" if alt else base


def policy_hint(exc, ctx):
    code, symbol = exc.code, exc.name
    if code == "forbidden_syntax":
        if symbol in ("import", "importfrom"):
            return _import_hint(ctx, getattr(exc, "detail", None))
        what = _SYNTAX_NAMES.get(symbol, f"`{symbol}`")
        return f"{what} is not allowed in this preset; inline the logic as top-level statements/expressions"
    if code == "forbidden_name":
        if symbol and symbol.startswith("__"):
            # dunders are internals, not typos: "rename it" would be nonsense advice
            if symbol == "__import__":
                return _import_hint(ctx)
            return (f"`{symbol}` is an internal (dunder) name — dunder names are blocked in this sandbox; "
                    "there is no way to enable them, use the public API instead")
        if symbol and symbol.startswith("_") and symbol != "_":
            return f"identifiers starting with '_' are not allowed; rename `{symbol}` (e.g. `{symbol.lstrip('_') or 'tmp'}`)"
        return _BANNED_NAME_HINTS.get(symbol, f"`{symbol}` is disabled in this sandbox; find another way to express it")
    if code == "forbidden_attribute":
        return f"attributes starting with '_' (like `.{symbol}`) are not accessible; use the public API"
    if code == "forbidden_store":
        if symbol in ("columns", "index"):
            axis = 1 if symbol == "columns" else 0
            return (f"assigning to `.{symbol}` is not allowed; use df = df.set_axis([...], axis={axis}) "
                    "or df = df.rename(columns={...}). Plain variable assignment (x = ...) is fine")
        return (f"assigning to an attribute (`obj.{symbol} = ...`) is not allowed; build a new value instead "
                "(df = df.assign(col=...), df[\"col\"] = ... and x = ... are fine; "
                "`self.x = ...` inside a `class` method IS allowed)")
    if code == "syntax_error":
        detail = getattr(exc, "detail", None)
        return f"fix the syntax error: {detail}" if detail else "fix the syntax error at the reported line"
    if code == "code_too_large":
        return (f"code is limited to {ctx.get('max_code_bytes')} bytes; do not inline data in the code — "
                "send it as a file instead")
    if code == "invalid_code_size":
        return "send non-empty Python source"
    return None


def runtime_hint(exc, ctx):
    name = type(exc).__name__
    if isinstance(exc, ResultTooLarge):  # noqa: F821 - defined in encode.py
        return (f"the result is too large ({exc.detail}; limit {ctx.get('result_max_bytes')} bytes of JSON) — "
                "aggregate, select the relevant columns, or return df.head(n)")
    if isinstance(exc, ResultContractError):  # noqa: F821 - defined in wrapper.py
        return exc.hint
    if isinstance(exc, MissingFile):  # noqa: F821 - defined in wrapper.py
        return f"no uploaded file named {exc.args[0]!r}; available files: {_files_list(ctx)}"
    # Network is deterministically disabled, but the transport errors it
    # surfaces ("Remote end closed connection...", "TLS not supported...")
    # read like transient failures — a model would burn turns retrying other
    # URLs. Say the actual rule instead.
    _msg = str(exc).lower()
    if (name in ("urlerror", "remotedisconnected", "sslerror", "protocolerror", "httpexception")
            or "tls not supported" in _msg or "remote end closed" in _msg):
        return ("network access is disabled in this sandbox — data must come in through the `files` dict; "
                "fetching any URL fails the same way, so do not retry with other URLs")
    if name == "NameError":
        missing = getattr(exc, "name", None) or ""
        if missing in _MODULE_ALTERNATIVES:
            return f"module `{missing}` is not available; {_MODULE_ALTERNATIVES[missing]}"
        if hasattr(_builtins, missing):
            return _BANNED_NAME_HINTS.get(missing, f"builtin `{missing}` is not available in this sandbox")
        return ("the name is not defined — every call starts with fresh globals (nothing survives from "
                f"earlier calls); {_module_list(ctx)}")
    if name in ("FileNotFoundError", "PermissionError", "IsADirectoryError"):
        return f"there are no filesystem paths; read uploads via the `files` dict: pd.read_csv(files[\"name\"]). Files: {_files_list(ctx)}"
    if name == "EmptyDataError":
        return "the file content is empty — check that the right file was sent with THIS call (files are not kept between calls)"
    if name == "ImportError":
        return _import_hint(ctx)
    if name == "KeyError" and isinstance(exc.args[0] if exc.args else None, str):
        return ("key not found — names are case-sensitive; inspect what exists first, "
                "e.g. result = {\"columns\": list(df.columns)}")
    return None
