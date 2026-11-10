# pyodide-sandbox Python client

Not published to PyPI — install from the repository (or vendor the
`sbx_client/` package directly; it only depends on `httpx`):

```bash
git clone https://github.com/dongfeng3692/pyodide-sandbox
pip install -e pyodide-sandbox/packages/client-py
```

```python
from sbx_client import SbxClient, AsyncSbxClient

sbx = SbxClient("http://127.0.0.1:8787", token="<your-token>")
out = sbx.execute('result = {"answer": 6 * 7}')
assert out["ok"], out["error"]

out = sbx.execute(
    'df = pd.read_csv(files["demo.csv"])\nresult = {"rows": len(df)}',
    files={"demo.csv": b"a,b\n1,2\n"},
)

async with AsyncSbxClient("http://127.0.0.1:8787", token="<your-token>") as asbx:
    out = await asbx.execute('result = {"n": 1}')
```

Error semantics: `execute()` **returns** the response envelope as a dict for
sandbox-level errors (`ok: false` with `error.code` like `forbidden_syntax`,
`result_too_large` — the model can self-correct from those). Transport-level
and pool-level failures (HTTP >= 400 mapped by the server: 401/408/422/429/
500/503) raise `SbxError` with `.type` and `.retryable`.
