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

Token age is a maintenance signal, not expiry. At or beyond the configured threshold (90 days by default), `authToken.state` remains `degraded` for compatibility. Its detail includes `tokenAgeDays`, `tokenStaleAfterDays`, and additive optional fields `tokenMaintenanceDue: true`, `tokenAuthenticationAvailable: true`, and `tokenRemediation: "rotateAuthToken"`. Authentication continues to work. Consumers must inspect individual components before describing messaging as unavailable. Old clients can continue decoding the existing state and age fields; new clients must tolerate absent remediation fields from older services.

The native Settings → Security maintenance section offers **Rotate token**; the Chats maintenance warning opens it through **Review**, with progress and explicit completion or recovery instructions. The app authenticates using Kit, rotates, opens a fresh local client, and requests health to verify the warning cleared. Neither the token nor the rotation response belongs in UI, diagnostics, logs, or reports. The protocol retains the secret-bearing rotation response for existing authenticated clients only.

A token-file write failure leaves the previous on-disk and in-memory token active. After a successful commit, `vmExportsRefreshed` in the rotation result is `true` if enabled VM exports were refreshed, `false` if export repair is needed, or absent if VM access is disabled. Export failure is a successful rotation with incomplete VM maintenance, not a failed token replacement. The VM component then explains the repair: export again from Advanced and securely replace guest copies. Canonical `vm-access.json` and export destinations registered with the current service process are refreshed. Detached copies and custom destinations from prior service runs require explicit re-export; no service can update a disconnected guest copy.

Kit clients created with `connect(configuration:)` reload the token file after authentication rejection. Python and TypeScript clients created with `connect` reload their configured token file before each new connection, including subscription reconnects. Explicit-token/VM clients must reload a newly provisioned guest export or accept the new credential through their secure configuration channel. Existing authenticated streams are not disconnected by rotation.

Downstream Sirius should consume the additive maintenance fields (or fall back to age >= threshold for older services), report "token maintenance due; authentication available" with actual age/threshold, and direct users to SiriusMsg Settings → Security → Rotate token. It must not equate this component alone with a failed adapter or unavailable messaging. The inspected Sirius connector already uses the token-file-backed `connect(configuration:)` route (`SiriusIMessageChannelCoordinator.swift`). Its snapshot mapper currently forwards age and threshold but needs to forward the new maintenance/authentication/remediation fields as well. A cached explicit-token integration requires reload on reconnect. No downstream Sirius source is changed by this release.


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
- `listAllowedChats`: lists only chats admitted by the service's current persisted allowlist.
- `readHistory`: reads a newest-first page from one currently allowed chat.
- `searchHistory`: searches message text within currently allowed chats.
- `updateAllowlist`: replaces the current allowlist; an omitted or null `replyDeniedChatIDs` preserves the existing reply restriction set.
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

## Allowed History

History is an authenticated, bounded query surface over the same read-only Store used for inbound delivery. Clients cannot provide a replacement allowlist. For every request, the service supplies its current app-managed allowlist to Store, and Store resolves allowed database chat rows before it reads message bodies. An empty allowlist returns an empty result without opening the Messages database.

`listAllowedChats` accepts optional `allowedChatQuery.searchText` and a `limit` from 1 through 100. Search covers sanitized chat metadata, not message bodies. `readHistory` accepts `historyRead.chatID`, optional `beforeRowID`, and a 1-through-100 `limit`. `searchHistory` accepts a non-empty query, optional chat IDs that may only narrow the current allowlist, optional `beforeRowID`, and a 1-through-100 `limit`.

Chat discovery's `serviceName` describes the latest known ordinary message transport, with stored chat metadata as a fallback when no message service is available. It is presentation and search metadata, not recipient capability or delivery confirmation. Service sorting and page cursors use that same value. The stored chat metadata still resolves `chatID`; a display label change never rewrites chat identity, sharing policy, or cursors.

History pages are newest-first and return `nextBeforeRowID` for cursor paging. Rows use sanitized public message models and may include text, `textTruncated`, public identifiers, author display name, direction, timestamps, group status, reply reference, and attachment count. Attachment-only messages remain visible with empty text. Individual bodies and aggregate page text are byte-bounded before protocol encoding; callers must inspect `textTruncated`. They never include raw database rows, Apple attachment paths, attachment bytes, database handles, AppleEvents handles, or Keychain handles. Tapbacks, edit artifacts, unsends, truly empty rows, and delivery-error rows are excluded from ordinary history messages.

A handle-only allowlist entry authorizes only a one-to-one chat for that handle. It never widens a group chat; group history requires the group chat ID itself to be allowed.

History queries do not alter inbound ACK cursors and do not replay historical events to subscribers.

## Send Idempotency

`sendRequest.operationID` is the stable identity of one intended send. `SiriusMsgKit` assigns a UUID when a caller omits it; protocol clients that omit it use the enclosing `requestID`. Retrying the same operation ID with the same payload returns the persisted body-free result without another Automation dispatch. Reusing an operation ID with a different payload returns `sendOperationConflict`.

The service writes an owner-only `send-operations.json` preparation record before dispatch. If a process interruption or sender error leaves dispatch outcome uncertain, later retries return `sendOperationUnresolved` and do not dispatch again. Uncertainty starts at the dispatch boundary: policy and permission outcomes are recorded as completed rejections, and a failure while preparing the request (attachment reads, staging, or target checks) leaves no tombstone, so the same operation ID may be retried with the real error repeated instead of an uncertain result. Prepared and unresolved tombstones are never pruned; if they fill the fixed ledger capacity, new operation IDs fail closed. Completed-result caching uses a fixed-size, seven-day window. The ledger contains SHA-256 operation-ID hashes, SHA-256 request fingerprints, state, timestamps, and sanitized results only; it does not persist caller-supplied operation IDs, message text, chat IDs, attachment paths, or resolved content. Recovery from a full ledger is an explicit operator action; uncertain sends must never be blindly replayed.

When a client generates an operation ID and loses the response, it surfaces that ID in a typed unknown-outcome error. Retry only with that same ID. Swift reports `SiriusMsgClientError.sendOutcomeUnknown`, Python reports `SiriusMsgSendOutcomeUnknownError`, and TypeScript reports `SiriusMsgSendOutcomeUnknownError`. MCP returns the generated `operation_id` in an error result.

## Reply text presentation

`sendRequest.textFormat` optionally selects `markdown` or `plain`. With this
field absent, a text send carrying `adapterReplyTo` is treated as an assistant
Markdown reply; an ordinary text send remains literal. `plain` explicitly opts
out, including for adapter replies. This behavior applies to every registered
connection, independent of its agent implementation. It only transforms text
content; files, attachments and explicit rich-action content retain their own
contracts.

Presentation happens in Service after authorization, before dispatch. The
assistant transcript and original request fingerprint retain the source. The
renderer uses Foundation CommonMark parsing, preserves code and URL targets,
renders headings, paragraphs, nested lists, block quotes and tables, and emits
bounded nonoverlapping UTF-16 style ranges. The delivery text has no Markdown
emphasis delimiters or link wrappers. Native styles are bold, italic and
strikethrough where Markdown supplies them; code keeps its literal characters
and whitespace. This does not invent monospace or Unicode lookalike fonts.

Style ranges are used only for iMessage when a ready, explicitly enabled provider
implements `SiriusMsgFormattedTextSending` and reports `sendFormattedText`.
Wire clients can inspect the string-valued automation detail
`richMessagingFeatures` for that readiness marker. The legacy v1 capability
matrix continues to advertise `sendText`, without adding a new enum value to
every health event; existing clients with closed feature enums keep decoding.
Older configurations with no feature list retain their original six actions;
formatting requires explicit selection and is never enabled by migration.
The bundled imsg 0.15.1 contract supports `send.rich` with `text_formatting`;
readiness also requires its existing v2 bridge, registry and `sendMessage`
selector. Unknown versions do not claim formatting. SiriusMsg never launches
or injects the private bridge to make this capability available. The standard
ScriptingBridge sender and the current native Accessibility provider do not
carry styles, so those paths send the readable rendered text. SMS uses the same
readable fallback. Enabling reactions or effects does not imply formatting.

Provider, feature and reply permissions are rechecked after readiness and before
mutation. A provider that loses readiness before any mutation may report the
distinct `unavailableBeforeDispatch` disposition, allowing the service to
reauthorize reply access and choose the standard sender. Generic errors never
authorize that fallback. Delivery selects one path before dispatch; an error, cancellation,
lost response or timeout after rich dispatch never triggers a second plain send.
Read-only Store confirmation matches the rendered body. This confirms delivery
of that body, not recipient-side rendering of style attributes. Native style
appearance still requires a real recipient check. Markdown source, rendered
bodies and raw targets are not added to diagnostics or operation-ledger records.

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
- `attachment`: the service copies the source file into a dedicated SiriusMsg handoff directory under Pictures, validates MIME and size, dispatches the staged file through Messages ScriptingBridge, and confirms by read-only attachment evidence when confirmation is enabled.

Unsupported content is rejected before Automation dispatch with `accepted: false` and a stable `diagnosticCode`; it is not converted into a misleading text fallback.

Kit exposes typed helpers for `sendText`, `sendAttachment`, `sendRichLink`, `sendReaction`, `sendThreadedReply`, `sendEdit`, `sendUnsend`, `sendTyping`, and `sendMessageEffect`. The helpers still negotiate against the active local matrix, so research-gated local sends fail before the request reaches Automation.

The repository includes `Scripts/generate-rich-link-card.sh` for release/build automation that stages static card artifacts under `.build/rich-link-cards/` by default. It writes `index.html`, `manifest.json`, and `redirect.json` for publication to the configured cards host. `Scripts/verify-rich-link-card-artifact.sh` verifies the static artifact locally and, with `SIRIUSMSG_VERIFY_HOSTED_RICH_LINK_CARD=1`, verifies the published preview page plus server-side `302` `/go` redirect. The cards host must serve the preview page as static HTML and publish the `redirect.json` route as a server-side `302` to the destination URL. Publishing remains a release/update-host operation; the local bridge never edits a hosted repo directly.

## Attachments

Message events may contain text, image attachment metadata, document attachment metadata, or any combination of those. Bytes never ride the normal JSON event stream.

Attachment metadata is:

- `id`: stable attachment id, currently `m<messageRowID>-a<attachmentRowID>`.
- `kind`: `image` or `document`. Audio/video retain the non-image `document` wire kind for existing clients; use `mimeType` to select playback or model handling.
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

GIFs, stickers, and bridge-side document extraction are unsupported in this slice and surface as structured attachment metadata when attached to an otherwise deliverable row. Inbound MP3, M4A/MP4 audio, WAV, MP4 video and QuickTime video are materialized as file bytes with their MIME types. Materialization does not imply that a downstream model can interpret or transcribe the media. Signed recipient/model consumption remains a separate integration check.

Outbound file send is local but constrained. The service accepts the same document MIME families as inbound materialization plus common image formats, audio MIME types, and MP4/QuickTime video MIME types for dispatch. It stages the file in a UUID directory under `~/Pictures/SiriusMsg Outbound Attachments`, never exposes the original source path to Automation, and treats ScriptingBridge dispatch and Store confirmation as separate facts. Staged files remain available to Messages until the configured cleanup TTL, 10 minutes by default, including confirmed sends. Explicit isolated diagnostics may select a separate validated Pictures test directory.

`fetchAttachment` requires normal auth and same-UID Unix transport. It returns `attachmentFile` with metadata plus a local file path under:

```text
~/Library/Application Support/SiriusMsg/Attachments/<sha-prefix>/<sha>.<ext>
```

Kit clients should call `fetchAttachmentData(id:)` when they need bytes; it verifies `byteCount` and `sha256` before returning data. Fetch while the message event is outstanding: the connection's delivery metadata keeps a delivered attachment's chat only until that message is acknowledged, so a later fetch for an already-acknowledged message returns `attachmentNotDelivered`. VM loopback fetch returns `attachmentTransportUnsupported` in this slice so host filesystem paths are not exposed to guest clients.

The SiriusMsg-owned attachment store is a delivery cache, not an archive. A delivered attachment is claimed by the connection or primary client that received it, released when that message is acknowledged, and the copied bytes plus their registry record are deleted ten minutes after the last delivery once nothing claims them. Nothing is retained longer than seven days without a new delivery, so a claim that was never acknowledged cannot pin user data. Files materialized for rows that were filtered out before delivery are collected by the same sweep. A redelivery refreshes the window, which is what keeps a slow reconnect able to fetch what it was just sent. Codex connection staging is bounded the same way: staged media is kept within a per-directory byte budget (most recent first) and completed turn receipts are collected after thirty days, while receipts that may describe dispatched work are never collected implicitly.

Attachment errors are structured: `attachmentNotDelivered`, `attachmentUnavailable`, `attachmentTransportUnsupported`, `attachmentHashMismatch`, `attachmentTooLarge`, and `attachmentUnsupportedType`.

## Delivery And Cursors

Inbound Messages are allowlist-gated before delivery. Events contain public `SiriusMsgServiceEvent` values only. They must not contain raw database rows, database handles, AppleEvents handles, Keychain handles, or private Messages metadata.

Event kinds are:

- `message`: a deliverable `SiriusMsgMessageEvent`; optional `replyToMessageID` identifies a read-only reply reference when the Messages schema exposes one. When the schema contains `thread_originator_guid`, it is authoritative: an empty value means no thread. The legacy `reply_to_guid` projection is used only when the entire thread column is absent; on modern Messages it also contains ordinary sequential-message context and must not be treated as a thread fallback. The wire field remains optional for older clients and databases.
- `reaction`: a sanitized tapback add/remove event with `targetMessageID`, `reaction`, and `action`.
- `messageEdited`: a sanitized edit marker with no message body.
- `messageUnsent`: a sanitized retraction marker with no message body.
- `replyReference`: a standalone reply reference event for clients that consume references separately from message delivery.
- `health`: service health publication.

Each authenticated registered consumer has one active event subscription and independent persisted delivery/ACK progress. Different registered consumers may subscribe concurrently. Legacy primary-token clients share one compatibility subscription identity; a second subscription for the same identity receives `subscriptionAlreadyActive`. Primary-token clients retain their existing owner operations.

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

The same-UID native agent control command `setVMAccessEnabled` takes required-for-that-command `vmAccessEnabled: true | false`. It changes only the loopback listener: local authenticated connections, adapter tasks and cursor state remain active. Disabling stops new VM connections and closes existing VM sessions. Binding or preference-write failure preserves the previous listener choice.

The choice persists in owner-only `vm-listener-preference.json`, **separate from the existing `vm-access.json` guest export**. An enabled restart refreshes the canonical export with the new bound port; re-enabling also refreshes known exports. Disabling retains the export file but its listener is closed. Copies held by guests still need replacement when their endpoint or credential changes. Existing enable/export and probe control commands use the same listener mutation rather than restarting the full service. Explicit recovery checks can still restart the service as their test requires. This control command is not added to the public MCP request surface.

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

`SiriusMsgRecipeRunner` is a Kit-level integration facade for app-owned recipes and agent UX. It is not part of Store or Automation. The public recipe models, the runner, the adapter `ctx.recipe` envelope, and the `reloadRecipes` control command remain Codable for one release so older clients and SDKs decode cleanly. Recipe run results, when produced, do not carry message bodies.

**Recipes are disabled in this build.** The signed agent does not instantiate the runner, does not install a recipe event observer, does not load or watch `recipes.json`, and does not hot-reload. Existing `recipes.json` files are ignored and never rewritten or deleted. The `reloadRecipes` control command is kept Codable but rejected with a structured "Recipes are disabled in this build." response. Health reports `recipeRuntime = nil`. The app does not present a Recipes surface. Loop-safety, allowlist, and capability diagnostics described above are the runner's own invariants, retained for the preserved Kit facade; they are not exercised by the agent in this build.

When a recipe emits an adapter envelope, the facade routes that envelope through the hosted adapter path as `ctx.recipe`. The payload contains recipe id/name, trigger, integration, required capabilities, action kinds, and the sanitized trigger event. It does not include action payloads, message bodies, raw database rows, AppleEvents handles, Keychain handles, or service auth. In this build that path is unreachable because no recipes run.

## Backpressure

Each subscriber has a bounded outstanding event count. The default limit is 128. A subscriber that exceeds the limit receives a structured `backpressure` error and is disconnected. The service remains alive.

### Optional rich actions

An explicitly configured local imsg bridge can execute reaction, reply, edit, unsend, typing, and effect content. See [setup, privacy boundaries, and evidence limits](market-and-rich-messaging.md). Default native behavior is unchanged when disabled. Additive automation health detail returns `richMessagingState`, `richMessagingFeatures`, and `richMessagingRemediation`. Provider acceptance alone remains `unconfirmed`. With confirmation enabled, Service additionally checks read-only Store evidence for threaded replies, edits, unsends, standard reaction desired state and message effects before returning `confirmed`; typing retains unconfirmed dispatch semantics.

For replies, confirmation requires a unique new outbound row with exact text and the requested thread parent. For edits, it requires the same owned target row, a newer edit marker and exact replacement text. For unsends, it requires a newer retraction timestamp or a newly retracted sole original part on that same owned target. A retraction of only one part of a multi-part message is insufficient. Baselines are captured before dispatch; prior state, wrong chats, duplicate target GUIDs and failed-delivery rows cannot confirm an operation. Missing schema/evidence or a timeout leaves the result unconfirmed without resending. Reaction confirmation requires the exact target and current own standard tapback state in its chat and part zero. An already-satisfied add/remove request is a no-op: it is reauthorized and confirmed without opening or toggling Messages. Other senders, failed rows and other parts do not establish that state; unknown/custom tapbacks remain unavailable for native toggling. For effects, confirmation requires a unique fresh own-message row in the exact chat, matching text, no thread parent, no delivery error, and the exact `expressive_send_style_id` for the requested known effect. Plain text, a different effect, missing schema, unknown names and ambiguous matches cannot confirm an effect. These checks establish persisted local Messages state, not recipient read status. Existing Kit/Python/TypeScript result fields are unchanged; downstream clients should consume `confirmationState` instead of assuming all rich actions are unconfirmed.


### Native typing ownership and evidence limits

The SIP-enabled native provider supports the existing `typing` content with `started`/`stopped` when enabled in saved Rich Messaging settings and current process access passes inspection. Clients must discover `sendTypingIndicator` support rather than infer it from SDK helper availability or a saved enablement preference.

Service mints a process-local operation context from its instance, provider generation and authenticated registered-consumer ID. Registered consumers have separate ownership; primary-token clients share primary authority. Reconnection with the same registered identity preserves that scope within a generation. Neither a display name nor an arbitrary request field grants ownership. Service stop and provider changes invalidate the retained authorization callback.

Native started resolves an allowlisted, exact Store-validated chat anchor, observes its own composer change locally, then returns an accepted/unconfirmed result with no platform message ID. A retained task holds exclusive composer ownership until stop or five seconds after its last accepted heartbeat, subject to authorization callback timing. Same-owner/chat repeated starts renew the lease without posting another key. Stop reaches an in-flight start and removes only a continuously verified owned sentinel. Different owners/chats are rejected. A repeated start whose captured operation ended while awaiting authorization is rejected; cancelling a repeated request does not stop the original operation.

Revocation and cancellation terminate the hold. Its separate cleanup receipt can confirm restoration without treating the interrupted action as successful. Changed human input is never cleared; uncertain restoration remains an unknown outcome. Local observation, expiry and cleanup do not establish recipient indicator state. Signed start/stop and timeout tests have independent recipient observations recorded in the native typing evidence. Sustained recipient visibility during renewed agent turns remains a separate live gate.

Swift consumers use `sendTyping(chatID:state:accountID:)`; Python uses `send_typing(chat_id, state, account_id)` and TypeScript uses `sendTyping(chatID, state, accountID)`. The wire model is unchanged. Downstream Sirius must use the same registered identity for its foreground client and durable runner, respect per-feature capabilities and permissions, and retain the distinction between unconfirmed dispatch and recipient evidence. No downstream code is changed here.

## Per-chat reply permission

`SiriusMsgAllowlist.replyDeniedChatIDs` is an optional set of chat IDs. Incoming sharing still follows `chatIDs`/`handleIDs`. A denied chat remains readable when otherwise allowed, but Service rejects outbound replies and rich actions with `accepted: false` and `diagnosticCode: "replyNotAllowed"` before dispatch. Service rechecks permission after work that suspends during preparation.

Older stored payloads decode with no reply denials. On `updateAllowlist`, omission or `null` means **leave the existing reply policy unchanged**, so an older client cannot accidentally erase restrictions chosen in the app. An explicit empty array clears the denial set. Direct SMS transport aliases use the same matching semantics as the allowlist. Failed persistence rolls back the policy and initialized cursors.

Operational log entries may include optional `chatReference`, a domain-separated SHA-256 correlation key. Native activity uses this key, never a redacted identifier suffix, to associate an event with local chat metadata. Older entries without the key remain readable and are not guessed into a chat. The key does not contain message text or a raw identifier; it is not an authentication credential.

## Registered MCP connections

Native connection profiles live in the owner-only `connections/connections.json` registry. Each has a UUID, user-supplied display name, enabled state, incoming/read permission, reply permission, and excluded chat IDs. A name is not authenticated application identity. Profiles contain no token. Their scopes can only narrow the global explicit-chat allowlist; handle-only grants are not expanded for registered clients.

`SiriusMsgClient.connect(connectionID:configuration:)` derives the connection credential with HMAC-SHA256 from the current primary token and the domain-separated UUID. The existing `authenticate` envelope is unchanged. Service binds the authenticated writer to the matching enabled profile. Copyable MCP configuration passes `--connection <UUID>` and `--runtime-directory <path>` to the bundled helper, never a token. The helper and token file must remain accessible only within the trusted local account boundary.

Registered clients support health, capabilities, scoped chat/history reads, reply-policy-checked sends, subscriptions, ACKs and consumer-scoped Unix attachment fetches. They cannot rotate tokens or edit the global allowlist. A first subscription initializes current Store cursors; later subscriptions resume that consumer’s persisted pending/acknowledged progress. Newly added chat cursors initialize before scanning. Queue pressure and socket writes are independent across consumers. Attachment grants persist consumer/chat association and fetch rechecks current scope. Existing primary-token clients retain their compatibility identity and protocol behavior. Automatic-turn adapters and downstream Sirius must migrate both their foreground client and their separate durable runner to the same registered identity before the app can claim revocable adapter authority. Matching a display name is insufficient.

Policy is rechecked for each request and after suspended send preparation. Disabling/removing a profile rejects new authentication; the app's health refresh closes revoked registered sessions, and an existing session's next request also checks revocation. Primary-token rotation leaves existing authenticated connections intact, while registered Kit clients reload the primary file and rederive their credentials when reconnecting. There is no second secret file to replace.

Kit returns `accepted: false` for explicit pre-dispatch authentication/protocol/permission rejections. Transport failures where dispatch is uncertain continue to return `sendOutcomeUnknown`; callers must not blindly retry those sends.

## Private native Activity

Operational send entries can include optional `connectionID`, bound by Service to the authenticated registered profile. Older entries omit it and remain readable. A supplementary owner-only `activity.json` stores only event kind, UUID, time, optional connection UUID and hashed chat reference for connection lifecycle and successfully shared inbound events. It has no text/diagnostic/handle/token/display-name field. Incoming event types remain distinguishable; a failed delivery is not labeled shared. Both stores reuse the same bounded persistence implementation (300 entries each by default). Configurable time retention is not implemented by this slice.

The native app merges these sources once, sorts by time with stable UUID tie-breaking, and filters by attention, connection and chat. Chat names resolve only from currently allowed local metadata; removed chats display as private. Removed registered profiles retain an anonymous “Removed connection” label. Legacy primary-token traffic remains a generic local integration. Export writes the filtered metadata projection, omitting diagnostic text, user labels and raw identifiers. Send request, dispatch and confirmation remain separate lifecycle facts; dispatch must not appear as confirmation.


### Messages attachment roots in isolated runtimes

Messages database paths beginning with the configured Messages attachment location resolve against the Store's configured Messages attachment root. They do not inherit a diagnostic process's isolated `HOME`. Normalized paths must remain inside that configured root; other home-relative paths and parent-directory escapes are rejected. Materialized bytes are copied into the SiriusMsg-owned attachment store and verified by the clients.

### Native typing lifecycle

The native typing route retains a bounded, authenticated typing lease. If a user changes its temporary draft, cleanup preserves that draft and the interrupted operation remains uncertain. A fresh authorized start can recover after inspection proves the composer is empty; it never erases the changed draft to recover. Service shutdown awaits owned lease cleanup before process exit. Start/stop receipts remain unconfirmed: the runtime cannot observe the recipient, even when a separate live test has visual evidence.

### File convenience APIs

Kit provides `sendFile(chatID:fileURL:mimeType:displayName:accountID:operationID:)`; Python provides `send_file`, and TypeScript provides `sendFile`. These preserve the existing attachment wire shape and capability checks. The helpers send the local file URL and MIME type with placeholder size/hash; the authorized service computes the canonical metadata while staging. The client does not receive additional filesystem privileges. Pass a stable operation ID for durable retries, keep the source unchanged through the initial request, and inspect the returned acceptance/confirmation state. A cached body-free operation result need not repeat attachment metadata.

### Native typing heartbeat lifecycle

For the enabled native provider, a repeated typing `started` request from the same
authenticated consumer and chat renews its active lease. Renewal rechecks service
authorization and composer ownership. The lease expires five seconds after the
last accepted heartbeat; `stopped`, cancellation, ownership loss and revocation
still trigger the existing bounded cleanup rules. An expired or stopping lease
cannot be renewed. This is dispatch/cleanup behavior, not recipient telemetry.

Native renewal and managed Kit/Python/TypeScript scopes have contract coverage.
Kit runners manage the scope around handlers; custom Python and TypeScript
adapters can follow the bundled examples. Sustained recipient-visible validation
is still pending; the earlier notarized build predates renewal.
