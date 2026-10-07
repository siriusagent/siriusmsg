from __future__ import annotations

import asyncio
import hashlib
import json
import queue
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TextIO
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from siriusmsg_sdk import (
    AttachmentHashMismatchError,
    AttachmentSizeMismatchError,
    AuthFailedError,
    SiriusMsgAttachmentFileReference,
    SiriusMsgClient,
    SiriusMsgReaction,
    SiriusMsgReconnectPolicy,
    SiriusMsgSendOutcomeUnknownError,
    SiriusMsgSendRequest,
    SiriusMsgRecipe,
    SiriusMsgRecipeAdapterEnvelope,
    SiriusMsgRecipeIntegrationEnvelope,
    SiriusMsgRichLink,
    SiriusMsgServiceAck,
    SiriusMsgTypingState,
    UnsupportedContentError,
)
from siriusmsg_sdk._models import SiriusMsgServiceRequest, SiriusMsgServiceResponse
from siriusmsg_sdk._transport import Endpoint, NDJSONConnection, canonical_json
from siriusmsg_sdk.errors import SiriusMsgMalformedFrameError

REPO_ROOT = Path(__file__).resolve().parents[4]
GOLDEN_DIR = REPO_ROOT / "Schema" / "golden"


def _canonical(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _parse_frame(
    data: dict,
) -> (
    SiriusMsgServiceRequest
    | SiriusMsgServiceResponse
    | SiriusMsgRecipe
    | SiriusMsgRecipeIntegrationEnvelope
    | SiriusMsgRecipeAdapterEnvelope
):
    if "command" in data:
        from siriusmsg_sdk import SiriusMsgAgentControlRequest

        return SiriusMsgAgentControlRequest.model_validate(data)
    if "accepted" in data and "kind" not in data:
        from siriusmsg_sdk import SiriusMsgAgentControlResponse

        return SiriusMsgAgentControlResponse.model_validate(data)
    response_payloads = {
        "health",
        "capabilities",
        "sendResult",
        "allowedChats",
        "historyPage",
        "authTokenRotationResult",
        "event",
        "attachmentFile",
        "error",
    }
    response_kinds = {
        "authenticated",
        "authTokenRotated",
        "subscribed",
        "acked",
        "sendResult",
        "allowedChats",
        "historyPage",
        "allowlistUpdated",
        "attachmentFile",
        "event",
        "error",
    }
    if data.get("kind") in response_kinds or response_payloads.intersection(data):
        return SiriusMsgServiceResponse.model_validate(data)
    if "recipe" in data and "triggerEvent" in data:
        return SiriusMsgRecipeAdapterEnvelope.model_validate(data)
    if "recipeID" in data and "recipeName" in data:
        return SiriusMsgRecipeIntegrationEnvelope.model_validate(data)
    if "actions" in data and "trigger" in data:
        return SiriusMsgRecipe.model_validate(data)
    return SiriusMsgServiceRequest.model_validate(data)


def test_golden_frames_decode_and_reencode_identically() -> None:
    for path in sorted(GOLDEN_DIR.iterdir()):
        lines = path.read_text().splitlines()
        assert lines, path
        for line in lines:
            data = json.loads(line)
            model = _parse_frame(data)
            assert canonical_json(model) == _canonical(data), path.name


def test_unknown_enum_values_fail_validation_cleanly() -> None:
    with pytest.raises(ValidationError):
        SiriusMsgServiceRequest.model_validate(
            {
                "protocolVersion": 1,
                "requestID": "future-kind",
                "kind": "futureKind",
            }
        )


def test_generated_send_operation_id_is_recoverable_after_transport_failure() -> None:
    async def run() -> None:
        client = SiriusMsgClient.loopback(port=1, auth_token="unused")
        with pytest.raises(SiriusMsgSendOutcomeUnknownError) as caught:
            await client.send(SiriusMsgSendRequest(chatID="allowed", text="hello"))
        assert caught.value.operation_id

    asyncio.run(run())


def test_history_search_rejects_an_oversized_chat_scope_before_transport() -> None:
    async def run() -> None:
        client = SiriusMsgClient.loopback(port=1, auth_token="unused")
        with pytest.raises(ValidationError):
            await client.search_history("query", [f"chat-{index}" for index in range(21)])

    asyncio.run(run())


def test_capability_gating_raises_before_send() -> None:
    asyncio.run(_test_capability_gating_raises_before_send())


async def _test_capability_gating_raises_before_send() -> None:
    client = SiriusMsgClient.loopback(port=1, auth_token="unused")

    async def capabilities(*args, **kwargs):
        data = json.loads((GOLDEN_DIR / "capabilities-response-local.json").read_text())
        return SiriusMsgServiceResponse.model_validate(data).capabilities

    async def send(_request):
        raise AssertionError("send must not be called for unsupported content")

    client.capabilities = capabilities  # type: ignore[method-assign]
    client.send = send  # type: ignore[method-assign]

    unsupported_calls = [
        lambda: client.send_reaction("SMS;-;+15555550100", "target", SiriusMsgReaction.like),
        lambda: client.send_threaded_reply("SMS;-;+15555550100", "target", "threaded reply"),
        lambda: client.send_edit("SMS;-;+15555550100", "target", "replacement"),
        lambda: client.send_unsend("SMS;-;+15555550100", "target"),
        lambda: client.send_typing("SMS;-;+15555550100", SiriusMsgTypingState.started),
        lambda: client.send_message_effect("SMS;-;+15555550100", "boom", "slam"),
    ]
    for unsupported_call in unsupported_calls:
        with pytest.raises(UnsupportedContentError) as error:
            await unsupported_call()
        assert error.value.diagnostic_code == "unsupportedByLocalMessagesAutomation"


def test_transport_reads_a_frame_above_the_asyncio_default_limit() -> None:
    async def run() -> None:
        frame = {
            "protocolVersion": 1,
            "requestID": "large-frame",
            "kind": "health",
            "health": {
                "activeTransport": "localMessagesAutomation",
                "capabilities": [],
                "components": [],
                "reason": "x" * 200_000,
                "state": "healthy",
            },
        }

        async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                writer.write((json.dumps(frame, separators=(",", ":")) + "\n").encode("utf-8"))
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        connection = NDJSONConnection(Endpoint.loopback(port))
        try:
            await connection.open()
            response = await asyncio.wait_for(connection.read_response(), timeout=2)
            assert response.health is not None
            assert len(response.health.reason) == 200_000
        finally:
            await connection.close()
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_transport_rejects_a_frame_above_the_protocol_limit() -> None:
    async def run() -> None:
        async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                writer.write(b"x" * (1_048_576 + 4096))
                await writer.drain()
                await asyncio.sleep(0.5)
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        connection = NDJSONConnection(Endpoint.loopback(port))
        try:
            await connection.open()
            with pytest.raises(SiriusMsgMalformedFrameError):
                await asyncio.wait_for(connection.read_response(), timeout=2)
        finally:
            await connection.close()
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_subscription_ack_tolerates_interleaved_events() -> None:
    asyncio.run(_test_subscription_ack_tolerates_interleaved_events())


async def _test_subscription_ack_tolerates_interleaved_events() -> None:
    event_response = json.loads((GOLDEN_DIR / "message-event-response.json").read_text())

    async def write_frame(writer: asyncio.StreamWriter, frame: dict) -> None:
        writer.write((_canonical(frame) + "\n").encode("utf-8"))
        await writer.drain()

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while line := await reader.readline():
                frame = json.loads(line)
                if frame["kind"] == "authenticate":
                    await write_frame(
                        writer,
                        {
                            "protocolVersion": 1,
                            "requestID": frame["requestID"],
                            "kind": "authenticated",
                        },
                    )
                elif frame["kind"] == "subscribe":
                    await write_frame(
                        writer,
                        {
                            "protocolVersion": 1,
                            "requestID": frame["requestID"],
                            "kind": "subscribed",
                        },
                    )
                    await write_frame(writer, event_response)
                elif frame["kind"] == "ack":
                    await write_frame(writer, event_response)
                    await write_frame(writer, {"protocolVersion": 1, "requestID": frame["requestID"], "kind": "acked"})
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        client = SiriusMsgClient.loopback(port=port, auth_token="token")
        events = client.subscribe(supports_attachments=True)
        try:
            first = await asyncio.wait_for(anext(events), timeout=2)
            assert first.message is not None
            await asyncio.wait_for(
                client.ack(
                    SiriusMsgServiceAck(
                        messageID=first.message.id,
                        chatID=first.message.chatID,
                        rowID=first.message.rowID,
                    )
                ),
                timeout=2,
            )
            second = await asyncio.wait_for(anext(events), timeout=2)
            assert second.message is not None
        finally:
            await events.aclose()
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.parametrize("mime_type", ["audio/mpeg", "audio/mp4", "audio/wav", "video/mp4", "video/quicktime"])
def test_media_attachment_fetch_preserves_binary_bytes(mime_type: str, tmp_path: Path) -> None:
    expected = bytes([0, 255, 1, 128, 10, 13, 0])
    path = tmp_path / "media.bin"
    path.write_bytes(expected)
    reference = SiriusMsgAttachmentFileReference.model_validate(
        {
            "localFilePath": str(path),
            "metadata": {
                "byteCount": len(expected),
                "id": "synthetic-media",
                "kind": "document",
                "mimeType": mime_type,
                "sha256": hashlib.sha256(expected).hexdigest(),
                "state": "materialized",
            },
        }
    )
    client = SiriusMsgClient.loopback(port=1, auth_token="unused")
    client.fetch_attachment = AsyncMock(return_value=reference)
    assert asyncio.run(client.fetch_attachment_data("synthetic-media")) == expected
    assert reference.metadata.mimeType == mime_type


def test_fetch_attachment_data_rejects_size_and_hash_corruption() -> None:
    asyncio.run(_test_fetch_attachment_data_rejects_size_and_hash_corruption())


async def _test_fetch_attachment_data_rejects_size_and_hash_corruption() -> None:
    attachment_id = "m42-a7"
    expected = b"trusted attachment"
    expected_sha256 = hashlib.sha256(expected).hexdigest()

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "attachment.bin"
        file_reference = SiriusMsgAttachmentFileReference.model_validate(
            {
                "localFilePath": str(path),
                "metadata": {
                    "byteCount": len(expected),
                    "id": attachment_id,
                    "kind": "document",
                    "mimeType": "application/octet-stream",
                    "sha256": expected_sha256,
                    "state": "materialized",
                },
            }
        )
        client = SiriusMsgClient.loopback(port=1, auth_token="unused")
        client.fetch_attachment = AsyncMock(return_value=file_reference)

        path.write_bytes(b"short")
        with pytest.raises(AttachmentSizeMismatchError) as size_error:
            await client.fetch_attachment_data(attachment_id)
        assert size_error.value.attachment_id == attachment_id
        assert size_error.value.expected_byte_count == len(expected)
        assert size_error.value.actual_byte_count == len(b"short")

        corrupt = b"x" * len(expected)
        path.write_bytes(corrupt)
        with pytest.raises(AttachmentHashMismatchError) as hash_error:
            await client.fetch_attachment_data(attachment_id)
        assert hash_error.value.attachment_id == attachment_id
        assert hash_error.value.expected_sha256 == expected_sha256
        assert hash_error.value.actual_sha256 == hashlib.sha256(corrupt).hexdigest()


def test_subscription_reconnects_after_transport_closure() -> None:
    asyncio.run(_test_subscription_reconnects_after_transport_closure())


async def _test_subscription_reconnects_after_transport_closure() -> None:
    event_response = json.loads((GOLDEN_DIR / "message-event-response.json").read_text())
    subscriptions = 0

    async def write_frame(writer: asyncio.StreamWriter, frame: dict) -> None:
        writer.write((_canonical(frame) + "\n").encode("utf-8"))
        await writer.drain()

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal subscriptions
        try:
            while line := await reader.readline():
                frame = json.loads(line)
                if frame["kind"] == "authenticate":
                    await write_frame(
                        writer,
                        {
                            "protocolVersion": 1,
                            "requestID": frame["requestID"],
                            "kind": "authenticated",
                        },
                    )
                elif frame["kind"] == "subscribe":
                    subscriptions += 1
                    await write_frame(
                        writer,
                        {
                            "protocolVersion": 1,
                            "requestID": frame["requestID"],
                            "kind": "subscribed",
                        },
                    )
                    if subscriptions == 1:
                        return
                    await write_frame(writer, event_response)
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        client = SiriusMsgClient.loopback(port=port, auth_token="token")
        events = client.subscribe(reconnect_policy=SiriusMsgReconnectPolicy.default)
        try:
            event = await asyncio.wait_for(anext(events), timeout=2)
            assert event.kind.value == "message"
            assert subscriptions == 2
        finally:
            await events.aclose()
    finally:
        server.close()
        await server.wait_closed()


def test_subscription_reconnect_fails_fast_on_authentication_errors() -> None:
    asyncio.run(_test_subscription_reconnect_fails_fast_on_authentication_errors())


async def _test_subscription_reconnect_fails_fast_on_authentication_errors() -> None:
    connections = 0

    async def write_frame(writer: asyncio.StreamWriter, frame: dict) -> None:
        writer.write((_canonical(frame) + "\n").encode("utf-8"))
        await writer.drain()

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal connections
        connections += 1
        try:
            if line := await reader.readline():
                frame = json.loads(line)
                assert frame["kind"] == "authenticate"
                await write_frame(
                    writer,
                    {
                        "protocolVersion": 1,
                        "requestID": frame["requestID"],
                        "kind": "error",
                        "error": {"code": "authFailed", "message": "Authentication failed."},
                    },
                )
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        client = SiriusMsgClient.loopback(port=port, auth_token="wrong-token")
        events = client.subscribe(reconnect_policy=SiriusMsgReconnectPolicy.default)
        with pytest.raises(AuthFailedError):
            await asyncio.wait_for(anext(events), timeout=0.5)
        assert connections == 1
    finally:
        server.close()
        await server.wait_closed()


HarnessInfo = dict[str, str | int]


def _drain_harness_stderr(stream: TextIO, lines: list[str]) -> None:
    lines.extend(stream)


def _harness_directory(info: HarnessInfo) -> Path:
    directory = Path(str(info["workingDirectory"]))
    allowed_parents = {Path("/tmp").resolve(), Path("/private/tmp").resolve()}
    if not directory.name.startswith("siriusmsg-sdk-harness-") or directory.parent.resolve() not in allowed_parents:
        raise AssertionError(f"refusing to clean unexpected harness directory: {directory}")
    return directory


def _stop_sdk_harness(
    process: subprocess.Popen[str],
    stderr_thread: threading.Thread,
    stderr_lines: list[str],
    info: HarnessInfo | None,
) -> None:
    forced = False
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            forced = True
            process.kill()
            process.wait(timeout=5)
    stderr_thread.join(timeout=1)

    if info is None:
        return

    directory = _harness_directory(info)
    leaked_directory = directory.exists()
    if leaked_directory:
        shutil.rmtree(directory)
    stderr = "".join(stderr_lines).strip()
    if forced:
        raise AssertionError(f"Swift SDK harness ignored SIGTERM and required SIGKILL.\n{stderr}")
    if process.returncode != 0:
        raise AssertionError(f"Swift SDK harness exited with {process.returncode}.\n{stderr}")
    if leaked_directory:
        raise AssertionError(f"Swift SDK harness leaked its working directory: {directory}")


@contextmanager
def _running_sdk_harness() -> Iterator[HarnessInfo]:
    process = subprocess.Popen(
        ["swift", "run", "--quiet", "SiriusMsgSDKHarness"],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stderr is not None
    stderr_lines: list[str] = []
    stderr_thread = threading.Thread(
        target=_drain_harness_stderr,
        args=(process.stderr, stderr_lines),
        daemon=True,
        name="siriusmsg-sdk-harness-stderr",
    )
    stderr_thread.start()
    line_queue: queue.Queue[str] = queue.Queue(maxsize=1)
    stdout_thread = threading.Thread(
        target=lambda: line_queue.put(process.stdout.readline()),
        daemon=True,
        name="siriusmsg-sdk-harness-stdout",
    )
    stdout_thread.start()
    info: HarnessInfo | None = None
    try:
        try:
            line = line_queue.get(timeout=20)
        except queue.Empty as error:
            raise AssertionError("timed out waiting for Swift SDK harness startup") from error
        if not line:
            process.wait(timeout=5)
            raise AssertionError(f"Swift SDK harness exited before startup.\n{''.join(stderr_lines).strip()}")
        decoded = json.loads(line)
        required_keys = {
            "socketPath",
            "tokenPath",
            "authToken",
            "workingDirectory",
            "chatID",
            "messageID",
            "rowID",
            "attachmentID",
        }
        if not isinstance(decoded, dict) or not required_keys.issubset(decoded):
            raise AssertionError(f"Swift SDK harness returned incomplete startup info: {decoded!r}")
        info = {key: value for key, value in decoded.items() if isinstance(value, (str, int))}
        _harness_directory(info)
        yield info
    finally:
        _stop_sdk_harness(process, stderr_thread, stderr_lines, info)


@pytest.fixture(scope="module")
def live_sdk_harness() -> Iterator[HarnessInfo]:
    with _running_sdk_harness() as info:
        yield info


def test_live_client_reads_health_and_capabilities_from_swift_service(live_sdk_harness: HarnessInfo) -> None:
    asyncio.run(_test_live_client_reads_health_and_capabilities_from_swift_service(live_sdk_harness))


async def _test_live_client_reads_health_and_capabilities_from_swift_service(info: HarnessInfo) -> None:
    client = await SiriusMsgClient.connect(socket_path=str(info["socketPath"]), token_path=str(info["tokenPath"]))
    health = await client.health()
    assert health.state.value in {"healthy", "degraded", "blocked"}
    capabilities = await client.capabilities()
    send_text = next(capability for capability in capabilities if capability.feature.value == "sendText")
    assert send_text.support.value == "supported"
    assert send_text.transport.value == "localMessagesAutomation"

    chats = await client.list_allowed_chats("SDK", limit=5)
    assert [chat.chatID.root for chat in chats] == [info["chatID"]]
    history = await client.read_history(str(info["chatID"]), limit=5)
    assert [message.text for message in history.messages] == ["hello sdk"]
    search = await client.search_history("HELLO", [str(info["chatID"])], limit=5)
    assert [message.id.root for message in search.messages] == [info["messageID"]]


def test_live_client_sends_text_and_rich_link_through_swift_service(live_sdk_harness: HarnessInfo) -> None:
    asyncio.run(_test_live_client_sends_text_and_rich_link_through_swift_service(live_sdk_harness))


async def _test_live_client_sends_text_and_rich_link_through_swift_service(info: HarnessInfo) -> None:
    client = await SiriusMsgClient.connect(socket_path=str(info["socketPath"]), token_path=str(info["tokenPath"]))
    sent = await client.send_text(str(info["chatID"]), "hello from python")
    assert sent.accepted is True
    assert sent.platformMessageID is not None and sent.platformMessageID.startswith("sdk-harness-")
    assert sent.confirmationState.value == "notRequested"
    assert sent.resolvedContent is not None and sent.resolvedContent.text == "hello from python"

    link = SiriusMsgRichLink(url="https://example.com/python", kind="plain")
    link_sent = await client.send_rich_link(str(info["chatID"]), link)
    assert link_sent.accepted is True
    assert link_sent.resolvedContent is not None and link_sent.resolvedContent.richLink is not None
    assert str(link_sent.resolvedContent.richLink.url) == "https://example.com/python"


def test_live_client_subscribes_acks_and_fetches_attachment(live_sdk_harness: HarnessInfo) -> None:
    asyncio.run(_test_live_client_subscribes_acks_and_fetches_attachment(live_sdk_harness))


async def _test_live_client_subscribes_acks_and_fetches_attachment(info: HarnessInfo) -> None:
    client = await SiriusMsgClient.connect(socket_path=str(info["socketPath"]), token_path=str(info["tokenPath"]))
    events = client.subscribe(supports_attachments=True)
    event = None
    try:
        for _ in range(5):
            candidate = await asyncio.wait_for(anext(events), timeout=5)
            if candidate.kind.value == "message":
                event = candidate
                break
        assert event is not None and event.message is not None
        message = event.message
        assert message.id.root == info["messageID"]
        assert message.text == "hello sdk"
        assert message.attachments[0].id.root == info["attachmentID"]
        await client.ack(SiriusMsgServiceAck(messageID=message.id, chatID=message.chatID, rowID=message.rowID))
    finally:
        await events.aclose()

    fetched = await client.fetch_attachment(message.attachments[0].id)
    assert fetched.metadata.byteCount == len(b"hello sdk")
    assert await client.fetch_attachment_data(message.attachments[0].id) == b"hello sdk"


def test_live_client_rejects_unsupported_content_before_swift_send(live_sdk_harness: HarnessInfo) -> None:
    asyncio.run(_test_live_client_rejects_unsupported_content_before_swift_send(live_sdk_harness))


async def _test_live_client_rejects_unsupported_content_before_swift_send(info: HarnessInfo) -> None:
    client = await SiriusMsgClient.connect(socket_path=str(info["socketPath"]), token_path=str(info["tokenPath"]))
    with pytest.raises(UnsupportedContentError) as error:
        await client.send_reaction(str(info["chatID"]), str(info["messageID"]), SiriusMsgReaction.like)
    assert error.value.feature == "sendReaction"
    assert error.value.diagnostic_code


def test_live_other_consumer_reconnects_after_token_rotation(live_sdk_harness: HarnessInfo) -> None:
    async def run() -> None:
        options = dict(socket_path=str(live_sdk_harness["socketPath"]), token_path=str(live_sdk_harness["tokenPath"]))
        rotating = await SiriusMsgClient.connect(**options)
        other = await SiriusMsgClient.connect(**options)
        await rotating.rotate_auth_token()
        health = await other.health()
        token = next(c for c in health.components if c.kind.value == "authToken")
        assert token.state.value == "healthy"
        assert token.detail.tokenMaintenanceDue is False

    asyncio.run(run())


def test_rich_helpers_preserve_targets_actions_and_unconfirmed_results() -> None:
    async def run() -> None:
        from siriusmsg_sdk import SiriusMsgReactionAction
        from siriusmsg_sdk._models import SiriusMsgSendResult

        client = SiriusMsgClient.loopback(port=1, auth_token="unused")
        data = json.loads((GOLDEN_DIR / "capabilities-response-local.json").read_text())
        for capability in data["capabilities"]:
            capability["support"] = "supported"
        client.capabilities = AsyncMock(return_value=SiriusMsgServiceResponse.model_validate(data).capabilities)
        captured = []

        async def send(request):
            captured.append(request.model_dump(mode="json", exclude_none=True))
            return SiriusMsgSendResult(accepted=True, confirmationState="unconfirmed", resolvedContent=request.content)

        client.send = send
        calls = [
            lambda: client.send_reaction("allowed", "exact-target", SiriusMsgReaction.like, "account"),
            lambda: client.send_reaction(
                "allowed", "exact-target", SiriusMsgReaction.like, "account", action=SiriusMsgReactionAction.removed
            ),
            lambda: client.send_threaded_reply("allowed", "exact-target", "reply", "account"),
            lambda: client.send_edit("allowed", "exact-target", "replacement", "account"),
            lambda: client.send_unsend("allowed", "exact-target", "account"),
            lambda: client.send_typing("allowed", SiriusMsgTypingState.started, "account"),
            lambda: client.send_typing("allowed", SiriusMsgTypingState.stopped, "account"),
            lambda: client.send_message_effect("allowed", "effect", "slam", "account"),
        ]
        for call in calls:
            result = await call()
            assert result.accepted and result.confirmationState.value == "unconfirmed"
        assert [r["content"]["kind"] for r in captured] == [
            "reaction",
            "reaction",
            "reply",
            "edit",
            "unsend",
            "typing",
            "typing",
            "messageEffect",
        ]
        assert [r["content"]["typing"] for r in captured if r["content"]["kind"] == "typing"] == ["started", "stopped"]
        assert captured[0]["content"]["reaction"]["action"] == "added"
        assert captured[1]["content"]["reaction"]["action"] == "removed"
        for request in captured:
            assert request["chatID"] == "allowed" and request["accountID"] == "account"
            content = request["content"]
            if content["kind"] in ["reaction", "reply", "edit", "unsend"]:
                assert content[content["kind"]]["targetMessageID"] == "exact-target"

    asyncio.run(run())


def test_registered_connection_reloads_scoped_credential_after_rotation(tmp_path, monkeypatch) -> None:
    async def run() -> None:
        token_path = tmp_path / "token.json"
        token_path.write_text(json.dumps({"token": "fixture-primary"}))

        async def health(self):
            return None

        monkeypatch.setattr(SiriusMsgClient, "health", health)
        client = await SiriusMsgClient.connect(
            token_path=token_path, connection_id="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
        )
        assert client._current_auth_token() == "Jr33zUqEzp27mh4Ws5w8xKSUZenoj1pmNBejxM4Ikzg="
        token_path.write_text(json.dumps({"token": "fixture-rotated"}))
        assert client._current_auth_token() == "fA86e3Sjmgiyzy6NouMWsaRvm6bBMVW4NULxToXpIqE="
        legacy = await SiriusMsgClient.connect(token_path=token_path)
        assert legacy._current_auth_token() == "fixture-rotated"
        with pytest.raises(ValueError):
            await SiriusMsgClient.connect(token_path=token_path, connection_id="not-a-uuid")

    asyncio.run(run())


@pytest.mark.parametrize(
    "code",
    [
        "authFailed",
        "authRequired",
        "invalidRequest",
        "peerCredentialsRejected",
        "protocolVersionUnsupported",
        "internalError",
    ],
)
def test_send_distinguishes_known_rejection_from_unknown_outcome(code, monkeypatch) -> None:
    from siriusmsg_sdk.errors import error_from_service

    async def run() -> None:
        client = SiriusMsgClient.loopback(port=1, auth_token="unused")

        async def rejected(*args, **kwargs):
            raise error_from_service(code, "Synthetic rejection", "fixtureDiagnostic")

        monkeypatch.setattr(client, "_perform", rejected)
        request = SiriusMsgSendRequest(chatID="allowed", text="hello", operationID="stable-operation")
        if code == "internalError":
            with pytest.raises(SiriusMsgSendOutcomeUnknownError) as caught:
                await client.send(request)
            assert caught.value.operation_id == "stable-operation"
        else:
            result = await client.send(request)
            assert result.accepted is False
            assert result.confirmationState.value == "notRequested"
            assert result.diagnosticCode == "fixtureDiagnostic"

    asyncio.run(run())


def test_file_helper_uses_service_staging_and_stable_id(live_sdk_harness: HarnessInfo, tmp_path: Path) -> None:
    async def run() -> None:
        info = live_sdk_harness
        client = await SiriusMsgClient.connect(socket_path=str(info["socketPath"]), token_path=str(info["tokenPath"]))
        path = tmp_path / "file # café.txt"
        data = b"SDK file fixture"
        path.write_bytes(data)
        rejected = await client.send_file(
            str(info["chatID"]), path, "application/x-siriusmsg-test-unsupported", operation_id="python-file-rejected"
        )
        assert not rejected.accepted
        assert rejected.diagnosticCode == "attachmentUnsupportedType"
        results = []
        for _ in range(2):
            result = await client.send_file(str(info["chatID"]), path, "text/plain", operation_id="python-file-once")
            assert result.accepted
            if not results:
                attachment = result.resolvedContent.attachment
                assert attachment.byteCount == len(data)
                assert attachment.sha256 == hashlib.sha256(data).hexdigest()
                assert str(attachment.fileURL) != path.as_uri()
            results.append(result)
        assert results[0].platformMessageID == results[1].platformMessageID

    asyncio.run(run())


def test_local_owner_configuration_and_registered_agent_scope_use_swift_service(live_sdk_harness: HarnessInfo) -> None:
    async def run() -> None:
        from siriusmsg_sdk import (
            SiriusMsgAgentControlClient,
            SiriusMsgAgentControlError,
            SiriusMsgAllowlist,
            SiriusMsgPythonAdapterConfiguration,
            SiriusMsgRichMessagingConfiguration,
            SiriusMsgSDKError,
        )

        info = live_sdk_harness
        owner = SiriusMsgAgentControlClient(runtime_directory=str(info["workingDirectory"]), timeout=2)
        activity = await owner.read_activity()
        assert activity.adapterStatuses is not None and activity.activityRecords is not None
        initial = await owner.read_configuration()
        assert initial.allowlist.chatIDs
        profile = await owner.create_connection("Python SDK consumer", [str(info["chatID"])], replies_allowed=False)
        registered = await SiriusMsgClient.connect(
            socket_path=str(info["socketPath"]), token_path=str(info["tokenPath"]), connection_id=profile.id
        )
        assert len(await registered.list_allowed_chats()) == 1
        result = await registered.send_text(str(info["chatID"]), "fixture reply")
        assert not result.accepted
        with pytest.raises(SiriusMsgSDKError):
            await registered.update_allowlist(SiriusMsgAllowlist(chatIDs=["unshared"], handleIDs=[]))
        with pytest.raises(SiriusMsgAgentControlError):
            await owner.create_connection("Out of scope", ["unshared"])
        rich = SiriusMsgRichMessagingConfiguration(
            provider="nativeAccessibility", executablePath="", enabled=True, allowedFeatures=["sendReaction"]
        )
        await owner.set_rich_messaging_configuration(rich)
        configuration = await owner.read_configuration()
        assert configuration.richMessaging.nativeEnabled is True
        assert configuration.richMessaging.enabled is False
        adapter = SiriusMsgPythonAdapterConfiguration(
            adapterID="python-sdk-fixture",
            pythonPackagePath="/fixture/python",
            handlerModule="handler",
            handlerFunction="handle",
            workerCount=1,
            timeoutSeconds=30,
            includeMessageBody=True,
            supportsAttachments=True,
            enabled=False,
        )
        saved = await owner.save_python_adapter_configuration(adapter)
        assert saved.restartRequired is True
        await owner.set_activity_retention(7)
        assert (await owner.read_configuration()).activityRetentionDays == 7
        profile.enabled = False
        await owner.update_connection(profile)
        with pytest.raises(AuthFailedError):
            await registered.health()
        await owner.remove_connection(profile.id)
        assert all(p.id != profile.id for p in (await owner.read_configuration()).connections)

    asyncio.run(run())


@pytest.mark.parametrize("mode", ["silent", "trickle", "cancel", "oversize", "malformed"])
def test_control_deadline_cancellation_and_framing_never_retry(tmp_path: Path, mode: str) -> None:
    async def run() -> None:
        from siriusmsg_sdk import (
            SiriusMsgAgentControlClient,
            SiriusMsgAgentControlRequest,
            SiriusMsgControlOutcomeUnknownError,
        )

        requests = []
        tasks = set()
        closed = asyncio.Event()

        async def handle(reader, writer):
            task = asyncio.current_task()
            tasks.add(task)
            try:
                requests.append(await reader.readline())
                if mode == "oversize":
                    writer.write(b"x" * (1_048_576 + 1) + b"\n")
                    await writer.drain()
                elif mode == "malformed":
                    writer.write(b'{"accepted":"invalid"}\n')
                    await writer.drain()
                elif mode == "trickle":
                    for byte in b'{"accepted":true}':
                        writer.write(bytes([byte]))
                        await writer.drain()
                        await asyncio.sleep(0.03)
                else:
                    await reader.read()
            except (ConnectionError, BrokenPipeError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
                tasks.discard(task)
                closed.set()

        socket_root = Path(tempfile.mkdtemp(prefix="sm-control-", dir="/tmp"))
        socket = socket_root / "control.sock"
        server = await asyncio.start_unix_server(handle, path=socket)
        client = SiriusMsgAgentControlClient(socket_path=socket, timeout=0.08)
        try:
            request = SiriusMsgAgentControlRequest(command="probeAutomation")
            if mode == "cancel":
                operation = asyncio.create_task(client.send(request))
                while not requests:
                    await asyncio.sleep(0.005)
                operation.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await operation
            else:
                expected = (
                    SiriusMsgMalformedFrameError
                    if mode in ("oversize", "malformed")
                    else SiriusMsgControlOutcomeUnknownError
                )
                with pytest.raises(expected):
                    await client.send(request)
            assert len(requests) == 1
        finally:
            server.close()
            await server.wait_closed()
            for task in list(tasks):
                task.cancel()
            await asyncio.gather(*list(tasks), return_exceptions=True)
            shutil.rmtree(socket_root)

    asyncio.run(run())


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), 0, -1, 601])
def test_control_invalid_deadline_fails_before_connect(timeout) -> None:
    from siriusmsg_sdk import SiriusMsgAgentControlClient

    with pytest.raises(ValueError):
        SiriusMsgAgentControlClient(timeout=timeout)
