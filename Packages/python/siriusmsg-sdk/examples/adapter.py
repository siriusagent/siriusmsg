"""Reference runner; the consuming agent supplies its existing durable job store."""

from __future__ import annotations

import hashlib
import json
from contextlib import aclosing
from dataclasses import dataclass
from typing import Literal, Protocol

from siriusmsg_sdk import (
    SiriusMsgAttachmentMetadata,
    SiriusMsgClient,
    SiriusMsgMessageEvent,
    SiriusMsgReconnectPolicy,
    SiriusMsgServiceAck,
    text_content,
)


@dataclass(frozen=True, repr=False)
class ReplyFile:
    path: str
    mime_type: str
    display_name: str | None = None


@dataclass(frozen=True, repr=False)
class Reply:
    text: str | None = None
    files: tuple[ReplyFile, ...] = ()


class DurableHandler(Protocol):
    async def is_complete(self, key: str) -> bool: ...

    async def prepare(
        self,
        key: str,
        message: SiriusMsgMessageEvent,
        attachments: list[tuple[SiriusMsgAttachmentMetadata, bytes | None]],
    ) -> Reply:
        """Commit the reply before returning; replay returns that same reply."""
        ...

    async def complete(self, key: str) -> None:
        """Durably record that handling and all required sends completed."""
        ...


class ReplyNeedsReview(RuntimeError):
    def __init__(self, operation_id: str) -> None:
        self.operation_id = operation_id
        super().__init__(f"Reply requires review; operation ID {operation_id}")


def operation_id(*parts: str) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


async def run(
    client: SiriusMsgClient,
    handler: DurableHandler,
    connection_key: str,
    *,
    attachment_mode: Literal["bytes", "references"] = "bytes",
) -> None:
    """Use a stable, non-secret connection key (normally the registered profile ID)."""
    if attachment_mode not in ("bytes", "references"):
        raise ValueError("attachment_mode must be bytes or references")
    async with aclosing(
        client.subscribe(
            supports_attachments=True,
            reconnect_policy=SiriusMsgReconnectPolicy.default,
        )
    ) as events:
        async for event in events:
            if event.message is None:
                continue
            message = event.message
            key = operation_id(connection_key, message.chatID.root, message.id.root)
            if not await handler.is_complete(key):
                # None explicitly means bytes were not fetched, never an empty file.
                # References retain state/diagnostics, including unavailable media.
                attachments = [
                    (item, await client.fetch_attachment_data(item.id) if attachment_mode == "bytes" else None)
                    for item in message.attachments
                ]
                reply = await handler.prepare(key, message, attachments)
                if reply.text:
                    operation = operation_id(key, "text")
                    result = await client.send_content(message.chatID, text_content(reply.text), operation_id=operation)
                    if not result.accepted or result.confirmationState.value != "confirmed":
                        raise ReplyNeedsReview(operation)
                for index, file in enumerate(reply.files):
                    operation = operation_id(key, "file", str(index))
                    result = await client.send_file(
                        message.chatID,
                        file.path,
                        file.mime_type,
                        display_name=file.display_name,
                        operation_id=operation,
                    )
                    if not result.accepted or result.confirmationState.value != "confirmed":
                        raise ReplyNeedsReview(operation)
                await handler.complete(key)
            await client.ack(SiriusMsgServiceAck(messageID=message.id, chatID=message.chatID, rowID=message.rowID))
