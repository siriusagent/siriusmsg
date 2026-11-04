# Connect Sirius

SiriusMsg build 25 adds a native Sirius connection. Use a Sirius version with
Connected Apps support, then open SiriusMsg → Connections → Add connection →
Sirius. Choose the workspace and chats, and approve SiriusMsg in Sirius →
Settings → Permissions & Security → Connected Apps.

SiriusMsg owns Messages access, chat permissions and reply confirmation. Sirius
owns the agent runtime, models, tools, approvals and persistent conversations.
The connection does not start another Sirius engine or move model credentials
into SiriusMsg.

Upgrading an existing Sirius channel waits for its worker to stop and preserves
conversation identities, permissions and review history. A busy turn must finish
first; uncertain worker ownership may require restarting Sirius. The old report
remains visible until the handover activates. Afterward, one registered Sirius
connection provides Connection, Permissions and Activity tabs, with access to
retained previous review items.

Choose which connection answers each chat in Shared with. New messages follow
that selection; accepted work retains its original reply owner. New messages can
continue after another item needs review. Discarding review items neither
repeats the model turn nor sends its old reply.

Updating the app does not automatically approve a new connection or replay old
Messages. Readiness, send confirmation and recipient delivery remain separate
facts. This remains an alpha release; the release notes state its qualification
limits.
