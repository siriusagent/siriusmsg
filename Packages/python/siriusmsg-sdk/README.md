# siriusmsg-sdk

Generated Pydantic v2 models and a hand-written asyncio NDJSON client for the
SiriusMsg local service.

This package is distinct from the bundled SwiftPython adapter SDK named
`siriusmsg`. Import this client package as:

```python
from siriusmsg_sdk import SiriusMsgClient
```

The client talks only to the authenticated local service socket. It does not read
the Messages database, call AppleEvents, use Keychain APIs, or control the
app/agent lifecycle.

Full integration docs are in `docs/sdk-python.md`.

Development commands:

```bash
python3 -m pip install -e "Packages/python/siriusmsg-sdk[dev]"
PYTHONPATH="$PWD/Packages/python/siriusmsg-sdk/src" python3 -m pytest Packages/python/siriusmsg-sdk/tests
```
