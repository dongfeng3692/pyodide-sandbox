"""Result encoding for pyodide-sandbox (trusted, concatenated before wrapper.py).

Turns the model's `result` into plain JSON. Common data-science values are
converted natively instead of becoming placeholders: models write
``result = {"total": df["x"].sum()}`` (a numpy int64) all the time, and a
``<unserializable:int64>`` placeholder reads to them like a failure.

Unknown objects still degrade to a marked placeholder + warning rather than
failing the whole call.
"""

import datetime as _dt
import numbers as _numbers
import sys as _sys

MAX_RESULT_DEPTH = 24
# Above this many rows a Series/DataFrame cannot fit the result budget anyway;
# fail early with guidance instead of materializing a huge dict first.
MAX_FRAME_ROWS = 2000


class ResultTooLarge(ValueError):
    """Raised when the encoded result cannot fit the size budget."""

    def __init__(self, detail):
        super().__init__("result_too_large_select_relevant_rows_or_aggregate")
        self.detail = detail


def _is_missing(value):
    try:
        return bool(value != value)  # NaN / NaT
    except Exception:  # noqa: BLE001 - ambiguous truth values etc.
        return False


def _encode_pandas(value, warnings, depth):
    pd = _sys.modules.get("pandas")
    if pd is None:
        return False, None
    if value is pd.NA or value is pd.NaT:
        return True, None
    if isinstance(value, pd.DataFrame):
        if len(value) > MAX_FRAME_ROWS:
            raise ResultTooLarge(f"DataFrame with {len(value)} rows")
        frame = value
        if not isinstance(frame.index, pd.RangeIndex) or frame.index.start != 0 or frame.index.step != 1:
            frame = frame.reset_index()
        return True, encode(frame.to_dict(orient="records"), warnings, depth + 1)
    if isinstance(value, pd.Series):
        if len(value) > MAX_FRAME_ROWS:
            raise ResultTooLarge(f"Series with {len(value)} rows")
        return True, encode(value.to_dict(), warnings, depth + 1)
    if isinstance(value, (pd.Index, pd.Categorical)):
        return True, encode(list(value), warnings, depth + 1)
    if isinstance(value, pd.Timedelta):
        return True, str(value)
    if isinstance(value, pd.Interval):
        return True, str(value)
    return False, None


def _encode_numpy(value, warnings, depth):
    np = _sys.modules.get("numpy")
    if np is None:
        return False, None
    if isinstance(value, np.ndarray):
        if value.size > MAX_FRAME_ROWS * 10:
            raise ResultTooLarge(f"ndarray with {value.size} elements")
        return True, encode(value.tolist(), warnings, depth + 1)
    if isinstance(value, np.generic):
        return True, encode(value.item(), warnings, depth + 1)
    return False, None


def encode(value, warnings, depth=0):
    """Recursively JSON-encode, degrading unsupported values instead of failing."""
    if depth > MAX_RESULT_DEPTH:
        warnings.append("result_nesting_too_deep")
        return "<truncated>"
    if value is None or isinstance(value, (str, bool)):
        return value
    if type(value) is int:
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            warnings.append("non_finite_value")
            return None
        return float(value)
    if isinstance(value, dict):
        return {_encode_key(k): encode(v, warnings, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [encode(v, warnings, depth + 1) for v in value]
    if isinstance(value, bytes):
        warnings.append("bytes_value_b64")
        import base64

        return base64.b64encode(value).decode("ascii")
    # datetime-likes before pandas/numpy: pd.Timestamp subclasses datetime
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return None if _is_missing(value) else value.isoformat()
    if isinstance(value, _dt.timedelta):
        return str(value)
    for handler in (_encode_pandas, _encode_numpy):
        handled, out = handler(value, warnings, depth)
        if handled:
            return out
    if isinstance(value, _numbers.Integral):
        return int(value)
    if isinstance(value, _numbers.Real):
        return encode(float(value), warnings, depth)
    type_name = type(value).__name__
    warnings.append(f"unserializable:{type_name}")
    return f"<unserializable:{type_name}>"


def _encode_key(key):
    if isinstance(key, (_dt.datetime, _dt.date)):
        return key.isoformat()
    np = _sys.modules.get("numpy")
    if np is not None and isinstance(key, np.generic):
        key = key.item()
    if isinstance(key, tuple):
        return ", ".join(str(_encode_key(k)) for k in key)
    return str(key)
