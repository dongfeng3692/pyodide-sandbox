# Security Policy

## Summary

pyodide-sandbox is a hardened execution sandbox for semi-trusted Python code
(model-generated code, prompt-injection threat model). Its guarantees,
non-goals, and residual risks are specified in [threat-model.md](threat-model.md) —
read it before deploying against untrusted input.

Key invariants:

- zero persistence between calls (fresh globals, scratch wiped before/after);
- the JS bridge (`js`, `pyodide`, `micropip`) is removed at boot and re-import
  is denied at runtime;
- model code never receives real `__builtins__`;
- resource abuse is bounded by terminate-on-timeout and RSS recycle.

## Reporting a Vulneribility

Please report privately via **GitHub Security Advisories**: open the repo's
"Security" tab → "Report a vulnerability" (Private Vulnerability Reporting).
If that channel is unavailable to you, open a blank issue titled only
"security contact" and maintainers will provide a private channel — do not
include details in the issue itself. Include: repro snippet, expected vs
observed layer behavior (threat-model §4), and affected version. We aim to
respond within 7 days.

**Do not open public issues for suspected vulnerabilities.**

## Scope

In scope: the layer stack described in threat-model §4, the policy engine,
the pool/worker lifecycle, the HTTP surface.

Out of scope: V8/Node 0-days, Spectre-class side channels, bugs in Pyodide
itself (report upstream), and multi-tenant separation between authenticated
callers of one instance.
