# SiriusMsg

SiriusMsg is a signed macOS app and background agent that bridges Apple Messages
to AI agents through a local, allowlist-gated service.

This public repository is for release distribution:

- GitHub Pages website
- notarized DMG downloads through GitHub Releases
- release notes and checksums
- security and install information

The development source repository is private. This repository should not contain
source code, signing material, Apple credentials, private service tokens, local
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

Build 2 update note: this first public DMG must be updated by downloading a
newer DMG from GitHub Releases. It does not receive in-app Sparkle updates.
Subsequent public builds must pass the release-DMG Sparkle key audit before
publication.

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

The website documents the current consumer surfaces:

- `SiriusMsgKit` for Swift clients that connect to the authenticated local service
- bundled `siriusmsg` Python adapter package for async handler authors
- local protocol boundary for non-Swift clients
- [Sirius Agent integration pattern](docs/sirius-agent-integration.md), a
  sanitized reference for wiring an agent runtime without publishing private
  Sirius internals

SDK consumers receive sanitized events and return adapter decisions. SiriusMsg
keeps Messages permissions, service auth, cursor progress, ACK policy, reply
sending, and send confirmation inside the signed app and agent boundary.

## Release Files

Each public release should include:

- `SiriusMsg-notarized.dmg`
- `SiriusMsg-notarized.dmg.sha256`
- release notes
- appcast metadata for builds that support Sparkle updates

Verify the checksum after download:

```sh
shasum -a 256 SiriusMsg-notarized.dmg
```

Compare the output with `SiriusMsg-notarized.dmg.sha256` from the same release.

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
