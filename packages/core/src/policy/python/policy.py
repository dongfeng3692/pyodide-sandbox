"""AST policy engine for pyodide-sandbox (dual-use).

Runs inside the Pyodide runtime AND can run under any CPython >= 3.11 as a
host-side pre-check (import this file, call validate(code, policy)).

Configuration arrives via the ``__SBX_POLICY__`` JSON object which the runtime
prepends to this source (or is passed explicitly when used as a library).

Policy fields:
  banSyntax         list of ast node class names to reject (e.g. "Import")
  banNames          set of forbidden identifiers
  attributeMode     "deny-underscore" | "whitelist" | "off"
  attributeWhitelist list of allowed attribute names (whitelist mode)
  forbidAttributeStore  ban Attribute nodes in Store context (anti-monkeypatch),
                     EXCEPT `self.x = ...` / `cls.x = ...` lexically inside a
                     class body — without that exemption no class can hold
                     instance state, so the allowed `class` syntax is unusable
  denyUnderscoreNames   ban `_`-prefixed identifiers (False only in `raw`)
  maxCodeBytes      hard cap on code size

The engine is deliberately dumb and total: it never evaluates user code, it
only walks the parsed tree. Errors carry (code, symbol, lineno) so callers can
feed structured feedback to a model for self-correction.
"""

import ast
import json

DANGEROUS_SYNTAX = {
    "Import", "ImportFrom", "FunctionDef", "AsyncFunctionDef", "ClassDef",
    "Global", "Nonlocal", "Lambda",
}


class PolicyError(ValueError):
    """Raised on a policy violation. Never carries user data, only symbols.

    ``detail`` is optional context for self-correction: the parser message
    for syntax errors, the module name for a rejected import.
    """

    def __init__(self, code, name=None, lineno=None, detail=None):
        super().__init__(code)
        self.code = code
        self.name = name
        self.lineno = lineno
        self.detail = detail


def _syntax_detail(exc):
    where = f"line {exc.lineno}" if exc.lineno else "unknown line"
    if getattr(exc, "offset", None):
        where += f", column {exc.offset}"
    text = (exc.text or "").strip()
    snippet = f": {text[:120]}" if text else ""
    return f"{exc.msg} ({where}){snippet}"


def _import_detail(node):
    if isinstance(node, ast.ImportFrom):
        return node.module or None
    names = [alias.name for alias in node.names]
    return names[0] if names else None


def load_policy(payload=None):
    if payload is None:
        payload = json.loads(__SBX_POLICY__)  # injected by the runtime
    return {
        "banSyntax": set(payload.get("banSyntax") or []),
        "banNames": set(payload.get("banNames") or []),
        "attributeMode": payload.get("attributeMode", "deny-underscore"),
        "attributeWhitelist": set(payload.get("attributeWhitelist") or []),
        "forbidAttributeStore": bool(payload.get("forbidAttributeStore", True)),
        "denyUnderscoreNames": bool(payload.get("denyUnderscoreNames", True)),
        "maxCodeBytes": int(payload.get("maxCodeBytes", 24000)),
    }


def _attr_root(node):
    """Root identifier of an attribute chain: _attr_root(self.x.y) == "self"."""
    while isinstance(node, ast.Attribute):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _self_stores(nodes, in_class, out):
    """Collect ids of Attribute-Store nodes exempt from the store ban.

    `self.x = ...` (any depth, e.g. self.cfg.rows) and `cls.x = ...` are the
    only way to give class instances state, so they stay legal — but ONLY
    lexically inside a ClassDef body. A bare `def f(self): self.x = 1` at
    module level is still rejected, which keeps the exemption from becoming
    a monkeypatch hole: module-level objects (pd, np, files) can never be the
    `self` of a class method.
    """
    for node in nodes:
        if isinstance(node, ast.ClassDef):
            _self_stores(node.body, True, out)  # methods (and their closures) see the class scope
            continue
        if (in_class and isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Store)
                and _attr_root(node) in ("self", "cls")):
            out.add(id(node))
        _self_stores(ast.iter_child_nodes(node), in_class, out)


def validate(code, policy):
    """Raise PolicyError if ``code`` violates ``policy``. Total: no execution."""
    if not isinstance(code, str) or not code.strip():
        raise PolicyError("invalid_code_size")
    if len(code.encode("utf-8")) > policy["maxCodeBytes"]:
        raise PolicyError("code_too_large")

    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise PolicyError("syntax_error", None, getattr(exc, "lineno", None), _syntax_detail(exc)) from None

    banned = policy["banSyntax"]
    names = policy["banNames"]
    mode = policy["attributeMode"]
    allowed_attrs = policy["attributeWhitelist"]
    forbid_store = policy["forbidAttributeStore"]
    self_stores = set()
    if forbid_store:
        _self_stores([tree], False, self_stores)

    for node in ast.walk(tree):
        kind = type(node).__name__
        if kind in banned:
            detail = _import_detail(node) if isinstance(node, (ast.Import, ast.ImportFrom)) else None
            raise PolicyError("forbidden_syntax", kind.lower(), getattr(node, "lineno", None), detail)
        if isinstance(node, ast.Name):
            ident = node.id
            dunder_ban = policy["denyUnderscoreNames"] and ident.startswith("_") and ident != "_"
            if dunder_ban or ident in names:
                raise PolicyError("forbidden_name", ident, node.lineno)
        elif isinstance(node, ast.Attribute):
            if mode == "deny-underscore" and node.attr.startswith("_"):
                raise PolicyError("forbidden_attribute", node.attr, node.lineno)
            elif mode == "whitelist" and node.attr not in allowed_attrs:
                raise PolicyError("forbidden_attribute", node.attr, node.lineno)
            if forbid_store and isinstance(node.ctx, ast.Store) and id(node) not in self_stores:
                raise PolicyError("forbidden_store", node.attr, node.lineno)
    return True
