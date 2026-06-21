# SiriusMsg

SiriusMsg is a signed macOS app and background agent that bridges Apple Messages
to AI agents through a local, allowlist-gated service.

This public repository is for release distribution:

- GitHub Pages website
- notarized DMG downloads through GitHub Releases
- release notes and checksums
- security and install information
- public local-protocol schema, golden frames, SDK packages, and integration docs

The signed app, agent, Store, Automation, and release-signing source live in the
private development repository. This public repository may contain SDK client
source and protocol fixtures, but it must not contain private app or agent
source, signing material, Apple credentials, private service tokens, local
database files, or generated operational evidence from a developer machine.

## Download

Download the latest notarized DMG from:

```text
https://github.com/siriusagent/siriusmsg/releases/latest/download/SiriusMsg-notarized.dmg
```

The latest release page is:

```text
https://github.com/siriusagent/siriusmsg/releases/latest
```

The `latest` links resolve to the current notarized public release. Older build
replacement notes are kept on their historical GitHub Release pages, not in this
top-level README.

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
  sanitized reference for wiring an agent runtime without publishing private
  Sirius internals

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

The Swift client library, `SiriusMsgKit`, is part of the signed app and private
source tree today. Public Swift package publication is separate from this repo
update; non-Swift consumers should use the Python or TypeScript SDKs above.

## Release Files

Each public release should include:

- `SiriusMsg-notarized.dmg`
- release notes
- appcast metadata for Sparkle updates

Verify the checksum after download:

```sh
shasum -a 256 SiriusMsg-notarized.dmg
```

Compare the output with the checksum printed in the matching GitHub Release
notes or appcast publication notes.

## Website

The GitHub Pages site is stored in `site/` and deployed by the Pages workflow.

Local preview:

```sh
python3 -m http.server 4173 -d site
```

Open:

```text
http://127.0.0.1:4173/
```
