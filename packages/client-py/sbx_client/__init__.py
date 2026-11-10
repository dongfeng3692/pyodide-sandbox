"""Python client for a pyodide-sandbox server (sync + async).

    from sbx_client import SbxClient
    sbx = SbxClient("http://127.0.0.1:8787", token="...")
    out = sbx.execute('result = {"answer": 6 * 7}')
    out = sbx.execute(
        'df = pd.read_csv(files["demo.csv"])\nresult = {"rows": len(df)}',
        files={"demo.csv": b"a,b\n1,2\n"},
    )

Error semantics: sandbox-level errors come back as the response envelope
(``ok: False`` with a structured ``error`` the model can self-correct from);
transport/pool-level failures (HTTP >= 400) raise :class:`SbxError`.
"""
from __future__ import annotations

import base64
import os
from typing import Any, Mapping

import httpx


class SbxError(RuntimeError):
    def __init__(self, payload: Mapping[str, Any]):
        err = payload.get("error") or {}
        if isinstance(err, str):
            err = {"type": err}
        super().__init__(f"{err.get('type')}: {err.get('message', '')}".strip(": "))
        self.type = err.get("type")
        self.code = err.get("code")  # sandbox-level classification, e.g. forbidden_syntax
        self.retryable = bool(err.get("retryable", False))
        self.line = err.get("line")
        self.symbol = err.get("symbol")


def _build_body(code: str, files: Mapping[str, bytes] | None) -> dict[str, Any]:
    body: dict[str, Any] = {"code": code}
    if files:
        body["files"] = [
            {"name": name, "b64": base64.b64encode(data).decode("ascii")}
            for name, data in files.items()
        ]
    return body


class SbxClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 120.0):
        self._client = httpx.Client(
            base_url=(base_url or os.environ.get("SBX_URL", "http://127.0.0.1:8787")).rstrip("/"),
            timeout=timeout,
            headers=self._headers(token),
        )

    @staticmethod
    def _headers(token: str | None) -> dict[str, str]:
        token = token or os.environ.get("SBX_TOKEN", "")
        return {"x-sbx-token": token} if token else {}

    def health(self) -> dict[str, Any]:
        return self._client.get("/health").json()

    def execute(self, code: str, files: Mapping[str, bytes] | None = None) -> dict[str, Any]:
        resp = self._client.post("/exec", json=_build_body(code, files))
        payload = resp.json()
        if resp.status_code >= 400:
            raise SbxError(payload)
        return payload

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "SbxClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class AsyncSbxClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 120.0):
        self._client = httpx.AsyncClient(
            base_url=(base_url or os.environ.get("SBX_URL", "http://127.0.0.1:8787")).rstrip("/"),
            timeout=timeout,
            headers=SbxClient._headers(token),
        )

    async def health(self) -> dict[str, Any]:
        return (await self._client.get("/health")).json()

    async def execute(self, code: str, files: Mapping[str, bytes] | None = None) -> dict[str, Any]:
        resp = await self._client.post("/exec", json=_build_body(code, files))
        payload = resp.json()
        if resp.status_code >= 400:
            raise SbxError(payload)
        return payload

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncSbxClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()
