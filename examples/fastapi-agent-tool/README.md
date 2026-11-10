# FastAPI agent tool on pyodide-sandbox (runnable sketch)

Wire an LLM agent tool to a sandbox server. Authorization, budgets, and audit
stay on YOUR side — the sandbox is a stateless executor.

Run it:

```bash
pip install fastapi uvicorn httpx pyodide-sandbox-client  # or: pip install -e ../../packages/client-py
# create an API token at the sandbox admin UI (/admin → Settings), then:
SBX_TOKEN=<your-token> uvicorn tool:app --port 8000
# in another shell, with the sandbox running (npm start):
curl -s localhost:8000/analyze -H 'content-type: application/json' \
  -d '{"code": "result = {\"answer\": 6*7}", "files": {"demo.csv": "YSxiCjEsMgo="}}'
```

```python
# tool.py
import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sbx_client import AsyncSbxClient, SbxError

app = FastAPI()
sbx = AsyncSbxClient("http://127.0.0.1:8787", token=os.environ.get("SBX_TOKEN", ""))

TOOL_DESCRIPTION = (
    "在沙箱中执行 Python 分析授权的数据文件。可用: pd(pandas)、files(文件名→内容流)。"
    "禁止 import/文件写入;必须把结果放入 result={...} 字典。每次调用环境独立;"
    "错误带 line/symbol,据此修正后重试。最多 7 次。"
)

class AnalyzeRequest(BaseModel):
    code: str
    files: dict[str, bytes] = {}
    remaining_calls: int = 7          # host-side budget, decremented by the caller

@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    if req.remaining_calls <= 0:
        raise HTTPException(429, "tool_call_limit")
    try:
        payload = await sbx.execute(req.code, files=req.files)
    except SbxError as exc:           # transport/pool level (401/408/429/500/503)
        raise HTTPException(502, str(exc)) from exc
    # sandbox-level errors come back as payload["ok"] is False with a
    # structured error — return it verbatim so the model can self-correct
    return payload
```

Principles kept on the host:

- authorization, budgets, and audit live in **your** backend;
- files are passed per call, so revocation between calls is trivially safe;
- structured errors (`code`/`line`/`symbol`/`retryable`) are surfaced verbatim
  so the model can self-correct inside its budget.
