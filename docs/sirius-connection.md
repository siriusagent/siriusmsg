# Connect Sirius

Use a Sirius version with Connected Apps support. Open SiriusMsg → Connections →
Add connection → Sirius. Choose a workspace and the chats to share, then approve
SiriusMsg in Sirius → Settings → Permissions & Security → Connected Apps.
Add another connection for each additional workspace. Use **Repair access** on
a saved connection to restore access to that workspace.

SiriusMsg owns Messages access, chat permissions and reply confirmation. Sirius
owns the agent runtime, models, tools, approvals and persistent conversations.

Open a chat and look under **Shared with**. **Selected** marks the connection
that handles new messages. Click **Use** beside another connection to switch.
Switching back resumes the existing conversation in that workspace. Accepted
work retains its original reply owner and remains subject to the chat’s
current permissions.

Conversations shared with Sirius can use the group name or direct chat address
as a title. With Contacts access, SiriusMsg can use the matching contact name
for a shared direct chat.

On Sirius versions that support steering, a follow-up from the same sender can
interrupt and redirect an active turn in the same chat. Follow-ups apply in
Messages order. On older versions the messages queue as separate turns.

New messages can continue after another item needs review. Discarding the
review item does not rerun that turn or resend its old reply. Updating the app
does not automatically approve connections or replay old Messages.

This remains an alpha release. See the latest release notes for qualification
limits.
