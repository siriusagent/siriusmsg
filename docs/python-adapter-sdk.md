# Python Adapter SDK

This is the reference surface for Python agent runtimes that consume SiriusMsg.
It is the right layer for Sirius, Hermes, OpenClaw, and similar Python stacks.

The bundled Python package, `siriusmsg`, is the adapter authoring surface hosted
by `SiriusMsgAgent` through SwiftPython. Python code does not own socket auth,
Messages database access, the Messages send path, cursor state, ACK policy,
durable queue, or send confirmation. It receives one sanitized turn and returns
one decision.

## Minimal Handler

```python
from siriusmsg import adapter


@adapter.on_message
async def handle(ctx):
    result = await my_agent(ctx.message.text)
    return ctx.reply(result)
```

The configured handler receives `AdapterContext`:

- `ctx.message`: `Message(id, chat_id, row_id, handle_id, author_display_name, text, received_at, is_group_chat, attachments)`
- `ctx.adapter_id`: configured adapter id
- `ctx.recipe`: sanitized recipe envelope when the turn was routed from a recipe, otherwise `None`
- `ctx.attempt`: durable attempt number
- `ctx.first_enqueued_at`: first durable enqueue time, if present
- `ctx.last_attempt_at`: previous attempt time, if present
- `await ctx.health()`: constrained Swift service health
- `await ctx.capabilities()`: constrained adapter capabilities
- `await ctx.fetch_attachment(attachment)`: fetch SiriusMsg-owned attachment bytes after opting into attachments

Handlers return:

- `None` for handled with no reply
- `str` for a simple reply
- `ctx.reply(text, account_id=None)` for an explicit reply decision
- `ctx.retry(after, reason)` for a retry decision
- `ctx.dead_letter(reason)` for a terminal failure decision

## Boundary Rules

Adapters must not read the Messages database, call AppleEvents, access Keychain
items, or connect directly to the SiriusMsg service socket. They must not log
message bodies. SiriusMsg owns allowlist enforcement before delivery, ACK after
the configured runner policy, reply sending through Messages.app, and read-only
send confirmation.

The SDK intentionally exposes data, not power:

- raw database rows are never passed to Python
- recipe envelopes contain action kinds, not action payloads or message bodies
- Apple-owned attachment paths are never passed to Python
- service auth tokens are never passed to Python
- AppleEvents or ScriptingBridge handles are never passed to Python
- reply sends are returned as decisions and executed by Swift

## Sirius-Style Runtime

Use this shape when the consumer already has an async Python entry point such as
`run_siriusmsg_imessage_turn(...)`.

```python
from siriusmsg import adapter
from sirius_agent.session.factory import run_siriusmsg_imessage_turn


@adapter.on_message
async def handle(ctx):
    result = await run_siriusmsg_imessage_turn({
        "source": "siriusmsg",
        "message": {
            "id": ctx.message.id,
            "chat_id": ctx.message.chat_id,
            "text": ctx.message.text,
        },
        "attempt": ctx.attempt,
    })
    return ctx.reply(result["reply"])
```

Keep routing metadata small. The adapter may pass `chat_id`, `message.id`, and
attempt information to the consumer runtime, but it should not invent a parallel
Messages abstraction or expose handles beyond what the user-facing agent needs.

## Hermes-Style Runtime

Hermes ACP mode exposes Hermes to editors over stdio, but the underlying runtime
still accepts normal conversation turns. A SiriusMsg adapter should call that
runtime shape directly instead of trying to make Apple Messages speak ACP.

```python
from siriusmsg import adapter
from hermes_runtime import HermesRuntime

runtime = HermesRuntime()


@adapter.on_message
async def handle(ctx):
    result = await runtime.run_conversation(
        user_message=ctx.message.text,
        conversation_history=[
            {"role": "system", "content": f"siriusmsg_chat:{ctx.message.chat_id}"},
            {"role": "user", "content": ctx.message.text},
        ],
        task_id=ctx.message.id,
    )
    return ctx.reply(result["final_response"])
```

If the Hermes runtime is synchronous, wrap it with `asyncio.to_thread(...)` or a
consumer-owned executor. Do not block the SwiftPython worker longer than the
adapter timeout.

## OpenClaw OpenResponses-Style Gateway

OpenClaw's documented Gateway path can expose an OpenResponses-compatible
`POST /v1/responses` endpoint. SiriusMsg should use that as an HTTP consumer
shape when OpenClaw owns the agent run, routing, and permissions.

```python
from siriusmsg import adapter
from openclaw_client import OpenResponsesGateway

gateway = OpenResponsesGateway(
    base_url="http://127.0.0.1:7331",
    bearer_token=load_openclaw_gateway_token(),
)


@adapter.on_message
async def handle(ctx):
    response = await gateway.responses_create(
        model="openclaw/default",
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": ctx.message.text},
                ],
            },
        ],
        user=ctx.message.chat_id,
        metadata={
            "source": "siriusmsg",
            "message_id": ctx.message.id,
        },
    )
    return ctx.reply(response["output_text"])
```

Use `ctx.message.chat_id` as a stable `user` or session key when the target
runtime should keep per-chat context. SiriusMsg still owns Messages delivery and
ACK semantics; OpenClaw owns the agent turn once the adapter calls the gateway.

## Attachments

Attachment-capable adapters must opt in through adapter configuration. Without
that flag, SiriusMsg blocks attachment-bearing rows at the service boundary
instead of delivering partial turns.

```python
@adapter.on_message
async def handle(ctx):
    images = []
    documents = []

    for attachment in ctx.message.attachments:
        if not attachment.is_fetchable:
            continue
        fetched = await ctx.fetch_attachment(attachment)
        if attachment.is_image:
            images.append((attachment.mime_type, fetched.read_bytes()))
        elif attachment.is_document:
            documents.append((fetched.path_obj, attachment.mime_type))

    result = await my_agent(ctx.message.text, images=images, documents=documents)
    return ctx.reply(result)
```

Adapters decide how to project fetched bytes into their target runtime. SiriusMsg
does not parse documents, OCR images, create provider-specific content blocks, or
send provider-specific rich payloads from Python. Outbound file send is owned by
the native service capability matrix and should be requested through the local
protocol SDKs, not by giving hooks or adapters AppleEvents access.

## Error Policy

Use `ctx.retry(...)` for transient consumer failures such as rate limits,
gateway unavailability, or model timeouts. Use `ctx.dead_letter(...)` for
permanent adapter failures such as unsupported content, unsupported destination,
or invalid consumer configuration. Raise an exception only when the host should
treat the handler execution itself as failed.

Unconfirmed reply sends are not safe to auto-retry because the outbound message
may already have left Messages.app. Swift owns that blocked-review state.

## Verification

The hosted SDK contract is covered by the SiriusMsg app release gate with real
SwiftPython-hosted Python fixtures against the SiriusMsg adapter host, including:

- generic decision normalization
- Swift async callbacks for health, capabilities, and attachment fetch
- message-body redaction and attachment opt-in
- Sirius-style async runtime mock
- Hermes-style `run_conversation(...)` mock
- OpenResponses gateway-style mock
- timeout and SDK source privacy checks

Consumer integrations should add their own adapter fixture using the same shape
before shipping a named SiriusMsg adapter.

## References

- Hermes ACP editor integration: `https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md`
- OpenClaw OpenResponses Gateway API: `https://docs.openclaw.ai/gateway/openresponses-http-api`
- OpenClaw `openclaw agent` CLI behavior: `https://docs.openclaw.ai/cli/agent`
