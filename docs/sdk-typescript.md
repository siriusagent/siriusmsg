# TypeScript SDK

For the complete messaging, setup, diagnostics and recovery surface, see
[SDK feature parity](sdk-feature-parity.md). Local-owner controls use
`SiriusMsgAgentControlClient`; ordinary agent delivery uses a registered
`SiriusMsgClient` connection.

The TypeScript package lives at `Packages/typescript/siriusmsg-sdk` and publishes
as `@siriusmsg/sdk`. It is a Node-only package for the SiriusMsg local service
protocol.

The package shares the native service boundary:

- Generated TypeScript definitions come from
  `Schema/siriusmsg-protocol-v1.schema.json`.
- Ajv validates request and response frames at the socket boundary.
- A safe-integer guard rejects message and chat cursor row IDs that cannot
  round-trip through JavaScript numbers.
- The client uses Node `net.Socket` with the authenticated Unix-domain socket,
  or explicit loopback VM endpoint when VM access is enabled.
- Owner setup, diagnostics and recovery use the same local control API as the app.
- The signed app handles installation, login items, macOS permission prompts and
  updates; neither SDK client reads the Messages database, calls AppleEvents or uses Keychain APIs.

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
wire frames, and `json-schema-to-typescript` regenerates `src/_models.ts`.
The generated schema is copied into the package as `src/_schema.json` for Ajv.
Hand-written files provide transport, auth, typed errors, capability gating, and
convenience helpers.

## Install For Development

```bash
npm --prefix Packages/typescript/siriusmsg-sdk ci
npm --prefix Packages/typescript/siriusmsg-sdk run format:check
npm --prefix Packages/typescript/siriusmsg-sdk run build
npm --prefix Packages/typescript/siriusmsg-sdk test
```

The live test starts `SiriusMsgSDKHarness`, a fake SiriusMsg service backed by
repo Swift code. It does not touch Apple Messages.

## Allowed History And Retry-Safe Sends

`listAllowedChats()`, `readHistory()`, and `searchHistory()` use the service's current app-managed allowlist. A client can narrow a search with chat IDs but cannot widen access. History is newest-first and cursor-paged with `nextBeforeRowID`; it does not modify subscription ACK cursors.

`send()` assigns an operation ID when absent. For an application-level retry, pass a stable `operationID` on `SiriusMsgSendRequest` and reuse that request. The service returns the cached body-free result for an identical retry and fails closed for conflicting or uncertain operations.

If transport fails after `send()` generates an ID, it throws `SiriusMsgSendOutcomeUnknownError`. Read `error.operationID` and reuse it for any retry; generating a new ID could create a second intended send.

## Basic Client

```ts
import { SiriusMsgClient } from "@siriusmsg/sdk";

const client = await SiriusMsgClient.connect();
const health = await client.health();
console.log(health.state);

for await (const event of client.subscribe({ supportsAttachments: false })) {
  if (!event.message) continue;

  await client.sendText(event.message.chatID, `received: ${event.message.id}`);
  await client.ack({
    messageID: event.message.id,
    chatID: event.message.chatID,
    rowID: event.message.rowID,
  });
}
```

ACKs should be sent on the same subscription client that received the event.
Rows are not durably advanced until the service accepts the ACK.
With `reconnect: true`, the client retries socket transport interruptions only;
authentication and other service errors fail immediately so callers can repair
credentials or configuration instead of entering a retry loop.

`fetchAttachmentData()` reads the service-provided file and verifies both its
declared byte count and SHA-256 digest before returning bytes. Local corruption
raises `AttachmentSizeMismatchError` or `AttachmentHashMismatchError`; both
identify the requested attachment without exposing its filesystem path.

## Agent adapter

The tested [reference runner](../Packages/typescript/siriusmsg-sdk/examples/adapter.ts) keeps text and every attachment in one handler invocation, fetches verified file bytes, sends text/files with stable operation IDs, and ACKs only after durable completion.

```ts
import { SiriusMsgClient } from "@siriusmsg/sdk";
import { run } from "./adapter.js";

const client = await SiriusMsgClient.connect({ connectionID });
await run(client, durableHandler, connectionID);
```

Supply the `DurableHandler` interface using your agent's existing job store. Its completion lookup prevents repeated handling after ACK loss. Its preparation method must persist a reply before returning and return the same reply on replay. Preserve prepared output files unchanged until sends resolve. Its completion method commits successful handling before the runner ACKs. This interface belongs to the consuming adapter; it is not an existing Sirius API or a second database supplied by this example.

An unavailable/corrupt attachment stops processing before the handler or ACK. Rejected and unconfirmed replies stop for review; network uncertainty preserves the SDK's operation ID. The runner does not infer successful delivery or retry with a new ID. Durable preparation alone does not guarantee exactly-once model execution if a process crashes before committing the model result.

This runner handles incoming message events. A consumer supporting edit, unsend or reaction events must route those typed events separately; they are not new text turns.

For a handler that stores attachment references instead of loading files, pass `"references"` as the fourth argument to `run`. Each attachment arrives as `{ metadata, data: null }`; `null` means not fetched, not an empty file. Metadata retains MIME type, ID, availability state and diagnostics. The default `"bytes"` mode fetches and verifies every file before calling the handler. Both modes opt into the existing attachment subscription contract, without changing legacy clients.

A text-only handler can render its own attachment label and keep the ID for a fetch tool. It must identify the content as an attachment it has not read. IDs require authenticated, allowed access and are not permanent public links. If the job requires the file later, copy verified bytes into the consumer's managed storage before committing completion; retaining a reference alone is not a durable copy of the file. Do not ACK a required fetch that failed.

## Claws Tool Shape

Claws can expose a normal async tool that delegates to the local service:

```ts
import { SiriusMsgClient } from "@siriusmsg/sdk";

export async function sendMessage(chatID: string, text: string): Promise<boolean> {
  const client = await SiriusMsgClient.connect();
  const result = await client.sendText(chatID, text);
  return result.accepted;
}
```

For receive workflows, keep a long-lived subscription worker and pass sanitized
`SiriusMsgServiceEvent` values into Claws. Do not pass raw database rows,
AppleEvents handles, Keychain handles, or original attachment filesystem paths.

```ts
import { SiriusMsgClient } from "@siriusmsg/sdk";

export async function runClawsMessageWorker(dispatch: (event: unknown) => Promise<void>) {
  const client = await SiriusMsgClient.connect();

  for await (const event of client.subscribe({ supportsAttachments: true })) {
    if (event.kind === "reaction" || event.kind === "messageEdited" || event.kind === "messageUnsent") {
      await dispatch({ source: "siriusmsg", awareness: event.kind, event });
      continue;
    }

    if (!event.message) continue;
    await dispatch({ source: "siriusmsg", event });
    await client.sendRichLink(event.message.chatID, {
      kind: "plain",
      title: "Open in Claws",
      url: "https://cards.bestbyteai.com/claws",
    });
    await client.ack({
      messageID: event.message.id,
      chatID: event.message.chatID,
      rowID: event.message.rowID,
    });
  }
}
```

## Rich Content And Capability Honesty

Always use the SDK helpers or check capabilities before exposing a content type
in an agent UI:

```ts
import { SiriusMsgClient, UnsupportedContentError } from "@siriusmsg/sdk";

const client = await SiriusMsgClient.connect();

try {
  await client.sendReaction(chatID, targetMessageID, "like");
} catch (error) {
  if (error instanceof UnsupportedContentError) {
    // This connection does not currently advertise reaction support.
  }
}
```

The local transport supports text, staged file sends, and URL rich links.
Reactions, typing indicators, message effects, edits, unsends, threaded reply
sends, mini-app cards, and Apple Pay actions are not silently emulated as text.
They fail before dispatch unless the current service capability matrix reports
support from the configured provider.

The TypeScript client still exposes the full Swift Kit helper surface:
`sendReaction`, `sendThreadedReply`, `sendEdit`, `sendUnsend`, `sendTyping`, and
`sendMessageEffect` all use the same capability gate.

### Optional rich actions

`sendReaction`, `sendThreadedReply`, `sendEdit`, `sendUnsend`, `sendTyping`, and `sendMessageEffect` use the same authenticated service and capability checks as `sendContent`. Reaction removal is an optional fifth argument, preserving existing account arguments:

```typescript
const result = await client.sendReaction(chatID, messageID, "like", undefined, "removed");
// The lower-level reactionContent(messageID, "like", "removed") builder also supports removal.
```

These APIs do not install the optional provider. Check `capabilities()` for each action; the service also enforces current capabilities, chat permissions and exact targets. `accepted: true` with `confirmationState: "unconfirmed"` is dispatch acknowledgement, not recipient delivery. Health includes `richMessagingState`, `richMessagingFeatures`, `richMessagingRemediation` and the additive token-maintenance fields. Never log the credential returned by token rotation.


### Typing start and stop

Use the existing typing helper with `started` and `stopped`; no lease ID or claimed consumer identity belongs in the request. Check `sendTypingIndicator` in the current capability matrix first. The service binds ownership to the authenticated connection profile, and the chat's reply permission still applies.

The SIP-enabled native route currently requires explicit diagnostic opt-in and is not advertised by ordinary launches. In that route, repeated starts from the same owner/chat reuse the current operation without extending its five-second limit. A matching stop can wait for an in-flight start; a different owner/chat cannot stop it. A delayed repeat is rejected if its operation ended while authorization was pending. These are native-provider semantics, not a promise that every provider uses the same timeout.

An accepted, unconfirmed result does not prove that another device displayed or cleared a typing indicator. Do not convert it into a delivery receipt or automatically retry an unknown outcome. See [native typing ownership and evidence limits](local-protocol.md#native-typing-ownership-and-evidence-limits).


## Registered agent connections

Use the ID of an enabled connection registered in SiriusMsg to join its independent delivery queue:

```typescript
const client = await SiriusMsgClient.connect({ connectionID: registeredConnectionID });
```

This matches Swift's `SiriusMsgClient.connect(connectionID:configuration:)`. The ID is not a credential and this call does not register or enable a connection. The SDK reads the owner-only token file and derives the connection credential using the shared protocol. It reloads and derives again for every new authenticated socket, including subscription reconnects after token rotation. Existing authenticated streams continue until disconnected or revoked. Never copy the primary token into adapter configuration or logs.

Omitting the connection ID retains the existing client behavior. A registered connection remains subject to its enabled state, chat permissions, attachment opt-in and service revocation. Persist handler progress before ACK; an ACK alone does not prove that a reply was confirmed.

### Send rejection versus uncertainty

Like Swift Kit, sends rejected for authentication, peer credentials, protocol version or invalid request return `accepted=false` and `confirmationState=notRequested`, with the service diagnostic. These are known rejections. Transport interruption or an internal failure remains an unknown outcome with the original operation ID; never turn that uncertainty into an automatic new send. A confirmed result is distinct from accepted dispatch.

### Sending a file

```ts
const result = await client.sendFile(chatID, "/path/to/report.pdf", "application/pdf", {
  displayName: "Report.pdf",
  operationID: "persisted-reply-file-id",
});
```

Pass an ordinary path on the Mac running SiriusMsg and the MIME type. The service authorizes, validates, reads, stages and hashes the file. No caller-built hashes or staging directories are needed. This is a local-file helper, not a VM upload. Keep the source unchanged until the initial request resolves. Reuse the same operation ID and arguments for a retry. `sendContent(chatID, content, accountID, operationID)` also accepts a stable ID. Unsupported types return a rejected result with an actionable diagnostic. Check `accepted` and `confirmationState`; cached receipts may omit `resolvedContent` and do not indicate a second dispatch.
