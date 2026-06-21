# TypeScript SDK

The TypeScript package lives at `Packages/typescript/siriusmsg-sdk` and imports
as `@siriusmsg/sdk` after building the package. It is a Node-only package for
the SiriusMsg local service protocol.

The package is intentionally narrow:

- Generated TypeScript definitions come from
  `Schema/siriusmsg-protocol-v1.schema.json`.
- Ajv validates request and response frames at the socket boundary.
- A safe-integer guard rejects `rowID` values that cannot round-trip through
  JavaScript numbers.
- The client uses Node `net.Socket` with the authenticated Unix-domain socket,
  or explicit loopback VM endpoint when VM access is enabled.
- It does not read the Messages database, call AppleEvents, use Keychain APIs,
  install login items, or manage the SiriusMsg app/agent lifecycle.

## Install From This Repository

The package is source-published in this repository. From a checkout:

```sh
npm --prefix Packages/typescript/siriusmsg-sdk ci
npm --prefix Packages/typescript/siriusmsg-sdk run build
```

Then import it from the built package in your Node integration or package it
with your normal npm workflow.

The generated types in `src/_models.ts` are produced by the release pipeline
and committed here with the matching schema and golden frames.

## Test From This Repository

```sh
npm --prefix Packages/typescript/siriusmsg-sdk run build
npm --prefix Packages/typescript/siriusmsg-sdk test
```

The tests validate the committed schema/golden frames, capability gating, and
client behavior against local fake protocol servers. They do not touch Apple
Messages.

## Basic Client

```ts
import { SiriusMsgClient } from "@siriusmsg/sdk";

const client = await SiriusMsgClient.connect();
const health = await client.health();
console.log(health.state);

for await (const event of client.subscribe({ supportsAttachments: true })) {
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

## Sirius-agent Adapter Shape

Sirius-agent should consume the local protocol through this package instead of
reading Messages databases or driving Messages.app itself:

```ts
import { SiriusMsgClient } from "@siriusmsg/sdk";

export async function runSiriusAgentBridge(agent: {
  run(input: { text: string; metadata: Record<string, string> }): Promise<{ reply?: string }>;
}) {
  const client = await SiriusMsgClient.connect();

  for await (const event of client.subscribe({ supportsAttachments: true })) {
    if (!event.message) continue;

    const result = await agent.run({
      text: event.message.text ?? "",
      metadata: {
        source: "siriusmsg",
        chat_id: event.message.chatID,
        message_id: event.message.id,
      },
    });
    if (result.reply) {
      await client.sendText(event.message.chatID, result.reply);
    }
    await client.ack({
      messageID: event.message.id,
      chatID: event.message.chatID,
      rowID: event.message.rowID,
    });
  }
}
```

The adapter owns agent retry and dead-letter policy. It should ACK only after its
handler and any required reply send have resolved.

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
    // Local Messages automation does not support sending reactions in v1.
  }
}
```

The local transport supports text, staged file sends, and URL rich links.
Reactions, typing indicators, message effects, edits, unsends, threaded reply
sends, mini-app cards, and Apple Pay actions are not silently emulated as text.
They fail before the request reaches Automation unless a future capability matrix
reports a supported transport.

The TypeScript client still exposes the full Swift Kit helper surface:
`sendReaction`, `sendThreadedReply`, `sendEdit`, `sendUnsend`, `sendTyping`, and
`sendMessageEffect` all use the same capability gate.
