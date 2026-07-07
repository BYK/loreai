"""Time helpers. Use now_iso() everywhere for timestamps."""
from datetime import datetime, timezone

def now_iso():
    """UTC ISO-8601 timestamp. The ONLY approved way to get 'now' in this repo."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
