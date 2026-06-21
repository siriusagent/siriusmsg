# Sirius Agent Integration Pattern

This note describes how agent runtimes consume SiriusMsg through the public local
protocol SDKs. It is a reference pattern for bringing Apple Messages support to
an agent without adding a second Messages transport.

SiriusMsg is the transport owner. The consuming agent runtime should not open
Messages, read the Messages database, shell out to AppleScript, call
AppleEvents, or bypass SiriusMsg allowlists. The runtime receives sanitized
message events and returns adapter decisions.

## Ownership Split

SiriusMsg owns:

- Full Disk Access and Automation permission diagnostics
- read-only Messages receive
- allowlist filtering before delivery
- local service auth
- durable event delivery and ACK policy
- attachment materialization and local file references
- reply send dispatch through Messages.app
- read-only send confirmation
- blocked-review state for unconfirmed sends

The agent runtime owns:

- session routing for the user-facing conversation
- model/tool execution
- prompt and transcript policy
- projection of fetched attachments into its own model format
- deciding whether to reply, retry, dead-letter, or mark handled

## Public SDK Shape

A public adapter connects through the Python or TypeScript SDK, subscribes to
allowlisted events, hands each event to its agent runtime, sends replies through
SiriusMsg, and ACKs only after the handler policy says the turn is owned.

```python
from siriusmsg_sdk import SiriusMsgClient, SiriusMsgServiceAck


async def run_bridge(agent):
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
        await client.ack(
            SiriusMsgServiceAck(
                messageID=message.id,
                chatID=message.chatID,
                rowID=message.rowID,
            )
        )
```

TypeScript follows the same shape with `SiriusMsgClient.connect()`,
`subscribe`, `sendText`, and `ack`. The important part is the boundary: the
runtime can call Python, a local model server, an OpenResponses-compatible
gateway, or a native loop, but it should still send through SiriusMsg instead of
calling Messages itself.

## Python Runtime Shape

If the host dispatches into Python, the Python side should receive a normal
agent-turn payload and return decision-shaped JSON. It should not receive raw
database rows, service tokens, AppleEvents handles, Keychain handles, or
Apple-owned attachment paths.

```python
def run_siriusmsg_turn(payload):
    session_key = stable_nonreversible_route_key(payload["chat_id"])

    result = run_agent_turn(
        session_key=session_key,
        user_text=payload["text"],
        attachments=payload.get("attachments", []),
        system_message=(
            "You are replying to a Messages conversation delivered by "
            "SiriusMsg. Return only the reply text. SiriusMsg owns routing, "
            "sending, ACKs, retries, and diagnostics."
        ),
    )

    if result.retryable_error:
        return {
            "decision": "retry",
            "retry_after_seconds": 30,
        }

    if result.error:
        return {"decision": "dead_letter"}

    if result.reply_text:
        return {
            "decision": "reply",
            "reply_text": result.reply_text,
        }

    return {"decision": "handled"}
```

For simple Python adapters that run inside the SiriusMsg-hosted adapter SDK, use
the bundled `siriusmsg` package:

```python
from siriusmsg import adapter


@adapter.on_message
async def handle(ctx):
    result = await my_agent(ctx.message.text)
    return ctx.reply(result)
```

## Session Routing

Do not persist raw Messages chat identifiers as user-facing session IDs. Derive
a stable, non-reversible route key and store that instead.

```python
def stable_nonreversible_route_key(raw_chat_id: str) -> str:
    digest = hmac_sha256(local_secret(), raw_chat_id.encode("utf-8"))
    return f"imsg_{digest[:24]}"
```

The local secret should be generated once, stored owner-only, and never
published. Diagnostics can mention the derived key; they should not contain raw
chat IDs, handles, or message bodies.

## Attachment Handling

Subscribe with attachment support only if the runtime can process attachments.
When enabled, SiriusMsg delivers metadata and a SiriusMsg-owned local file
reference. The consumer verifies size and hash before projecting the file into
its own model format.

```python
async def fetch_attachment_payloads(client, attachments):
    payloads = []

    for attachment in attachments:
        if attachment.state.value != "materialized":
            continue
        data = await client.fetch_attachment_data(attachment.id)
        payloads.append({
            "id": attachment.id.root,
            "mime_type": attachment.mimeType,
            "byte_count": attachment.byteCount,
            "sha256": attachment.sha256,
            "bytes": data,
        })

    return payloads
```

SiriusMsg does not prescribe provider-specific content blocks. The consuming
runtime decides whether an attachment becomes an image block, document block, or
unsupported-content retry.

## Prompt Boundary

The model should see the sender's natural message body, plus safe attachment
content if the runtime supports it. It should not see transport metadata as
ordinary chat text.

Avoid model-facing wrappers like:

```text
SiriusMsg inbound
Platform: iMessage
Row ID: ...
Chat ID: ...
```

Those values are useful for diagnostics, not for the conversation. The final
assistant text should be the outbound message body, not a status report such as
"Sent to ...".

## Verification Checklist

Before calling an integration ready:

- The model cannot call a second Messages transport path.
- The runtime does not read the Messages database.
- The runtime does not shell out to AppleScript.
- Raw chat IDs and handles are absent from diagnostics and session titles.
- Message bodies are absent from logs and diagnostics.
- Attachment file references are fetched through SiriusMsg and verified before use.
- Retry and dead-letter decisions do not leak private message content.
- Unconfirmed sends are not auto-retried as if they were rejected sends.
- A stale-event guard prevents first-run backlog replies unless explicitly enabled.

This is the level of integration Sirius uses: SiriusMsg owns the protected local
Messages bridge, and the consuming agent runtime owns the agent turn.
