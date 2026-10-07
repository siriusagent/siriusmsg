import asyncio
from contextlib import asynccontextmanager
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest
from siriusmsg_sdk import SiriusMsgChatID, SiriusMsgMessageID

spec = importlib.util.spec_from_file_location(
    "socket_adapter_example", Path(__file__).parents[1] / "examples/adapter.py"
)
example = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = example
spec.loader.exec_module(example)


def fixture(text="caption", state="confirmed", complete=False):
    message = NS(
        id=SiriusMsgMessageID("message"),
        chatID=SiriusMsgChatID("chat"),
        rowID=1,
        text=text,
        attachments=[NS(id="file", mimeType="video/mp4")],
    )

    async def subscribe(**options):
        assert options["supports_attachments"]
        yield NS(message=message)

    order = []

    async def finish(key):
        order.append("complete")

    async def ack(value):
        order.append("ack")

    typing_calls = []

    @asynccontextmanager
    async def typing(chat_id):
        assert chat_id == message.chatID
        typing_calls.append("start")
        try:
            yield
        finally:
            typing_calls.append("stop")

    result = NS(accepted=True, confirmationState=NS(value=state))
    client = NS(
        typing=typing,
        typing_calls=typing_calls,
        subscribe=subscribe,
        fetch_attachment_data=AsyncMock(return_value=b"verified media"),
        send_content=AsyncMock(return_value=result),
        send_file=AsyncMock(return_value=result),
        ack=AsyncMock(side_effect=ack),
    )
    handler = NS(
        is_complete=AsyncMock(return_value=complete),
        prepare=AsyncMock(
            return_value=example.Reply(text="reply", files=(example.ReplyFile("/owned/result.mp4", "video/mp4"),))
        ),
        complete=AsyncMock(side_effect=finish),
    )
    return client, handler, message, order


@pytest.mark.parametrize("text", ["caption", ""])
def test_adapter_preserves_media_and_completes_before_ack(text):
    client, handler, message, order = fixture(text=text)
    asyncio.run(example.run(client, handler, "connection"))
    args = handler.prepare.call_args.args
    assert args[1] is message and args[1].text == text
    assert args[2] == [(message.attachments[0], b"verified media")]
    assert client.send_file.call_args.args[1:] == ("/owned/result.mp4", "video/mp4")
    assert order == ["complete", "ack"]
    assert client.typing_calls == []


@pytest.mark.parametrize("state", ["unconfirmed", "notRequested", "dispatched"])
def test_adapter_does_not_ack_an_unconfirmed_reply(state):
    client, handler, _, order = fixture(state=state)
    with pytest.raises(example.ReplyNeedsReview):
        asyncio.run(example.run(client, handler, "connection"))
    assert order == []
    handler.complete.assert_not_called()
    client.send_file.assert_not_called()


def test_adapter_rejects_missing_media_before_handler_or_ack():
    client, handler, _, order = fixture()
    client.fetch_attachment_data.side_effect = RuntimeError("attachmentUnavailable")
    with pytest.raises(RuntimeError):
        asyncio.run(example.run(client, handler, "connection"))
    handler.prepare.assert_not_called()
    assert order == []


def test_adapter_completed_replay_only_acks():
    client, handler, _, order = fixture(complete=True)
    asyncio.run(example.run(client, handler, "connection"))
    assert order == ["ack"]
    client.fetch_attachment_data.assert_not_called()
    handler.prepare.assert_not_called()
    client.send_content.assert_not_called()


@pytest.mark.parametrize("text", ["caption", ""])
def test_reference_mode_preserves_all_metadata_without_fetching(text):
    client, handler, message, order = fixture(text=text)
    message.attachments.append(NS(id="unavailable", mimeType="audio/mp4", state="unreadable"))
    client.fetch_attachment_data.side_effect = AssertionError("must not fetch")
    asyncio.run(example.run(client, handler, "connection", attachment_mode="references"))
    assert handler.prepare.call_args.args[1] is message
    assert handler.prepare.call_args.args[2] == [(a, None) for a in message.attachments]
    assert order == ["complete", "ack"]


def test_reference_mode_handler_failure_does_not_ack():
    client, handler, _, order = fixture()
    handler.prepare.side_effect = RuntimeError("reference not durably handled")
    with pytest.raises(RuntimeError):
        asyncio.run(example.run(client, handler, "connection", attachment_mode="references"))
    assert order == []
    client.send_content.assert_not_called()


def test_invalid_attachment_mode_fails_before_subscribing():
    client, handler, _, _ = fixture()
    with pytest.raises(ValueError):
        asyncio.run(example.run(client, handler, "connection", attachment_mode="typo"))
    handler.prepare.assert_not_called()


def test_adapter_partial_reply_reuses_ids_after_restart():
    client, handler, _, order = fixture()
    client.send_file.side_effect = [
        NS(accepted=False, confirmationState=NS(value="notRequested")),
        NS(accepted=True, confirmationState=NS(value="confirmed")),
    ]
    with pytest.raises(example.ReplyNeedsReview):
        asyncio.run(example.run(client, handler, "connection"))
    assert order == []
    asyncio.run(example.run(client, handler, "connection"))
    assert order == ["complete", "ack"]
    assert (
        client.send_content.call_args_list[0].kwargs["operation_id"]
        == client.send_content.call_args_list[1].kwargs["operation_id"]
    )
    assert (
        client.send_file.call_args_list[0].kwargs["operation_id"]
        == client.send_file.call_args_list[1].kwargs["operation_id"]
    )
    assert client.send_content.call_args.kwargs["operation_id"] != client.send_file.call_args.kwargs["operation_id"]


@pytest.mark.parametrize("caption", [None, "Here are the files"])
def test_outbound_all_media_kinds_and_attachment_only(caption):
    client, handler, _, order = fixture()
    files = tuple(
        example.ReplyFile(f"/owned/{name}", mime)
        for name, mime in [
            ("image.png", "image/png"),
            ("audio.m4a", "audio/mp4"),
            ("video.mp4", "video/mp4"),
            ("report.pdf", "application/pdf"),
        ]
    )
    handler.prepare.return_value = example.Reply(text=caption, files=files)
    asyncio.run(example.run(client, handler, "connection"))
    assert client.send_content.call_count == int(caption is not None)
    assert [call.args[1:] for call in client.send_file.call_args_list] == [
        (file.path, file.mime_type) for file in files
    ]
    operations = [call.kwargs["operation_id"] for call in client.send_file.call_args_list]
    assert len(set(operations)) == 4
    assert order == ["complete", "ack"]


def test_partial_file_transport_loss_stops_later_files_and_ack():
    client, handler, _, order = fixture()
    handler.prepare.return_value = example.Reply(
        files=tuple(example.ReplyFile(f"/owned/{i}.png", "image/png") for i in range(3))
    )
    client.send_file.side_effect = [
        NS(accepted=True, confirmationState=NS(value="confirmed")),
        ConnectionError("response lost"),
    ]
    with pytest.raises(ConnectionError):
        asyncio.run(example.run(client, handler, "connection"))
    assert client.send_file.call_count == 2
    assert order == []
    handler.complete.assert_not_called()
