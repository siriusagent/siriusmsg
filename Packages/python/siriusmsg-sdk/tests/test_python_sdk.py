from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import pytest
from pydantic import ValidationError

from siriusmsg_sdk import (
    SiriusMsgChatID,
    SiriusMsgClient,
    SiriusMsgContent,
    SiriusMsgContentKind,
    SiriusMsgReaction,
    SiriusMsgRecipe,
    SiriusMsgRecipeAdapterEnvelope,
    SiriusMsgRecipeIntegrationEnvelope,
    SiriusMsgRichLink,
    SiriusMsgServiceAck,
    SiriusMsgTypingState,
    UnsupportedContentError,
)
from siriusmsg_sdk._models import SiriusMsgServiceRequest, SiriusMsgServiceResponse
from siriusmsg_sdk._transport import canonical_json

REPO_ROOT = Path(__file__).resolve().parents[4]
GOLDEN_DIR = REPO_ROOT / "Schema" / "golden"


def _canonical(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _parse_frame(
    data: dict,
) -> SiriusMsgServiceRequest | SiriusMsgServiceResponse | SiriusMsgRecipe | SiriusMsgRecipeIntegrationEnvelope | SiriusMsgRecipeAdapterEnvelope:
    response_payloads = {
        "health",
        "capabilities",
        "sendResult",
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
                    await write_frame(writer, {"protocolVersion": 1, "requestID": frame["requestID"], "kind": "authenticated"})
                elif frame["kind"] == "subscribe":
                    await write_frame(writer, {"protocolVersion": 1, "requestID": frame["requestID"], "kind": "subscribed"})
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


def test_client_round_trip_against_local_protocol_fixture() -> None:
    asyncio.run(_test_client_round_trip_against_local_protocol_fixture())


async def _test_client_round_trip_against_local_protocol_fixture() -> None:
    attachment_bytes = b"hello sdk"

    with tempfile.TemporaryDirectory() as tmpdir:
        attachment_path = Path(tmpdir) / "attachment.txt"
        attachment_path.write_bytes(attachment_bytes)
        event_response = json.loads((GOLDEN_DIR / "message-event-response.json").read_text())

        async def write_frame(writer: asyncio.StreamWriter, frame: dict) -> None:
            writer.write((_canonical(frame) + "\n").encode("utf-8"))
            await writer.drain()

        def response(name: str, request_id: str) -> dict:
            data = json.loads((GOLDEN_DIR / name).read_text())
            data["requestID"] = request_id
            return data

        def send_response(request_id: str) -> dict:
            return {
                "protocolVersion": 1,
                "requestID": request_id,
                "kind": "sendResult",
                "sendResult": {
                    "accepted": True,
                    "confirmationState": "confirmed",
                    "platformMessageID": "fixture-platform-message",
                    "resolvedContent": {"kind": "text", "text": "fixture"},
                },
            }

        def attachment_response(request_id: str) -> dict:
            return {
                "protocolVersion": 1,
                "requestID": request_id,
                "kind": "attachmentFile",
                "attachmentFile": {
                    "localFilePath": str(attachment_path),
                    "metadata": {
                        "id": "m1-a1",
                        "kind": "document",
                        "state": "materialized",
                        "mimeType": "text/plain",
                        "displayName": "attachment.txt",
                        "byteCount": len(attachment_bytes),
                    },
                },
            }

        async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                while line := await reader.readline():
                    frame = json.loads(line)
                    if frame["kind"] == "authenticate":
                        await write_frame(writer, {"protocolVersion": 1, "requestID": frame["requestID"], "kind": "authenticated"})
                    elif frame["kind"] == "health":
                        await write_frame(writer, response("health-response.json", frame["requestID"]))
                    elif frame["kind"] == "capabilities":
                        await write_frame(writer, response("capabilities-response-local.json", frame["requestID"]))
                    elif frame["kind"] == "send":
                        await write_frame(writer, send_response(frame["requestID"]))
                    elif frame["kind"] == "fetchAttachment":
                        await write_frame(writer, attachment_response(frame["requestID"]))
                    elif frame["kind"] == "subscribe":
                        await write_frame(writer, {"protocolVersion": 1, "requestID": frame["requestID"], "kind": "subscribed"})
                        await write_frame(writer, event_response)
                    elif frame["kind"] == "ack":
                        await write_frame(writer, {"protocolVersion": 1, "requestID": frame["requestID"], "kind": "acked"})
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            client = SiriusMsgClient.loopback(port=port, auth_token="token")
            health = await client.health()
            assert health.state.value in {"healthy", "degraded", "blocked"}
            capabilities = await client.capabilities()
            assert any(cap.feature.value == "sendText" for cap in capabilities)

            sent = await client.send_text("SMS;-;+15555550100", "hello from python")
            assert sent.accepted is True
            link = SiriusMsgRichLink(url="https://example.com/python", kind="plain")
            link_sent = await client.send_rich_link("SMS;-;+15555550100", link)
            assert link_sent.accepted is True

            events = client.subscribe(supports_attachments=True)
            event = await asyncio.wait_for(anext(events), timeout=2)
            assert event.kind.value == "message"
            assert event.message is not None
            assert event.message.text == "hello from golden"
            await client.ack(
                SiriusMsgServiceAck(
                    messageID=event.message.id,
                    chatID=event.message.chatID,
                    rowID=event.message.rowID,
                )
            )
            fetched = await client.fetch_attachment(event.message.attachments[0].id)
            assert fetched.metadata.byteCount == len(attachment_bytes)
            assert await client.fetch_attachment_data(event.message.attachments[0].id) == attachment_bytes
            await events.aclose()

            with pytest.raises(UnsupportedContentError):
                await client.send_reaction("SMS;-;+15555550100", "msg-1", SiriusMsgReaction.like)
        finally:
            server.close()
            await server.wait_closed()
