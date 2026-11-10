"""Trusted hardening bootstrap for the Pyodide runtime.

Runs AFTER package/wheel installation (which needs micropip) and BEFORE any
model code. Pyodide itself says it is "not a sandbox" — the ``js`` module has
host-process-equivalent privileges in Node. This module answers for that.

Three steps, in order:

1. Remove the JS bridge modules from ``sys.modules`` so cached imports can't
   hand them back.
2. **Remove pyodide's import finder (``JsFinder``) from ``sys.meta_path``.**
   This is the load-bearing step: without a finder, ``import js`` raises
   ModuleNotFoundError even if hostile code removes our deny finder — the
   classic escape (``pd.compat.sys.meta_path.pop(0)`` +
   ``importlib.import_module("js")``) dies here.
3. Prepend a deny finder for denied names, then **freeze ``sys.meta_path`` as
   a tuple**: hostile code can't pop/splice a tuple in place, and a wholesale
   reassignment is an attribute STORE — banned by policy in every preset
   except ``raw`` (trusted code only).

The wall therefore no longer depends on being the first entry of a mutable
list; it depends on the bridge finder simply not existing.
"""

import sys

_DENIED_PREFIXES = ("pyodide", "_pyodide", "micropip")
_DENIED_EXACT = {"js"}


def _is_denied(name):
    root = name.split(".", 1)[0]
    return (
        name in _DENIED_EXACT
        or root in _DENIED_EXACT
        or name.startswith(_DENIED_PREFIXES)
        or root.startswith(_DENIED_PREFIXES)
    )


def _is_bridge_finder(finder):
    kind = type(finder)
    return (
        kind.__name__ == "JsFinder"
        or kind.__name__ == "_DenyFinder"  # idempotent re-harden
        or (kind.__module__ or "").startswith(("_pyodide", "pyodide"))
    )


class _DenyFinder:
    def find_spec(self, name, path=None, target=None):
        if _is_denied(name):
            raise ImportError(f"blocked module: {name}")
        return None


def harden(deny_modules=()):
    for name in deny_modules:
        _DENIED_EXACT.add(name)

    for name in [m for m in list(sys.modules) if _is_denied(m)]:
        del sys.modules[name]

    sys.meta_path = [f for f in sys.meta_path if not _is_bridge_finder(f)]
    sys.meta_path.insert(0, _DenyFinder())
    sys.meta_path = tuple(sys.meta_path)  # immutable to pop/insert/splice
    return f"bridge removed; denied: {sorted(_DENIED_EXACT)}"
