"""Hand-written Python client mirroring SiriusMsgKit."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import AsyncIterator, Optional

from siriusmsg_sdk._models import (
    SiriusMsgAllowlist,
    SiriusMsgAttachmentFetchRequest,
    SiriusMsgAttachmentFileReference,
    SiriusMsgAttachmentID,
    SiriusMsgAuthTokenRotationResult,
    SiriusMsgCapability,
    SiriusMsgCapabilitySupport,
    SiriusMsgChatID,
    SiriusMsgContent,
    SiriusMsgContentKind,
    SiriusMsgFeature,
    SiriusMsgHealth,
    SiriusMsgImageRef,
    SiriusMsgEditContent,
    SiriusMsgMessageEffectContent,
    SiriusMsgOutboundAttachment,
    SiriusMsgReaction,
    SiriusMsgReactionAction,
    SiriusMsgReactionContent,
    SiriusMsgReconnectPolicy,
    SiriusMsgReplyContent,
    SiriusMsgRichLink,
    SiriusMsgSendRequest,
    SiriusMsgSendResult,
    SiriusMsgServiceAck,
    SiriusMsgServiceEvent,
    SiriusMsgServiceRequest,
    SiriusMsgServiceResponse,
    SiriusMsgSubscriptionOptions,
    SiriusMsgTransport,
    SiriusMsgTypingState,
    SiriusMsgUnsendContent,
)
from siriusmsg_sdk._transport import (
    DEFAULT_SOCKET_PATH,
    DEFAULT_TOKEN_PATH,
    PROTOCOL_VERSION,
    Endpoint,
    NDJSONConnection,
    load_auth_token,
    request_id,
)
from siriusmsg_sdk.errors import (
    AttachmentHashMismatchError,
    AttachmentUnavailableError,
    SiriusMsgSDKError,
    SiriusMsgTransportError,
    UnsupportedContentError,
    error_from_service,
)

UNSUPPORTED_LOCAL_DIAGNOSTIC = "unsupportedByLocalMessagesAutomation"


def text_content(text: str) -> SiriusMsgContent:
    return SiriusMsgContent(kind=SiriusMsgContentKind.text, text=text)


def rich_link_content(rich_link: SiriusMsgRichLink) -> SiriusMsgContent:
    return SiriusMsgContent(kind=SiriusMsgContentKind.richLink, richLink=rich_link)


def attachment_content(attachment: SiriusMsgOutboundAttachment) -> SiriusMsgContent:
    return SiriusMsgContent(kind=SiriusMsgContentKind.attachment, attachment=attachment)


def reaction_content(
    target_message_id: str,
    reaction: SiriusMsgReaction,
    action: SiriusMsgReactionAction = SiriusMsgReactionAction.added,
) -> SiriusMsgContent:
    return SiriusMsgContent(
        kind=SiriusMsgContentKind.reaction,
        reaction=SiriusMsgReactionContent(targetMessageID=target_message_id, reaction=reaction, action=action),
    )


def reply_content(target_message_id: str, text: str) -> SiriusMsgContent:
    return SiriusMsgContent(
        kind=SiriusMsgContentKind.reply,
        reply=SiriusMsgReplyContent(targetMessageID=target_message_id, text=text),
    )


def edit_content(target_message_id: str, replacement_text: str) -> SiriusMsgContent:
    return SiriusMsgContent(
        kind=SiriusMsgContentKind.edit,
        edit=SiriusMsgEditContent(targetMessageID=target_message_id, replacementText=replacement_text),
    )


def unsend_content(target_message_id: str) -> SiriusMsgContent:
    return SiriusMsgContent(
        kind=SiriusMsgContentKind.unsend,
        unsend=SiriusMsgUnsendContent(targetMessageID=target_message_id),
    )


def message_effect_content(text: str, effect_name: str) -> SiriusMsgContent:
    return SiriusMsgContent(
        kind=SiriusMsgContentKind.messageEffect,
        messageEffect=SiriusMsgMessageEffectContent(text=text, effectName=effect_name),
    )


class SiriusMsgClient:
    def __init__(self, endpoint: Endpoint, auth_token: str) -> None:
        self._endpoint = endpoint
        self._auth_token = auth_token
        self._subscription_connection: NDJSONConnection | None = None
        self._subscription_reader_task: asyncio.Task[None] | None = None
        self._subscription_events: asyncio.Queue[SiriusMsgServiceEvent | BaseException] | None = None
        self._subscription_pending: dict[str, asyncio.Future[SiriusMsgServiceResponse]] = {}
        self._subscription_write_lock = asyncio.Lock()

    @classmethod
    async def connect(
        cls,
        *,
        socket_path: str | Path = DEFAULT_SOCKET_PATH,
        token_path: str | Path = DEFAULT_TOKEN_PATH,
    ) -> "SiriusMsgClient":
        client = cls(Endpoint.unix(socket_path), load_auth_token(token_path))
        await client.health()
        return client

    @classmethod
    def loopback(cls, *, port: int, auth_token: str) -> "SiriusMsgClient":
        return cls(Endpoint.loopback(port), auth_token)

    async def health(self) -> SiriusMsgHealth:
        response = await self._perform("health")
        if response.kind.value != "health" or response.health is None:
            raise SiriusMsgTransportError("unexpected health response")
        return response.health

    async def capabilities(
        self,
        transport: SiriusMsgTransport = SiriusMsgTransport.localMessagesAutomation,
    ) -> list[SiriusMsgCapability]:
        response = await self._perform("capabilities", transport=transport)
        if response.kind.value != "capabilities" or response.capabilities is None:
            raise SiriusMsgTransportError("unexpected capabilities response")
        return response.capabilities

    async def send(self, request: SiriusMsgSendRequest) -> SiriusMsgSendResult:
        response = await self._perform("send", sendRequest=request)
        if response.kind.value != "sendResult" or response.sendResult is None:
            raise SiriusMsgTransportError("unexpected send response")
        return response.sendResult

    async def send_content(
        self,
        chat_id: str | SiriusMsgChatID,
        content: SiriusMsgContent,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        await self._check_supported(content)
        return await self.send(
            SiriusMsgSendRequest(
                chatID=_chat_id(chat_id),
                text=_fallback_text(content),
                accountID=account_id,
                content=content,
            )
        )

    async def send_text(self, chat_id: str | SiriusMsgChatID, text: str, account_id: Optional[str] = None) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, text_content(text), account_id)

    async def send_rich_link(
        self,
        chat_id: str | SiriusMsgChatID,
        rich_link: SiriusMsgRichLink,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, rich_link_content(rich_link), account_id)

    async def send_attachment(
        self,
        chat_id: str | SiriusMsgChatID,
        attachment: SiriusMsgOutboundAttachment,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, attachment_content(attachment), account_id)

    async def send_reaction(
        self,
        chat_id: str | SiriusMsgChatID,
        target_message_id: str,
        reaction: SiriusMsgReaction,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, reaction_content(target_message_id, reaction), account_id)

    async def send_threaded_reply(
        self,
        chat_id: str | SiriusMsgChatID,
        target_message_id: str,
        text: str,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, reply_content(target_message_id, text), account_id)

    async def send_edit(
        self,
        chat_id: str | SiriusMsgChatID,
        target_message_id: str,
        replacement_text: str,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, edit_content(target_message_id, replacement_text), account_id)

    async def send_unsend(
        self,
        chat_id: str | SiriusMsgChatID,
        target_message_id: str,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, unsend_content(target_message_id), account_id)

    async def send_typing(
        self,
        chat_id: str | SiriusMsgChatID,
        state: SiriusMsgTypingState,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, SiriusMsgContent(kind=SiriusMsgContentKind.typing, typing=state), account_id)

    async def send_message_effect(
        self,
        chat_id: str | SiriusMsgChatID,
        text: str,
        effect_name: str,
        account_id: Optional[str] = None,
    ) -> SiriusMsgSendResult:
        return await self.send_content(chat_id, message_effect_content(text, effect_name), account_id)

    async def update_allowlist(self, allowlist: SiriusMsgAllowlist) -> None:
        response = await self._perform("updateAllowlist", allowlist=allowlist)
        if response.kind.value != "allowlistUpdated":
            raise SiriusMsgTransportError("unexpected allowlist response")

    async def rotate_auth_token(self) -> SiriusMsgAuthTokenRotationResult:
        response = await self._perform("rotateAuthToken")
        if response.kind.value != "authTokenRotated" or response.authTokenRotationResult is None:
            raise SiriusMsgTransportError("unexpected token rotation response")
        self._auth_token = response.authTokenRotationResult.token
        return response.authTokenRotationResult

    async def ack(self, ack: SiriusMsgServiceAck) -> None:
        if self._subscription_connection is not None:
            request = SiriusMsgServiceRequest(
                protocolVersion=PROTOCOL_VERSION,
                requestID=request_id("ack"),
                kind="ack",
                ack=ack,
            )
            response_future = asyncio.get_running_loop().create_future()
            async with self._subscription_write_lock:
                self._subscription_pending[request.requestID] = response_future
                try:
                    await self._subscription_connection.write(request)
                except BaseException:
                    self._subscription_pending.pop(request.requestID, None)
                    if not response_future.done():
                        response_future.cancel()
                    raise
            response = await response_future
            self._raise_if_error(response)
            if response.kind.value != "acked":
                raise SiriusMsgTransportError("unexpected ack response")
            return
        response = await self._perform("ack", ack=ack)
        if response.kind.value != "acked":
            raise SiriusMsgTransportError("unexpected ack response")

    async def fetch_attachment(self, attachment_id: str | SiriusMsgAttachmentID) -> SiriusMsgAttachmentFileReference:
        response = await self._perform(
            "fetchAttachment",
            attachmentFetch=SiriusMsgAttachmentFetchRequest(attachmentID=_attachment_id(attachment_id)),
        )
        if response.kind.value != "attachmentFile" or response.attachmentFile is None:
            raise SiriusMsgTransportError("unexpected attachment response")
        return response.attachmentFile

    async def fetch_attachment_data(self, attachment_id: str | SiriusMsgAttachmentID) -> bytes:
        file_ref = await self.fetch_attachment(attachment_id)
        path = Path(file_ref.localFilePath)
        try_data = path.read_bytes()
        if len(try_data) != file_ref.metadata.byteCount:
            raise AttachmentUnavailableError("attachment byte count does not match")
        if file_ref.metadata.sha256 and hashlib.sha256(try_data).hexdigest() != file_ref.metadata.sha256:
            raise AttachmentHashMismatchError("attachment hash does not match")
        return try_data

    async def subscribe(
        self,
        *,
        reconnect_policy: SiriusMsgReconnectPolicy = SiriusMsgReconnectPolicy.none,
        supports_attachments: bool = False,
    ) -> AsyncIterator[SiriusMsgServiceEvent]:
        backoff = 0.1
        while True:
            connection = NDJSONConnection(self._endpoint)
            reader_task: asyncio.Task[None] | None = None
            try:
                await connection.open()
                await connection.authenticate(self._auth_token)
                await connection.write(
                    SiriusMsgServiceRequest(
                        protocolVersion=PROTOCOL_VERSION,
                        requestID=request_id("subscribe"),
                        kind="subscribe",
                        subscriptionOptions=SiriusMsgSubscriptionOptions(supportsAttachments=supports_attachments),
                    )
                )
                subscribed = await connection.read_response()
                self._raise_if_error(subscribed)
                if subscribed.kind.value != "subscribed":
                    raise SiriusMsgTransportError("unexpected subscribe response")
                self._subscription_connection = connection
                self._subscription_pending = {}
                event_queue: asyncio.Queue[SiriusMsgServiceEvent | BaseException] = asyncio.Queue()
                self._subscription_events = event_queue
                reader_task = asyncio.create_task(
                    self._read_subscription(connection, event_queue),
                    name="siriusmsg-sdk-subscription-reader",
                )
                self._subscription_reader_task = reader_task
                while True:
                    item = await event_queue.get()
                    if isinstance(item, BaseException):
                        raise item
                    yield item
            except SiriusMsgTransportError:
                if reconnect_policy.value != "default":
                    raise
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 2.0)
            finally:
                if reader_task is not None and self._subscription_reader_task is reader_task:
                    reader_task.cancel()
                    try:
                        await reader_task
                    except asyncio.CancelledError:
                        pass
                    self._subscription_reader_task = None
                self._fail_subscription_pending(SiriusMsgTransportError("subscription closed"))
                if self._subscription_connection is connection:
                    self._subscription_connection = None
                    self._subscription_events = None
                await connection.close()

    async def _read_subscription(
        self,
        connection: NDJSONConnection,
        event_queue: asyncio.Queue[SiriusMsgServiceEvent | BaseException],
    ) -> None:
        try:
            while True:
                response = await connection.read_response()
                if self._route_subscription_response(response, event_queue):
                    continue
                self._raise_if_error(response)
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self._fail_subscription_pending(error)
            await event_queue.put(error)

    def _route_subscription_response(
        self,
        response: SiriusMsgServiceResponse,
        event_queue: asyncio.Queue[SiriusMsgServiceEvent | BaseException],
    ) -> bool:
        if response.requestID is not None:
            response_future = self._subscription_pending.pop(response.requestID, None)
            if response_future is not None:
                if response.kind.value == "error" and response.error is not None:
                    response_future.set_exception(
                        error_from_service(response.error.code.value, response.error.message, response.error.diagnosticCode)
                    )
                else:
                    response_future.set_result(response)
                return True

        if response.kind.value == "event" and response.event is not None:
            event_queue.put_nowait(response.event)
            return True

        return False

    def _fail_subscription_pending(self, error: BaseException) -> None:
        pending = self._subscription_pending
        self._subscription_pending = {}
        for response_future in pending.values():
            if not response_future.done():
                response_future.set_exception(error)

    async def _perform(self, kind: str, **payload: object) -> SiriusMsgServiceResponse:
        async with NDJSONConnection(self._endpoint) as connection:
            await connection.authenticate(self._auth_token)
            request = SiriusMsgServiceRequest(
                protocolVersion=PROTOCOL_VERSION,
                requestID=request_id(kind),
                kind=kind,
                **payload,
            )
            await connection.write(request)
            response = await connection.read_response()
            self._raise_if_error(response)
            if response.requestID is not None and response.requestID != request.requestID:
                raise SiriusMsgTransportError("response requestID did not match request")
            return response

    async def _check_supported(self, content: SiriusMsgContent) -> None:
        feature = _feature_for_content(content)
        caps = await self.capabilities()
        for cap in caps:
            if cap.feature == feature and cap.transport == SiriusMsgTransport.localMessagesAutomation:
                if cap.support in {
                    SiriusMsgCapabilitySupport.unsupported,
                    SiriusMsgCapabilitySupport.researchGated,
                    SiriusMsgCapabilitySupport.providerOnly,
                }:
                    raise UnsupportedContentError(feature.value, cap.diagnosticCode or UNSUPPORTED_LOCAL_DIAGNOSTIC)
                return
        raise UnsupportedContentError(feature.value, UNSUPPORTED_LOCAL_DIAGNOSTIC)

    @staticmethod
    def _raise_if_error(response: SiriusMsgServiceResponse) -> None:
        if response.kind.value == "error" and response.error is not None:
            raise error_from_service(response.error.code.value, response.error.message, response.error.diagnosticCode)


def _chat_id(value: str | SiriusMsgChatID) -> SiriusMsgChatID:
    return value if isinstance(value, SiriusMsgChatID) else SiriusMsgChatID(value)


def _attachment_id(value: str | SiriusMsgAttachmentID) -> SiriusMsgAttachmentID:
    return value if isinstance(value, SiriusMsgAttachmentID) else SiriusMsgAttachmentID(value)


def _feature_for_content(content: SiriusMsgContent) -> SiriusMsgFeature:
    mapping = {
        SiriusMsgContentKind.text: SiriusMsgFeature.sendText,
        SiriusMsgContentKind.attachment: SiriusMsgFeature.sendFile,
        SiriusMsgContentKind.richLink: SiriusMsgFeature.sendRichLink,
        SiriusMsgContentKind.reaction: SiriusMsgFeature.sendReaction,
        SiriusMsgContentKind.reply: SiriusMsgFeature.sendThreadedReply,
        SiriusMsgContentKind.edit: SiriusMsgFeature.sendEdit,
        SiriusMsgContentKind.unsend: SiriusMsgFeature.sendUnsend,
        SiriusMsgContentKind.typing: SiriusMsgFeature.sendTypingIndicator,
        SiriusMsgContentKind.messageEffect: SiriusMsgFeature.sendMessageEffect,
    }
    if content.kind == SiriusMsgContentKind.unsupported and content.unsupported is not None:
        return content.unsupported.feature
    return mapping[content.kind]


def _fallback_text(content: SiriusMsgContent) -> str:
    if content.kind == SiriusMsgContentKind.text:
        return content.text or ""
    if content.kind == SiriusMsgContentKind.richLink and content.richLink is not None:
        return str(content.richLink.url)
    if content.kind == SiriusMsgContentKind.reply and content.reply is not None:
        return content.reply.text
    if content.kind == SiriusMsgContentKind.edit and content.edit is not None:
        return content.edit.replacementText
    if content.kind == SiriusMsgContentKind.messageEffect and content.messageEffect is not None:
        return content.messageEffect.text
    return ""
