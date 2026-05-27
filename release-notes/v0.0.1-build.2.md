<!-- sparkle-sign-warning:
IMPORTANT: This file is signed into the Sparkle appcast. Any modifications require re-running generate_appcast or sign_update before publishing.
-->
# SiriusMsg 0.0.1 (build 2)

First public DMG release for SiriusMsg.

## Included

- Signed macOS app and background login item.
- Local allowlist-gated Messages bridge.
- Read-only Messages store access.
- Messages.app send dispatch.
- App-owned Clear Review action for durable adapter queue maintenance.
- SwiftPython-backed hook and adapter runtime surface.
- GitHub Pages download site.

## Replacement Note

The original May 26 DMG asset was replaced on May 27 with a fresh notarized DMG
built from the same `0.0.1` build `2` version and corrected app metadata. The
replacement app bundle contains the release Sparkle public key, the stable
appcast URL, and the Adapters Clear Review maintenance action.

## Verification

- App notarization: accepted by Apple notary service.
- DMG notarization: accepted by Apple notary service.
- Gatekeeper: accepted as Notarized Developer ID.
- DMG image verification: valid.
- Public bundle scan: no private developer paths, private repository owner URLs, credential-shaped tokens, or Python bytecode caches.
- App maintenance surface: Adapters Clear Review moves blocked-review jobs to dead letters while preserving durable queue audit history.

SHA-256:

```text
0d8e4eb789719aa816520252a7b58fb9202c62603520034ab1388e3e522acbf0  SiriusMsg-notarized.dmg
```
