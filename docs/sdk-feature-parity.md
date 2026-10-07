# SDK feature parity

SiriusMsgKit, the Python SDK and the TypeScript SDK expose the shared Messages
service. Developers can implement their own agent connection and UI without
writing Swift or reimplementing Messages access. SwiftPython additionally hosts
Python handlers inside the signed background agent.

There are two explicit API surfaces:

- `SiriusMsgClient` is the messaging client. Pass the registered connection UUID
  for independent subscriptions, cursors, scoped history, attachment grants and
  replies. Revocation and global sharing policy apply to every connection.
- `SiriusMsgAgentControlClient` is local-owner setup and administration. It uses
  the same owner-only Unix control socket and implementation as the app. It has
  no TCP/VM endpoint and is separate from the scoped client or MCP tools.

| Feature | Shared API |
| --- | --- |
| Receive new messages, reactions, edits, unsends and reply references | Messaging subscription and typed service events |
| Reconnect and acknowledge progress independently per connection | Registered client identity, subscribe/reconnect and ACK |
| Group/direct chat identity and allowlisted history/search | Allowed-chat listing, history pages and search |
| Receive images, documents, audio and video | Attachment opt-in, typed metadata and verified byte/file fetching |
| Send text, local files and rich links | Typed content sends and SDK convenience methods |
| Reactions/removal, threaded replies, edits, unsends, typing and effects | Typed rich-action sends, gated by current service capabilities |
| Confirmation, rejected/unknown outcomes and retry-safe operation IDs | Shared send result and operation contract |
| Global sharing and reply restrictions; token rotation | Owner messaging client allowlist update and token rotation |
| Create, inspect, edit, disable and remove connections | Control configuration snapshot and connection commands |
| Provider choice, rich feature toggles and explicit enablement | Control rich messaging configuration |
| Configure hosted Python package/handler, worker count, timeout and attachment support | Control Python adapter configuration; response states whether restart is required |
| App activity, adapter queue metrics/status and validation records | Control `readActivity`, using the app's shared activity projection |
| VM listener choice/export/probe and activity retention | Typed control commands |
| Process/signing health, FDA/Automation/Accessibility diagnostics | Typed control commands, executed in the agent |
| Clear blocked review and explicit recovery/validation checkpoints | Typed control commands |

All control commands and their nested results are included in the generated
Python/TypeScript models. `send(request)` exposes the full typed control surface,
including commands without a convenience wrapper. Golden frames cover every
control command and structured runtime/validation results.

## Connect an existing Python agent

First install/start SiriusMsg and explicitly share the intended chats. Run owner
setup in your trusted configuration flow; retain the returned connection UUID.

```python
from siriusmsg_sdk import SiriusMsgAgentControlClient, SiriusMsgClient

owner = SiriusMsgAgentControlClient()
configuration = await owner.read_configuration()
profile = await owner.create_connection("My agent", [selected_chat_id])
client = await SiriusMsgClient.connect(connection_id=profile.id)
```

Keep using the SDK subscription/send/ACK contract inside your existing Python
runtime. For long-running work, the reference runner in `examples/adapter.py`
uses your agent's durable job store. The SDK does not claim exactly-once agent
execution or automatically replay an uncertain reply. A hosted `siriusmsg`
Python handler uses SiriusMsgKit's durable runner instead.

TypeScript follows the same flow with `SiriusMsgAgentControlClient`,
`createConnection(...)` and `SiriusMsgClient.connect({ connectionID })`. In
Electron, use the SDK in the Node/main process rather than an untrusted renderer.

## Configure rich actions

Swift uses `SiriusMsgRichMessagingConfiguration` directly. Python and TypeScript
convenience setters translate native-provider enablement to the existing
`nativeEnabled` wire field. Raw control requests must preserve that field:
`enabled` belongs to the imsg provider and remains false for native Accessibility.
Setting configuration does not grant macOS permissions or certify feature
availability. Query messaging capabilities before exposing or dispatching an action.

## Product and verification boundaries

The app remains the installation, login-item registration, macOS permission and
update surface. Local Contacts presentation, appearance and window preferences
are app UI behavior; they do not change shared bridge metadata or chat grants.
The SDK control surface provides the same backend configuration, diagnostics and
recovery, with bounded requests and explicit mutation calls. It never bypasses
TCC, injects a helper, reads the Messages database in the consumer, or adds all-chats receive.

Control requests have one deadline, cancellation and a 1 MiB frame limit. They
are never automatically retried: a timeout can follow a completed mutation, so
inspect configuration/status before retrying. Saving a hosted Python adapter
requires an agent restart for activation; the response reports this explicitly.
The existing hosted adapter identity migration remains separate from external
registered SDK connections.

The parity tests use an isolated Swift service and fixture-owned send providers.
They prove SDK/control/protocol behavior without touching production Messages.
They are not signed live-send or release qualification.
