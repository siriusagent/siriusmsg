# Local Protocol

The local protocol is the product integration boundary for agent stacks and third-party adapters.

Generated Python and TypeScript client packages live beside the protocol schema:

- [Python SDK](sdk-python.md): `Packages/python/siriusmsg-sdk`, imported as `siriusmsg_sdk`.
- [TypeScript SDK](sdk-typescript.md): `Packages/typescript/siriusmsg-sdk`, imported as `@siriusmsg/sdk` after building the package.

Both packages are generated from `Schema/siriusmsg-protocol-v1.schema.json` for
wire models and keep hand-written clients for auth, NDJSON transport, typed
errors, capability gating, ACKs, attachment fetches, and subscription handling.
They consume this local service boundary only; they are distinct from the
bundled SwiftPython hook SDK and do not read Messages databases or drive
Messages.app directly.

## Transport

The default transport is a Unix-domain socket at:

```text
~/Library/Application Support/SiriusMsg/siriusmsg.sock
```

The service uses newline-delimited JSON. Each line is one `SiriusMsgServiceRequest` or `SiriusMsgServiceResponse` encoded with `protocolVersion == 1`.

VM-access mode is off by default. When explicitly enabled, the service also binds a loopback TCP listener on `127.0.0.1` and uses the same newline-delimited JSON protocol and auth token. It must not bind non-loopback interfaces in v1.

## Auth

The first request on every connection must be `authenticate` with the token from:

```text
~/Library/Application Support/SiriusMsg/service-token.json
```

The token file and service runtime files are owner-only. Unauthenticated clients receive only a generic auth error. They cannot read health, subscribe, send, update allowlists, ACK, rotate the token, or receive events.

An authenticated client may send `rotateAuthToken` to atomically replace the token file. New connections must use the new token immediately after rotation. Connections that were already authenticated stay usable until they disconnect.

Valid tokens older than the configured stale threshold, 90 days by default, degrade health but do not expire automatically. Malformed or insecure token files remain startup-blocking.

Unix-domain socket clients must also pass same-UID Darwin peer credential checks before authentication is accepted. VM-access loopback TCP clients are token-only in v1 and exist only when VM access is explicitly enabled.

## VM Guest Discovery

VM v1 uses app-provisioned guest discovery, not network discovery. When VM access is enabled, the app/agent exports an owner-only `vm-access.json` for a user-selected shared guest path.

The guest config contains:

- `protocolVersion`
- `endpointHost`, always `127.0.0.1` in v1
- `endpointPort`
- `authToken`
- `tokenCreatedAt`
- `tokenStaleAfterDays`
- `generatedAt`
- `generatingBundleIdentifier`
- `generatingTeamIdentifier`

The app provisions and rotates the token through the existing local auth flow. Stronger VM auth, LAN binding, mDNS, multicast discovery, and hypervisor-specific discovery are out of protocol v1 unless validation proves a concrete gap.

## Requests

Supported request kinds:

- `authenticate`: opens the connection for subsequent requests.
- `rotateAuthToken`: replaces the local auth token for future connections.
- `health`: returns current service health.
- `capabilities`: returns the capability matrix for the requested transport, defaulting to the local Messages transport.
- `subscribe`: streams service events on the same connection.
- `ack`: acknowledges a delivered message event by `messageID`, `chatID`, and `rowID`.
- `send`: sends an allowlisted reply through Messages.app.
- `updateAllowlist`: replaces the current allowlist.
- `fetchAttachment`: returns a SiriusMsg-owned local file reference for a delivered attachment.

Malformed JSON, unsupported protocol versions, and missing payloads return structured errors instead of crashing the service.

`subscribe` accepts optional `subscriptionOptions`:

```json
{"supportsAttachments": true}
```

Missing options default to `supportsAttachments: false`. This is additive and does not change protocol version `1`.

`capabilities` accepts an optional top-level `transport`:

```json
{"kind":"capabilities","transport":"managedRelay"}
```

Omitting `transport` preserves the original local behavior. Provider transports are sibling matrices; requesting `messagesForBusiness` or `managedRelay` does not change Store polling, local Automation dispatch, or the active service transport.

## Rich Actions Opt-In

Plain text receive/reply clients do not need to change. Richer clients, including
`sirius-agent`, must opt in deliberately instead of pushing every action through
text.

The opt-in contract is:

- Call `capabilities(transport:)` before exposing rich actions for a transport.
- Use typed sends such as `sendAttachment(chatID:attachment:)` and `sendRichLink(chatID:richLink:)`.
- Treat `SiriusMsgClientError.unsupportedContent` as feature-gated. Do not retry unsupported reactions, effects, edits, unsends, typing, or cards as plain text.
- Subscribe with `subscriptionOptions.supportsAttachments == true` when the consumer can receive attachment metadata and fetch bytes.
- Handle inbound awareness events explicitly: `reaction`, `messageEdited`, `messageUnsent`, and `replyReference`.

The TypeScript and Python SDKs mirror the same shape with `capabilities(...)`,
typed helpers such as `sendRichLink` / `sendAttachment`, explicit attachment
subscription options, and unsupported-content errors. Existing text-only clients
remain valid; they simply do not receive attachment-bearing rows or richer
interaction handling unless they opt in.

## Capabilities And Rich Content

Protocol v1 exposes an additive capability matrix so clients can distinguish supported local behavior from provider-only or research-gated behavior before they attempt an action. The same matrix is available from `capabilities` responses and current `health` snapshots.

Each capability includes:

- `feature`: stable feature id such as `sendText`, `sendFile`, `sendRichLink`, `inboundReaction`, `sendReaction`, `miniAppCard`, or `applePayBusinessAction`.
- `transport`: `localMessagesAutomation`, `messagesForBusiness`, or `managedRelay`.
- `support`: `supported`, `receiveOnly`, `unsupported`, `researchGated`, `providerOnly`, `blocked`, or `degraded`.
- `proof`: evidence class such as `storeConfirmed`, `scriptingBridgeVerbAndStoreConfirmed`, `providerDocumented`, or `none`.
- `diagnosticCode`: stable machine-readable reason when unavailable.
- `evidenceNote` and optional `evidenceURL`: human review evidence.

The local transport supports inbound text, inbound attachment metadata, send text, send files, and URL-based rich links. Reactions, edits, unsends, and reply references are receive-only where Messages database evidence exists. Sending reactions, typing indicators, message effects, threaded replies, edits, and unsends is `researchGated` for the local transport unless a future signed implementation proves a native Messages automation verb. Mini-app cards and Apple Pay business actions are `providerOnly`; they require an explicitly selected provider transport and are not silently emulated by the local bridge.

`send` remains backward compatible with `text`. New clients may set `sendRequest.content`:

- `text`: local ScriptingBridge sends the text.
- `richLink`: local ScriptingBridge sends the URL string. Messages renders a preview when the destination exposes preview metadata. `generatedPreview` downgrades to `plain` unless a cards host is configured. When a cards host is configured, generated cards use a deterministic slug, static Open Graph HTML, and a separate `/go` redirect route for the human tap path; the generated card URL, title, and image URL must not carry secrets, query strings, fragments, credentials, localhost hosts, or `.local` hosts.
- `attachment`: the service copies the source file into owner-only SiriusMsg runtime storage, validates MIME and size, dispatches the staged file through Messages ScriptingBridge, and confirms by read-only attachment evidence when confirmation is enabled.

Unsupported content is rejected before Automation dispatch with `accepted: false` and a stable `diagnosticCode`; it is not converted into a misleading text fallback.

Kit exposes typed helpers for `sendText`, `sendAttachment`, `sendRichLink`, `sendReaction`, `sendThreadedReply`, `sendEdit`, `sendUnsend`, `sendTyping`, and `sendMessageEffect`. The helpers still negotiate against the active local matrix, so research-gated local sends fail before the request reaches Automation.

Release automation can stage static rich-link card artifacts for publication to a configured cards host. The cards host must serve the preview page as static HTML and publish a server-side `302` redirect for the human tap path. Publishing remains a release/update-host operation; the local bridge never edits a hosted repo directly.

## Attachments

Message events may contain text, image attachment metadata, document attachment metadata, or any combination of those. Bytes never ride the normal JSON event stream.

Attachment metadata is:

- `id`: stable attachment id, currently `m<messageRowID>-a<attachmentRowID>`.
- `kind`: `image` or `document`.
- `state`: `materialized`, `unsupportedType`, `tooLarge`, `unreadable`, or `failed`.
- `mimeType`: materialized MIME type. HEIC/HEIF image sources are materialized as PNG. Documents are copied verbatim.
- `displayName`: optional sanitized display name.
- `byteCount`: materialized byte count when available.
- `sha256`: materialized file hash when available.
- `width` and `height`: image dimensions when available. Document metadata leaves both fields empty.
- `diagnosticCode`: structured failure reason when materialization failed.

Metadata must not contain Apple attachment paths, raw database rows, participant metadata, AppleEvents handles, Keychain handles, or bytes. Supported image formats are JPEG, PNG, WebP, HEIC, and HEIF. Supported document MIME types are:

- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `application/vnd.openxmlformats-officedocument.presentationml.presentation`
- `application/msword`
- `application/vnd.ms-excel`
- `application/vnd.ms-powerpoint`
- `application/rtf`, `text/rtf`
- `text/plain`, `text/markdown`, `text/csv`, `text/html`
- `application/json`
- `application/xml`, `text/xml`

GIFs, stickers, and bridge-side document extraction are unsupported in this slice and surface as structured attachment metadata when attached to an otherwise deliverable row. Video and audio inbound rows remain unsupported unless a future fixture and app contract prove safe materialization.

Outbound file send is local but constrained. The service accepts the same document MIME families as inbound materialization plus common image formats, audio MIME types, and MP4/QuickTime video MIME types for dispatch. It stages the file under SiriusMsg-owned Application Support storage, never exposes the original source path to Automation, and still treats ScriptingBridge dispatch and Store confirmation as separate facts. Confirmed sends remove the staged file immediately; unconfirmed or confirmation-disabled sends keep it only until the configured cleanup TTL, 10 minutes by default.

`fetchAttachment` requires normal auth and same-UID Unix transport. It returns `attachmentFile` with metadata plus a local file path under:

```text
~/Library/Application Support/SiriusMsg/Attachments/<sha-prefix>/<sha>.<ext>
```

Kit clients should call `fetchAttachmentData(id:)` when they need bytes; it verifies `byteCount` and `sha256` before returning data. VM loopback fetch returns `attachmentTransportUnsupported` in this slice so host filesystem paths are not exposed to guest clients.

Attachment errors are structured: `attachmentNotDelivered`, `attachmentUnavailable`, `attachmentTransportUnsupported`, `attachmentHashMismatch`, `attachmentTooLarge`, and `attachmentUnsupportedType`.

## Delivery And Cursors

Inbound Messages are allowlist-gated before delivery. Events contain public `SiriusMsgServiceEvent` values only. They must not contain raw database rows, database handles, AppleEvents handles, Keychain handles, or private Messages metadata.

Event kinds are:

- `message`: a deliverable `SiriusMsgMessageEvent`; optional `replyToMessageID` identifies a read-only reply reference when the Messages schema exposes one.
- `reaction`: a sanitized tapback add/remove event with `targetMessageID`, `reaction`, and `action`.
- `messageEdited`: a sanitized edit marker with no message body.
- `messageUnsent`: a sanitized retraction marker with no message body.
- `replyReference`: a standalone reply reference event for clients that consume references separately from message delivery.
- `health`: service health publication.

SiriusMsg v1 has one active event subscriber. Additional authenticated clients may still read health, send, rotate tokens, and update configuration, but a second `subscribe` request receives `subscriptionAlreadyActive`.

Cursor advancement is ACK-based and connection-owned. The service does not persist progress for a delivered row until the same subscriber connection that received the event acknowledges the exact `messageID`, `chatID`, and `rowID`. ACKs from non-subscribers, other connections, stale deliveries, or duplicate ACKs receive `ackNotOutstanding` and do not advance the cursor. If a subscriber disconnects before ACK, the row remains eligible for redelivery after reconnect or service restart.

Attachment-bearing rows require an attachment-capable subscriber. If no active subscriber declared `supportsAttachments`, the service blocks that chat at the attachment row, publishes an attachments health component with `attachmentCapableSubscriberRequired`, does not send a partial message event, does not mark the row pending, and does not advance the cursor. Later rows for that chat, even text-only rows, do not pass the block. When an attachment-capable subscriber connects, the original row is delivered normally and cursor movement again depends on its ACK.

On first enable for an allowlisted chat with no existing cursor, the service initializes that chat at the current maximum row so historical Messages are not replayed by default.

Direct one-to-one SMS chats may be observed with or without a trailing `(smsft)` transport suffix, for example `SMS;-;+<phone>` and `SMS;-;+<phone>(smsft)`. Protocol v1 does not rewrite those strings, but the service treats them as equivalent only for direct delimiter `-` when enforcing allowlists, looking up cursors, initializing first-enable cursor state, resolving reply chats, and confirming outbound sends. Group delimiter `+` is not normalized, and this rule does not enable all-chats receive.

The allowlist is persisted at:

```text
~/Library/Application Support/SiriusMsg/allowlist.json
```

The service also holds an owner-only single-instance lock at:

```text
~/Library/Application Support/SiriusMsg/siriusmsg.lock
```

If another service instance already holds that lock, startup fails before the active socket is unlinked.

## Health

Health responses preserve the top-level `state` and `reason` fields, include `activeTransport`, include the current capability matrix, and include component health for the service lock, socket, auth token, allowlist persistence, cursor persistence, Messages database access, Automation readiness, VM listener, attachments, adapters, and hooks. Optional or not-yet-probed components report `notConfigured` rather than pretending to be healthy.

`activeTransport` is `localMessagesAutomation` in the default v1 service. The app surfaces a trust posture for each transport:

- `localMessagesAutomation`: local Mac private boundary.
- `messagesForBusiness`: Apple business-provider boundary.
- `managedRelay`: managed dedicated relay boundary.

The auth token component includes structured detail for token creation time, token age, and stale threshold. The socket component includes structured detail for Unix peer credential enforcement. The VM listener component includes endpoint, port, reachability, and last authenticated reachability probe time.

VM listener health states:

- `notConfigured`: VM access is disabled.
- `blocked`: VM access is enabled but the loopback TCP listener is not running or could not bind.
- `degraded`: VM access is enabled and bound, but no authenticated loopback TCP client has reached it.
- `healthy`: a loopback TCP client authenticated with the current token.

Health, errors, and diagnostics must not include message bodies. Message text is present only in deliverable message events.

## Kit Reconnect

`SiriusMsgKit` keeps `subscribe()` as a single-shot stream. `subscribe(reconnectPolicy: .default)` opts into reconnecting behavior: reconnect, authenticate, resubscribe, back off, and rely on service redelivery for any rows that were delivered but not ACKed.

## Generic Adapter Runner

`SiriusMsgAdapterRunner` is the reusable Kit boundary for agent stacks and third-party adapters. It does not change protocol version `1`; it composes existing `subscribe`, `send`, and `ack` operations.

Direct mode ACKs only after the adapter handler completes cleanly and any required reply send is resolved. Handler failures, retry decisions, rejected replies, and unconfirmed replies do not ACK. Dead-letter decisions are terminal and ACK.

Durable mode ACKs only after the adapter commits the event into its encrypted SQLite turn queue. After that commit, the adapter queue owns long-running turn durability through unique jobs, leases, retry scheduling, max-attempt failure, dead letters, and blocked-review states.

Durable queues are adapter-owned state under:

```text
~/Library/Application Support/SiriusMsg/Adapters/<adapterID>/turn-queue.sqlite
```

The app reads only adapter metadata from:

```text
~/Library/Application Support/SiriusMsg/Adapters/<adapterID>/status.json
```

Clearing a stale review blocker is an app-owned maintenance command, not a manual JSON edit. The app opens the existing durable queue, moves `blockedReview` jobs to `deadLetter`, then rewrites `status.json` from queue metrics so the audit trail remains durable.

Message bodies must not appear in status files, health, errors, logs, or diagnostics. They are permitted only inside encrypted durable queue payloads while needed for processing.

## Recipes

`SiriusMsgRecipeRunner` is a Kit-level integration facade for app-owned recipes and agent UX. It is not part of Store or Automation. Recipes consume sanitized trigger events, including inbound messages, reactions, edits, unsends, schedules, and webhooks; they require explicit allowlist approval before any outbound action; and they reuse normal `SiriusMsgContent` sends for text, attachments, and rich links.

Recipe execution is loop-safe by default: bridge-generated trigger events are skipped with `recipeLoopGuarded`. Non-allowlisted chats are skipped with `recipeChatNotAllowlisted`. Unsupported actions are skipped using the same capability diagnostics as direct sends. Recipe run results do not carry message bodies.

When a recipe emits an adapter envelope, the signed agent routes that envelope through the hosted adapter path as `ctx.recipe`. The payload contains recipe id/name, trigger, integration, required capabilities, action kinds, and the sanitized trigger event. It does not include action payloads, message bodies, raw database rows, AppleEvents handles, Keychain handles, or service auth.

The signed agent owns the first runtime slice. It loads `recipes.json` from the shared owner-only runtime directory, drives the runner from inbound message, reaction, edit, and unsend events, and hot-reloads recipe file changes without restart. `schedule` and `webhook` are recipe trigger types, but this slice does not start a scheduler or local webhook listener, so the app reports those recipes as not running yet.

## Backpressure

Each subscriber has a bounded outstanding event count. The default limit is 128. A subscriber that exceeds the limit receives a structured `backpressure` error and is disconnected. The service remains alive.
