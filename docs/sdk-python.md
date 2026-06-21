# Python SDK

The Python package lives at `Packages/python/siriusmsg-sdk` and imports as
`siriusmsg_sdk`. It is a generated-model plus hand-written-client package for
the SiriusMsg local service protocol. It is not the bundled SwiftPython hook SDK
named `siriusmsg`.

The package is intentionally narrow:

- Generated Pydantic v2 models come from `Schema/siriusmsg-protocol-v1.schema.json`.
- The client talks to the authenticated Unix-domain socket, or explicit
  loopback VM endpoint when VM access is enabled.
- It does not read the Messages database, call AppleEvents, use Keychain APIs,
  install login items, or manage the SiriusMsg app/agent lifecycle.
- Unsupported local sends are rejected before dispatch by checking the service
  capability matrix.

## Install From This Repository

The package is source-published in this repository. From a checkout:

```sh
python3 -m pip install -e "Packages/python/siriusmsg-sdk"
```

For test dependencies:

```sh
python3 -m pip install -e "Packages/python/siriusmsg-sdk[dev]"
```

The generated models in `src/siriusmsg_sdk/_models.py` are produced by the
release pipeline and committed here with the matching schema and golden frames.

## Test From This Repository

```sh
PYTHONPATH="$PWD/Packages/python/siriusmsg-sdk/src" python3 -m pytest Packages/python/siriusmsg-sdk/tests
```

The tests validate the committed schema/golden frames, capability gating, and
client behavior against local fake protocol servers. They do not touch Apple
Messages.

## Basic Client

```python
import asyncio

from siriusmsg_sdk import SiriusMsgClient, SiriusMsgServiceAck


async def main() -> None:
    client = await SiriusMsgClient.connect()
    health = await client.health()
    print(health.state)

    async for event in client.subscribe(supports_attachments=True):
        if event.message is None:
            continue

        message = event.message
        await client.send_text(message.chatID.root, f"received: {message.id.root}")
        await client.ack(
            SiriusMsgServiceAck(
                messageID=message.id,
                chatID=message.chatID,
                rowID=message.rowID,
            )
        )


asyncio.run(main())
```

ACKs should be sent on the same subscription client that received the event.
Rows are not durably advanced until the service accepts the ACK.

## Sirius-agent Adapter Shape

Sirius-agent should consume the local protocol through this package instead of
reading Messages databases or driving Messages.app itself:

```python
from siriusmsg_sdk import SiriusMsgClient, SiriusMsgServiceAck


async def run_sirius_agent_bridge(agent) -> None:
    client = await SiriusMsgClient.connect()

    async for event in client.subscribe(supports_attachments=True):
        if event.message is None:
            continue

        message = event.message
        result = await agent.run(
            input=message.text or "",
            metadata={
                "source": "siriusmsg",
                "chat_id": message.chatID.root,
                "message_id": message.id.root,
            },
        )
        if result.reply:
            await client.send_text(message.chatID, result.reply)
        await client.ack(SiriusMsgServiceAck(messageID=message.id, chatID=message.chatID, rowID=message.rowID))
```

The adapter owns agent retry and dead-letter policy. It should ACK only after its
handler and any required reply send have resolved.

## Claws Tool Shape

Claws can expose a normal async tool that delegates to the local service:

```python
from siriusmsg_sdk import SiriusMsgClient


async def send_message(chat_id: str, text: str) -> bool:
    client = await SiriusMsgClient.connect()
    result = await client.send_text(chat_id, text)
    return result.accepted
```

For receive workflows, keep a long-lived subscription worker and pass sanitized
`SiriusMsgServiceEvent` values into Claws. Do not pass raw database rows,
AppleEvents handles, Keychain handles, or original attachment filesystem paths.
The same worker can branch on `reaction`, `messageEdited`, and `messageUnsent`
events for awareness without receiving hidden Messages metadata.

## Rich Content And Capability Honesty

Always ask capabilities before exposing a content type in an agent UI:

```python
from siriusmsg_sdk import SiriusMsgContentKind, SiriusMsgReaction, UnsupportedContentError

try:
    await client.send_reaction(chat_id, target_message_id, SiriusMsgReaction.like)
except UnsupportedContentError:
    # Local Messages automation does not support sending reactions in v1.
    pass
```

The local transport supports text, staged file sends, and URL rich links.
Reactions, typing indicators, message effects, edits, unsends, threaded reply
sends, mini-app cards, and Apple Pay actions are not silently emulated as text.
They fail before the request reaches Automation unless a future capability matrix
reports a supported transport.

The Python client still exposes the full Swift Kit helper surface:
`send_reaction`, `send_threaded_reply`, `send_edit`, `send_unsend`,
`send_typing`, and `send_message_effect` all use the same capability gate.
