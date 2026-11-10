"""Per-call reset of process-global library state (trusted, concatenated before wrapper.py).

Fresh globals give each call a clean *namespace*, but the imported library
modules are shared by every call a warm worker serves. Ordinary API calls
change them for everyone after: ``pd.set_option(...)``, ``np.seterr(...)``,
``warnings.simplefilter("error")``, edits to the module registry. Without a
reset, one caller's code makes the NEXT caller's correct code fail in ways
it cannot explain or fix.

``snapshot()`` runs once after boot; ``reset()`` runs after every call:
it restores what it knows how to restore and then runs a canary. The worker
is recycled when the canary fails (``recycleAfter`` remains the backstop for
state nobody knows about).
"""

import copy as _copy
import sys as _sys
import warnings as _warnings


_MISSING = object()


def _restore_warnings(snap):
    """Rebuild the filter list through the public API (Python 3.14 guards the
    internal cache-invalidation hook with a lock), then re-baseline: the
    round trip can normalize entries (None → compiled empty pattern)."""
    if list(_warnings.filters) == snap["warnings"]:
        return False
    _warnings.resetwarnings()
    for action, message, category, module, lineno in snap["warnings"]:
        _warnings.filterwarnings(
            action, _pattern(message), category, _pattern(module), lineno, append=True,
        )
    snap["warnings"] = list(_warnings.filters)
    return True


def _pattern(value):
    """Filter fields are None, a str, or a compiled regex depending on version."""
    if value is None:
        return ""
    return getattr(value, "pattern", value)


def _pandas_config():
    cfg = _sys.modules.get("pandas._config.config")
    return getattr(cfg, "_global_config", None) if cfg is not None else None


_PANDAS_CORE_CLASSES = ("Series", "DataFrame", "Index")


def _accessor_cache_type():
    """pandas.core.accessor.CachedAccessor — the wrapper every
    register_*_accessor() installs as a class attribute."""
    mod = _sys.modules.get("pandas.core.accessor")
    return getattr(mod, "CachedAccessor", None) if mod is not None else None


def snapshot():
    snap = {
        "modules": dict(_sys.modules),
        "path": list(_sys.path),
        "recursion": _sys.getrecursionlimit(),
        "warnings": list(_warnings.filters),
    }
    np = _sys.modules.get("numpy")
    if np is not None:
        snap["np_err"] = np.geterr()
        snap["np_print"] = np.get_printoptions()
        # The legacy global MT19937 is a module-level singleton; without this,
        # one caller's np.random.seed(...) makes every later caller's draws
        # predictable (cross-call determinism injection).
        snap["np_random"] = np.random.get_state()
    pd_cfg = _pandas_config()
    if pd_cfg is not None:
        snap["pd_options"] = _copy.deepcopy(pd_cfg)
    if _accessor_cache_type() is not None:
        pd = _sys.modules["pandas"]
        snap["pd_class_dicts"] = {
            name: dict(getattr(pd, name).__dict__)  # shallow: name -> original attr ref
            for name in _PANDAS_CORE_CLASSES
            if isinstance(getattr(pd, name, None), type)
        }
    return snap


def _restore_tree(current, base):
    """Restore changed/removed keys of a nested option dict in place.
    Keys added after the snapshot (options registered by a lazily imported
    submodule) are legitimate and left alone."""
    changed = False
    for key, value in base.items():
        cur = current.get(key, _MISSING)
        if cur == value:
            continue
        if isinstance(value, dict) and isinstance(cur, dict):
            changed = _restore_tree(cur, value) or changed
        else:
            current[key] = _copy.deepcopy(value)
            changed = True
    return changed



def _restore_modules(base):
    mods = _sys.modules
    # Lazily imported additions stay; snapshot entries that were removed or
    # replaced come back.
    if all(mods.get(k) is v for k, v in base.items()):
        return False
    for key, value in base.items():
        if mods.get(key) is not value:
            mods[key] = value
    return True


def _restore_list(current, base):
    if current == base:
        return False
    current[:] = base
    return True


def _restore_numpy(snap):
    np = _sys.modules.get("numpy")
    if np is None or "np_err" not in snap:
        return []
    restored = []
    if np.geterr() != snap["np_err"]:
        np.seterr(**snap["np_err"])
        restored.append("numpy.errstate")
    if np.get_printoptions() != snap["np_print"]:
        np.set_printoptions(**snap["np_print"])
        restored.append("numpy.printoptions")
    restored.extend(_restore_numpy_random(np, snap))
    return restored


def _restore_numpy_random(np, snap):
    """(name, keys[624], pos, has_gauss, cached) — tuple compare is cheap;
    restore only when a call moved the global RNG."""
    if "np_random" not in snap:
        return []
    cur = np.random.get_state()
    base = snap["np_random"]
    same = (
        cur[0] == base[0]
        and np.array_equal(cur[1], base[1])
        and cur[2] == base[2]
        and cur[3] == base[3]
        and cur[4] == base[4]
    )
    if same:
        return []
    np.random.set_state(base)
    return ["numpy.random"]


def _restore_pandas_accessors(snap):
    """Undo register_*_accessor() from model code. Only CachedAccessor
    attributes that differ from the boot snapshot are reverted — attributes
    pandas itself adds lazily (plot/sparse/…) are already in the snapshot, so
    this never strips pandas internals a warm worker still needs."""
    acc = _accessor_cache_type()
    pd = _sys.modules.get("pandas")
    if acc is None or pd is None or "pd_class_dicts" not in snap:
        return False
    changed = False
    for name, base in snap["pd_class_dicts"].items():
        cls = getattr(pd, name, None)
        if not isinstance(cls, type):
            continue
        for key, val in list(cls.__dict__.items()):
            if isinstance(val, acc) and base.get(key) is not val:
                if key in base:
                    setattr(cls, key, base[key])
                else:
                    delattr(cls, key)
                changed = True
    return changed


def _canary():
    np = _sys.modules.get("numpy")
    if np is not None and int(np.arange(4).sum()) != 6:
        return "numpy canary failed"
    pd = _sys.modules.get("pandas")
    if pd is not None and int(pd.Series([1, 2, 3]).sum()) != 6:
        return "pandas canary failed"
    return None


def reset(snap):
    """Restore shared state. Returns {"restored": [...], "broken": str|None}."""
    restored = []
    try:
        if _restore_modules(snap["modules"]):
            restored.append("sys.modules")
        if _restore_list(_sys.path, snap["path"]):
            restored.append("sys.path")
        if _sys.getrecursionlimit() != snap["recursion"]:
            _sys.setrecursionlimit(snap["recursion"])
            restored.append("recursionlimit")
        if _restore_warnings(snap):
            restored.append("warnings.filters")
        restored.extend(_restore_numpy(snap))
        pd_cfg = _pandas_config()
        if pd_cfg is not None and "pd_options" in snap and _restore_tree(pd_cfg, snap["pd_options"]):
            restored.append("pandas.options")
        if _restore_pandas_accessors(snap):
            restored.append("pandas.accessors")
        broken = _canary()
    except BaseException as exc:  # noqa: BLE001 - any failure here means the worker is unusable
        broken = f"reset failed: {type(exc).__name__}: {str(exc)[:200]}"
    return {"restored": restored, "broken": broken}
