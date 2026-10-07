"""Local-owner setup and diagnostics, using the same control API as SiriusMsg.app.

This is a Unix-only administration client, separate from registered, scoped
agent clients. It never starts the app/helper or grants macOS permissions.
"""

from __future__ import annotations

import asyncio
import math
import time
import uuid
from pathlib import Path

from pydantic import ValidationError

from siriusmsg_sdk._models import (
    SiriusMsgAgentControlCommand,
    SiriusMsgAgentControlRequest,
    SiriusMsgAgentControlResponse,
    SiriusMsgChatListPage,
    SiriusMsgChatListQuery,
    SiriusMsgConnectionProfile,
    SiriusMsgLocalConfigurationSnapshot,
    SiriusMsgPythonAdapterConfiguration,
    SiriusMsgRichMessagingConfiguration,
    SiriusMsgRichMessagingProvider,
)
from siriusmsg_sdk._transport import DEFAULT_RUNTIME_DIR, MAXIMUM_FRAME_BYTES, canonical_json
from siriusmsg_sdk.errors import SiriusMsgMalformedFrameError, SiriusMsgSDKError, SiriusMsgTransportError


class SiriusMsgAgentControlError(SiriusMsgSDKError):
    """A local-owner command was rejected."""


class SiriusMsgControlOutcomeUnknownError(SiriusMsgTransportError):
    """The command may have completed; inspect state before retrying."""

    def __init__(self, command: SiriusMsgAgentControlCommand) -> None:
        self.command = command
        super().__init__(f"control outcome unknown for {command.value}; inspect state before retrying")


class SiriusMsgAgentControlClient:
    def __init__(
        self,
        *,
        runtime_directory: str | Path = DEFAULT_RUNTIME_DIR,
        socket_path: str | Path | None = None,
        timeout: float = 120,
    ) -> None:
        if not math.isfinite(timeout) or not 0 < timeout <= 600:
            raise ValueError("control timeout must be finite and between 0 and 600 seconds")
        self.socket_path = (
            Path(socket_path) if socket_path is not None else Path(runtime_directory) / "siriusmsg-control.sock"
        )
        self.timeout = timeout

    async def send(self, request: SiriusMsgAgentControlRequest) -> SiriusMsgAgentControlResponse:
        """One request, one overall deadline, no automatic retry. Cancellation closes the socket."""
        frame = canonical_json(request).encode() + b"\n"
        if len(frame) > MAXIMUM_FRAME_BYTES:
            raise ValueError("control request exceeds the frame limit")

        async def exchange() -> SiriusMsgAgentControlResponse:
            writer: asyncio.StreamWriter | None = None
            try:
                reader, writer = await asyncio.open_unix_connection(
                    str(self.socket_path), limit=MAXIMUM_FRAME_BYTES + 1
                )
                writer.write(frame)
                await writer.drain()
                response = await reader.readline()
                if not response or not response.endswith(b"\n") or len(response) > MAXIMUM_FRAME_BYTES:
                    raise SiriusMsgMalformedFrameError("invalid control response frame")
                try:
                    return SiriusMsgAgentControlResponse.model_validate_json(response)
                except ValidationError:
                    raise SiriusMsgMalformedFrameError("invalid control response payload") from None
            finally:
                if writer is not None:
                    writer.close()
                    await writer.wait_closed()

        try:
            return await asyncio.wait_for(exchange(), timeout=self.timeout)
        except (asyncio.TimeoutError, OSError):
            raise SiriusMsgControlOutcomeUnknownError(request.command) from None
        except (ValueError, asyncio.LimitOverrunError):
            raise SiriusMsgMalformedFrameError("control response exceeds the frame limit") from None

    async def _accepted(self, request: SiriusMsgAgentControlRequest) -> SiriusMsgAgentControlResponse:
        response = await self.send(request)
        if not response.accepted:
            raise SiriusMsgAgentControlError(response.error or "The command was rejected.")
        return response

    async def read_activity(self) -> SiriusMsgAgentControlResponse:
        """App activity projection, adapter queue/status metadata and validation records."""
        return await self._accepted(SiriusMsgAgentControlRequest(command=SiriusMsgAgentControlCommand.readActivity))

    async def read_configuration(self) -> SiriusMsgLocalConfigurationSnapshot:
        response = await self._accepted(
            SiriusMsgAgentControlRequest(command=SiriusMsgAgentControlCommand.readConfiguration)
        )
        if response.configuration is None:
            raise SiriusMsgMalformedFrameError("configuration is missing")
        return response.configuration

    async def create_connection(
        self,
        display_name: str,
        chat_ids: list[str],
        *,
        replies_allowed: bool = True,
        enabled: bool = True,
        incoming_allowed: bool = True,
    ) -> SiriusMsgConnectionProfile:
        """Register your own event-consuming agent; select already-shared chats explicitly."""
        profile = SiriusMsgConnectionProfile(
            id=str(uuid.uuid4()),
            createdAt=time.time() - 978307200,
            displayName=display_name,
            enabled=enabled,
            incomingAllowed=incoming_allowed,
            repliesAllowed=replies_allowed,
            includedChatIDs=chat_ids,
            excludedChatIDs=[],
        )
        response = await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.createConnection, connectionProfile=profile
            )
        )
        if response.connectionProfile is None:
            raise SiriusMsgMalformedFrameError("connection profile is missing")
        return response.connectionProfile

    async def update_connection(self, profile: SiriusMsgConnectionProfile) -> None:
        await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.updateConnection, connectionProfile=profile
            )
        )

    async def remove_connection(self, connection_id: str | uuid.UUID) -> None:
        await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.removeConnection, connectionID=str(uuid.UUID(str(connection_id)))
            )
        )

    async def set_rich_messaging_configuration(self, configuration: SiriusMsgRichMessagingConfiguration) -> None:
        """Uses the wire-level nativeEnabled flag for the nativeAccessibility provider."""
        if configuration.provider == SiriusMsgRichMessagingProvider.nativeAccessibility:
            configuration = configuration.model_copy(
                update={
                    "nativeEnabled": configuration.nativeEnabled
                    if configuration.nativeEnabled is not None
                    else configuration.enabled,
                    "enabled": False,
                }
            )
        await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.setRichMessagingConfiguration,
                richMessagingConfiguration=configuration,
            )
        )

    async def save_python_adapter_configuration(
        self, configuration: SiriusMsgPythonAdapterConfiguration
    ) -> SiriusMsgAgentControlResponse:
        return await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.savePythonAdapterConfiguration,
                pythonAdapterConfiguration=configuration,
            )
        )

    async def list_chats(self, query: SiriusMsgChatListQuery) -> SiriusMsgChatListPage:
        """Owner setup browsing, independent of scoped agent history/subscriptions."""
        response = await self._accepted(
            SiriusMsgAgentControlRequest(command=SiriusMsgAgentControlCommand.listChats, chatListQuery=query)
        )
        if response.chatListPage is None:
            raise SiriusMsgMalformedFrameError("chat page is missing")
        return response.chatListPage

    async def set_vm_access_enabled(self, enabled: bool) -> SiriusMsgAgentControlResponse:
        return await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.setVMAccessEnabled, vmAccessEnabled=enabled
            )
        )

    async def set_activity_retention(self, days: int) -> SiriusMsgAgentControlResponse:
        if days not in (0, 7, 30, 90):
            raise ValueError("retention must be 0, 7, 30 or 90 days")
        return await self._accepted(
            SiriusMsgAgentControlRequest(
                command=SiriusMsgAgentControlCommand.setActivityRetention, activityRetentionDays=days
            )
        )

    async def clear_adapter_review(self, adapter_id: str) -> SiriusMsgAgentControlResponse:
        return await self._accepted(
            SiriusMsgAgentControlRequest(command=SiriusMsgAgentControlCommand.clearAdapterReview, adapterID=adapter_id)
        )
