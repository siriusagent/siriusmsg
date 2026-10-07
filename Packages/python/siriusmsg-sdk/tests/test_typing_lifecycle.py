import asyncio
from types import SimpleNamespace

import pytest

from siriusmsg_sdk._models import SiriusMsgTypingState
from siriusmsg_sdk._typing import managed_typing


def test_typing_renews_then_stops_before_reply():
    async def run():
        states = []

        async def send(state):
            states.append(state)
            return SimpleNamespace(accepted=True)

        async with managed_typing(send, interval=0.001):
            while len(states) < 3:
                await asyncio.sleep(0.001)
        assert states[-1] == SiriusMsgTypingState.stopped
        assert states.count(SiriusMsgTypingState.stopped) == 1

    asyncio.run(run())


@pytest.mark.parametrize("mode", ["immediate", "error", "cancel", "stop_rejected", "start_rejected", "start_unknown"])
def test_typing_exit_paths(mode):
    async def run():
        states = []
        entered = False

        async def send(state):
            states.append(state)
            if mode == "start_unknown" and state == SiriusMsgTypingState.started:
                raise RuntimeError("lost receipt")
            return SimpleNamespace(
                accepted=not (
                    (mode == "start_rejected" and state == SiriusMsgTypingState.started)
                    or (mode == "stop_rejected" and state == SiriusMsgTypingState.stopped)
                )
            )

        async def operation():
            nonlocal entered
            async with managed_typing(send):
                entered = True
                if mode == "error":
                    raise ValueError("handler error")
                if mode == "cancel":
                    await asyncio.sleep(60)

        task = asyncio.create_task(operation())
        if mode == "cancel":
            while not entered:
                await asyncio.sleep(0)
            task.cancel()
        expected = {
            "error": ValueError,
            "cancel": asyncio.CancelledError,
        }.get(mode)
        if expected:
            with pytest.raises(expected):
                await task
        else:
            await task
        if mode == "start_rejected":
            assert states == [SiriusMsgTypingState.started]
        else:
            assert states == [SiriusMsgTypingState.started, SiriusMsgTypingState.stopped]
        assert entered

    asyncio.run(run())


@pytest.mark.parametrize("available", [False, True])
def test_client_typing_scope_uses_advertised_capability(available):
    from unittest.mock import AsyncMock

    from siriusmsg_sdk import SiriusMsgClient
    from siriusmsg_sdk._models import SiriusMsgCapabilitySupport, SiriusMsgFeature

    async def run():
        client = object.__new__(SiriusMsgClient)
        client.capabilities = AsyncMock(
            return_value=[
                SimpleNamespace(
                    feature=SiriusMsgFeature.sendTypingIndicator,
                    support=SiriusMsgCapabilitySupport.supported,
                )
            ]
            if available
            else []
        )
        client.send_typing = AsyncMock(return_value=SimpleNamespace(accepted=True))
        async with client.typing("allowed"):
            pass
        assert client.send_typing.await_count == (2 if available else 0)

    asyncio.run(run())


def test_typing_capability_revoked_before_dispatch_still_prepares():
    from siriusmsg_sdk.errors import UnsupportedContentError

    async def run():
        calls = []

        async def send(state):
            calls.append(state)
            raise UnsupportedContentError("sendTypingIndicator", "disabled")

        async with managed_typing(send):
            calls.append("prepared")
        assert calls == [SiriusMsgTypingState.started, "prepared"]

    asyncio.run(run())
