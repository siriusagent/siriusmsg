# @siriusmsg/sdk

The SDK exposes messaging plus typed local-owner setup and diagnostics through
`SiriusMsgAgentControlClient`, using the same control API as SiriusMsg.app.
See [the feature matrix](../../../Docs/sdk-feature-parity.md) for connection
management, rich feature settings, activity, recovery and verification scope.

Generated TypeScript types, Ajv validators, and a hand-written Node `net.Socket`
client for the SiriusMsg local service.

This package is Node-only because the SiriusMsg protocol uses Unix-domain sockets
or explicit loopback TCP, not HTTP. Owner administration uses only the local
control socket. Neither client reads the Messages database, calls AppleEvents or uses
Keychain APIs. The signed app handles installation, login-item registration,
macOS permission prompts and updates.

Full integration docs are in `Docs/sdk-typescript.md`.

Development commands:

```bash
Scripts/generate-sdks.sh --check
npm --prefix Packages/typescript/siriusmsg-sdk ci
npm --prefix Packages/typescript/siriusmsg-sdk run format:check
npm --prefix Packages/typescript/siriusmsg-sdk run build
npm --prefix Packages/typescript/siriusmsg-sdk test
```

### Typing during reply preparation

Typing is opt-in. The reference adapter prepares and sends replies without this
scope, so deferred typing support cannot delay a turn or its text reply.

```typescript
const reply = await client.withTypingIndicator(chatID, () => agent.prepareReply(incoming), { signal });
await client.sendText(chatID, reply);
```

Prepare text and files inside the callback and send them after the scope returns.
The scope checks capabilities, renews every two seconds, and stops before return,
on callback failure, or when the optional AbortSignal aborts. In-flight renewals
finish before stop, preventing a late restart. Typing is advisory: an
unavailable, rejected, uncertain or failing start or stop allows normal
preparation and never throws, so dispatch the prepared reply through the normal
path, which keeps its own target, permission and confirmation checks. An
aborted signal still aborts the callback. The native server expires the lease
five seconds after its last accepted heartbeat.
