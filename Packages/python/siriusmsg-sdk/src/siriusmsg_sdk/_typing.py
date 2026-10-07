"""Managed reply-preparation typing lifecycle."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from siriusmsg_sdk._models import SiriusMsgTypingState
from siriusmsg_sdk.errors import UnsupportedContentError


@asynccontextmanager
async def managed_typing(send, interval: float = 2.0) -> AsyncIterator[None]:
    try:
        started = (await send(SiriusMsgTypingState.started)).accepted
    except UnsupportedContentError:
        # Capability changed before dispatch; ordinary preparation is still safe.
        yield
        return
    except BaseException as start_error:
        # A lost receipt may still own typing. Stop best-effort; typing is
        # advisory and must not suppress or replay agent work.
        async def uncertain_stop():
            try:
                await send(SiriusMsgTypingState.stopped)
            except Exception:
                pass

        await asyncio.shield(asyncio.create_task(uncertain_stop()))
        if isinstance(start_error, asyncio.CancelledError):
            raise
        yield
        return
    if not started:
        yield
        return

    async def renew():
        try:
            while True:
                await asyncio.sleep(interval)
                if not (await send(SiriusMsgTypingState.started)).accepted:
                    break
        except (Exception, asyncio.CancelledError):
            pass

    heartbeat = asyncio.create_task(renew())

    async def cleanup():
        heartbeat.cancel()
        try:
            await heartbeat
        except asyncio.CancelledError:
            pass
        try:
            await send(SiriusMsgTypingState.stopped)
        except Exception:
            pass  # Delivery retains its own service safety and receipt checks.

    try:
        yield
    except BaseException:
        try:
            await asyncio.shield(asyncio.create_task(cleanup()))
        except Exception:
            pass
        raise
    else:
        await asyncio.shield(asyncio.create_task(cleanup()))
