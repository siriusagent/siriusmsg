# @siriusmsg/sdk

Generated TypeScript types, Ajv validators, and a hand-written Node `net.Socket`
client for the SiriusMsg local service.

This package is Node-only because the SiriusMsg protocol uses Unix-domain sockets
or explicit loopback TCP, not HTTP. It does not read the Messages database, call
AppleEvents, use Keychain APIs, or control the app/agent lifecycle.

Full integration docs are in `docs/sdk-typescript.md`.

Development commands:

```bash
npm --prefix Packages/typescript/siriusmsg-sdk ci
npm --prefix Packages/typescript/siriusmsg-sdk run build
npm --prefix Packages/typescript/siriusmsg-sdk test
```
