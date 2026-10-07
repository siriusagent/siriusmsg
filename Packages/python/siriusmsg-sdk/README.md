# siriusmsg-sdk

The SDK exposes messaging plus typed local-owner setup and diagnostics through
`SiriusMsgAgentControlClient`, using the same control API as SiriusMsg.app.
See [the feature matrix](../../../Docs/sdk-feature-parity.md) for connection
management, rich feature settings, activity, recovery and verification scope.

Generated Pydantic v2 models and a hand-written asyncio NDJSON client for the
SiriusMsg local service.

This package is distinct from the bundled SwiftPython adapter SDK named
`siriusmsg`. Import this client package as:

```python
from siriusmsg_sdk import SiriusMsgClient
```

Messaging uses the authenticated service socket; owner administration uses the
local control socket. Neither client reads the Messages database, calls AppleEvents or uses
Keychain APIs. The signed app handles installation, login-item registration,
macOS permission prompts and updates.

Full integration docs are in `Docs/sdk-python.md`.

Development commands:

```bash
Scripts/generate-sdks.sh --check
uvx --from ruff==0.14.8 ruff check Packages/python/siriusmsg-sdk/src Packages/python/siriusmsg-sdk/tests
uvx --from ruff==0.14.8 ruff format --check Packages/python/siriusmsg-sdk/src Packages/python/siriusmsg-sdk/tests
PYTHONPATH="$PWD/Packages/python/siriusmsg-sdk/src" python3 -m pytest Packages/python/siriusmsg-sdk/tests
```

### Typing during reply preparation

Typing is opt-in. The reference adapter prepares and sends replies without this
scope, so deferred typing support cannot delay a turn or its text reply.

```python
async with client.typing(chat_id):
    reply = await agent.prepare_reply(incoming)
await client.send_text(chat_id, reply)
```

The scope starts typing when supported, renews every two seconds, and stops on
exit or cancellation. Prepare text and files inside the scope; send them after
it exits. Typing is advisory: an unavailable, rejected, uncertain or failing
start or stop never blocks preparation and never raises, so a prepared reply is
still sent normally and keeps its own target, permission and confirmation
checks. Cancellation still cancels the turn. The server clears an abandoned
native lease five seconds after its last accepted heartbeat.
