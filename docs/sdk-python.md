# Python SDK

For the complete messaging, setup, diagnostics and recovery surface, see
[SDK feature parity](sdk-feature-parity.md). Local-owner controls use
`SiriusMsgAgentControlClient`; ordinary agent delivery uses a registered
`SiriusMsgClient` connection.

The Python package lives at `Packages/python/siriusmsg-sdk` and imports as
`siriusmsg_sdk`. It is a generated-model plus hand-written-client package for
the SiriusMsg local service protocol. It is not the bundled SwiftPython hook SDK
named `siriusmsg`.

The package shares the native service boundary:

- Generated Pydantic v2 models come from `Schema/siriusmsg-protocol-v1.schema.json`.
- The client talks to the authenticated Unix-domain socket, or explicit
  loopback VM endpoint when VM access is enabled.
- Owner setup, diagnostics and recovery use the same local control API as the app.
- The signed app handles installation, login items, macOS permission prompts and
  updates; neither SDK client reads the Messages database, calls AppleEvents or uses Keychain APIs.
- Unsupported local sends are rejected before dispatch by checking the service
  capability matrix.

## Generate

Run the repo-level generator whenever the Swift protocol models change:

```bash
Scripts/generate-sdks.sh
```

CI and release gates should use check mode:

```bash
Scripts/generate-sdks.sh --check
```

`SiriusMsgSchemaExport` writes the schema, `SiriusMsgGoldenExport` writes golden
wire frames, and `datamodel-code-generator` regenerates
`src/siriusmsg_sdk/_models.py`. Hand-written files in `siriusmsg_sdk` provide
transport, auth, validation, typed errors, and convenience helpers.

## Install For Development

```bash
python3 -m pip install -e "Packages/python/siriusmsg-sdk[dev]"
```

Run the Python suite from the repository root:

```bash
uvx --from ruff==0.14.8 ruff check Packages/python/siriusmsg-sdk/src Packages/python/siriusmsg-sdk/tests
uvx --from ruff==0.14.8 ruff format --check Packages/python/siriusmsg-sdk/src Packages/python/siriusmsg-sdk/tests
PYTHONPATH="$PWD/Packages/python/siriusmsg-sdk/src" python3 -m pytest Packages/python/siriusmsg-sdk/tests
```

The Ruff configuration excludes generated `_models.py`; generation check mode
owns that file, while lint and formatting cover hand-written client code and
tests.

The live test starts `SiriusMsgSDKHarness`, a fake SiriusMsg service backed by
repo Swift code. It does not touch Apple Messages.

## Allowed History And Retry-Safe Sends

`list_allowed_chats()`, `read_history()`, and `search_history()` use the service's current app-managed allowlist. A client can narrow a search with chat IDs but cannot widen access. History is newest-first and cursor-paged with `nextBeforeRowID`; it does not modify subscription ACK cursors.

`send()` assigns an operation ID when absent. For an application-level retry, construct `SiriusMsgSendRequest` with a stable `operationID` and reuse that request. The service returns the cached body-free result for an identical retry and fails closed for conflicting or uncertain operations.

If transport fails after `send()` generates an ID, it raises `SiriusMsgSendOutcomeUnknownError`. Read `error.operation_id` and reuse it for any retry; generating a new ID could create a second intended send.

## Basic Client

```python
import asyncio

from siriusmsg_sdk import SiriusMsgClient, SiriusMsgServiceAck


async def main() -> None:
    client = await SiriusMsgClient.connect()
    health = await client.health()
    print(health.state)

    async for event in client.subscribe(supports_attachments=False):
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
With `reconnect_policy=SiriusMsgReconnectPolicy.default`, the client retries
socket transport interruptions only; authentication and other service errors
fail immediately so callers can repair credentials or configuration instead of
entering a retry loop.

`fetch_attachment_data()` reads the service-provided file and verifies both its
declared byte count and SHA-256 digest before returning bytes. Local corruption
raises `AttachmentSizeMismatchError` or `AttachmentHashMismatchError`; both
identify the requested attachment without exposing its filesystem path.

## Agent adapter

The tested [reference runner](../Packages/python/siriusmsg-sdk/examples/adapter.py) keeps text and every attachment in one handler invocation, fetches verified file bytes, sends text/files with stable operation IDs, and ACKs only after durable completion.

```python
from siriusmsg_sdk import SiriusMsgClient
from adapter import run  # the reference module linked above

client = await SiriusMsgClient.connect(connection_id=connection_id)
await run(client, durable_handler, connection_id)
```

Supply the `DurableHandler` interface using your agent's existing job store. Its completion lookup prevents repeated handling after ACK loss. Its preparation method must persist a reply before returning and return the same reply on replay. Preserve prepared output files unchanged until sends resolve. Its completion method commits successful handling before the runner ACKs. This interface belongs to the consuming adapter; it is not an existing Sirius API or a second database supplied by this example.

An unavailable/corrupt attachment stops processing before the handler or ACK. Rejected and unconfirmed replies stop for review; network uncertainty preserves the SDK's operation ID. The runner does not infer successful delivery or retry with a new ID. Durable preparation alone does not guarantee exactly-once model execution if a process crashes before committing the model result.

This runner handles incoming message events. A consumer supporting edit, unsend or reaction events must route those typed events separately; they are not new text turns.

For a handler that stores attachment references instead of loading files, pass `attachment_mode="references"` to `run`. Each attachment arrives as `(metadata, None)`; `None` means not fetched, not an empty file. Metadata retains MIME type, ID, availability state and diagnostics. The default `"bytes"` mode fetches and verifies every file before calling the handler. Both modes opt into the existing attachment subscription contract, without changing legacy clients.

A text-only handler can render its own attachment label and keep the ID for a fetch tool. It must identify the content as an attachment it has not read. IDs require authenticated, allowed access and are not permanent public links. If the job requires the file later, copy verified bytes into the consumer's managed storage before committing completion; retaining a reference alone is not a durable copy of the file. Do not ACK a required fetch that failed.

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
    # This connection does not currently advertise reaction support.
    pass
```

The local transport supports text, staged file sends, and URL rich links.
Reactions, typing indicators, message effects, edits, unsends, threaded reply
sends, mini-app cards, and Apple Pay actions are not silently emulated as text.
They fail before dispatch unless the current service capability matrix reports
support from the configured provider.

The Python client still exposes the full Swift Kit helper surface:
`send_reaction`, `send_threaded_reply`, `send_edit`, `send_unsend`,
`send_typing`, and `send_message_effect` all use the same capability gate.

### Optional rich actions

`send_reaction`, `send_threaded_reply`, `send_edit`, `send_unsend`, `send_typing`, and `send_message_effect` use the same authenticated service and capability checks as `send_content`. Reaction removal is additive and keyword-only, preserving existing positional account arguments:

```python
from siriusmsg_sdk import SiriusMsgReaction, SiriusMsgReactionAction
result = await client.send_reaction(
    chat_id, message_id, SiriusMsgReaction.like,
    action=SiriusMsgReactionAction.removed,
)
```

These APIs do not install the optional provider. Check `capabilities()` for each action; the service also enforces current capabilities, chat permissions and exact targets. Treat `accepted=True` with `confirmationState="unconfirmed"` as dispatch acknowledgement, not recipient delivery. Health includes `richMessagingState`, `richMessagingFeatures`, `richMessagingRemediation` and the additive token-maintenance fields. Never log the credential returned by token rotation.


### Typing start and stop

Use the existing typing helper with `started` and `stopped`; no lease ID or claimed consumer identity belongs in the request. Check `sendTypingIndicator` in the current capability matrix first. The service binds ownership to the authenticated connection profile, and the chat's reply permission still applies.

The SIP-enabled native route currently requires explicit diagnostic opt-in and is not advertised by ordinary launches. In that route, repeated starts from the same owner/chat reuse the current operation without extending its five-second limit. A matching stop can wait for an in-flight start; a different owner/chat cannot stop it. A delayed repeat is rejected if its operation ended while authorization was pending. These are native-provider semantics, not a promise that every provider uses the same timeout.

An accepted, unconfirmed result does not prove that another device displayed or cleared a typing indicator. Do not convert it into a delivery receipt or automatically retry an unknown outcome. See [native typing ownership and evidence limits](local-protocol.md#native-typing-ownership-and-evidence-limits).


## Registered agent connections

Use the ID of an enabled connection registered in SiriusMsg to join its independent delivery queue:

```python
client = await SiriusMsgClient.connect(connection_id=registered_connection_id)
```

This matches Swift's `SiriusMsgClient.connect(connectionID:configuration:)`. The ID is not a credential and this call does not register or enable a connection. The SDK reads the owner-only token file and derives the connection credential using the shared protocol. It reloads and derives again for every new authenticated socket, including subscription reconnects after token rotation. Existing authenticated streams continue until disconnected or revoked. Never copy the primary token into adapter configuration or logs.

Omitting the connection ID retains the existing client behavior. A registered connection remains subject to its enabled state, chat permissions, attachment opt-in and service revocation. Persist handler progress before ACK; an ACK alone does not prove that a reply was confirmed.

### Send rejection versus uncertainty

Like Swift Kit, sends rejected for authentication, peer credentials, protocol version or invalid request return `accepted=false` and `confirmationState=notRequested`, with the service diagnostic. These are known rejections. Transport interruption or an internal failure remains an unknown outcome with the original operation ID; never turn that uncertainty into an automatic new send. A confirmed result is distinct from accepted dispatch.

### Sending a file

```python
result = await client.send_file(
    chat_id, "/path/to/report.pdf", "application/pdf",
    display_name="Report.pdf", operation_id="persisted-reply-file-id",
)
```

Pass an ordinary path on the Mac running SiriusMsg and the MIME type. The service checks access and file policy, reads the file, and stages a copy with its canonical size and hash. Callers do not construct staging directories or hashes. This is a local-file helper, not a VM upload. Keep the source unchanged until the initial request resolves. Reuse the same operation ID and arguments for a retry; a new ID can send a second file. `send_content(..., operation_id=...)` also accepts a stable ID. Unsupported types return a rejected result with an actionable diagnostic. Check `accepted` and `confirmationState`; a cached receipt can omit `resolvedContent` and is not another dispatch.
