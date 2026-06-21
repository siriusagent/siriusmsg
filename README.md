# SiriusMsg

SiriusMsg is a signed macOS app and background agent that bridges Apple Messages
to AI agents through a local, allowlist-gated service. Install the app, allow
only the conversations you choose, then integrate your agent through the local
protocol SDKs in this repository.

## Download

Download the latest notarized DMG from:

```text
https://github.com/siriusagent/siriusmsg/releases/latest/download/SiriusMsg-notarized.dmg
```

The latest release page is:

```text
https://github.com/siriusagent/siriusmsg/releases/latest
```

## Requirements

- macOS 15 or later
- Apple Messages configured on the Mac
- Full Disk Access for SiriusMsg when prompted
- Automation permission for SiriusMsg to send through Messages.app

## Privacy Model

SiriusMsg starts with no chats allowed. You choose the conversations that agents
can receive.

SiriusMsg reads local Messages data read-only, sends through Messages.app, and
keeps adapter integrations behind the signed app and agent boundary. The app and
agent should not log message bodies, expose raw database rows to adapters, or
offer an all-chats mode in v1.

## SDK

Public integration surfaces in this repository:

- [Local protocol](docs/local-protocol.md): authenticated newline-delimited JSON
  over the signed app's Unix-domain socket, or explicit loopback VM endpoint
  when VM access is enabled.
- [Python SDK](docs/sdk-python.md): `Packages/python/siriusmsg-sdk`, imported
  as `siriusmsg_sdk`.
- [TypeScript SDK](docs/sdk-typescript.md): `Packages/typescript/siriusmsg-sdk`,
  imported as `@siriusmsg/sdk`.
- [Python adapter SDK](docs/python-adapter-sdk.md): the app-hosted `siriusmsg`
  hook package shape for async handler authors.
- [Sirius Agent integration pattern](docs/sirius-agent-integration.md), a
  concrete reference for handing SiriusMsg events to an agent runtime

SDK consumers receive sanitized events and return adapter decisions. SiriusMsg
keeps Messages permissions, service auth, cursor progress, ACK policy, reply
sending, and send confirmation inside the signed app and agent boundary.

Install the Python SDK from a checkout:

```sh
python3 -m pip install -e "Packages/python/siriusmsg-sdk"
```

Install and build the TypeScript SDK from a checkout:

```sh
npm --prefix Packages/typescript/siriusmsg-sdk ci
npm --prefix Packages/typescript/siriusmsg-sdk run build
```

For Swift-native apps, use `SiriusMsgKit` through partner access. Agent runtimes
should integrate through the public local protocol with the Python and
TypeScript SDKs above.

## Verify Download

```sh
shasum -a 256 SiriusMsg-notarized.dmg
```

Compare the output with the checksum printed in the matching GitHub Release
notes.

## Security

Report security issues through the process in [SECURITY.md](SECURITY.md).
Do not file public issues containing message bodies, chat identifiers, auth
tokens, local database files, crash logs with private payloads, or other
sensitive local data.
