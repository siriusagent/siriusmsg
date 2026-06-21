"""Hand-written asyncio NDJSON transport for the SiriusMsg local protocol."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Optional
from uuid import uuid4

from pydantic import BaseModel, RootModel, ValidationError

from siriusmsg_sdk._models import SiriusMsgServiceRequest, SiriusMsgServiceResponse
from siriusmsg_sdk.errors import SiriusMsgMalformedFrameError, SiriusMsgTransportError


DEFAULT_RUNTIME_DIR = Path.home() / "Library" / "Application Support" / "SiriusMsg"
DEFAULT_SOCKET_PATH = DEFAULT_RUNTIME_DIR / "siriusmsg.sock"
DEFAULT_TOKEN_PATH = DEFAULT_RUNTIME_DIR / "service-token.json"
PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class Endpoint:
    socket_path: Optional[Path] = None
    port: Optional[int] = None

    @classmethod
    def unix(cls, socket_path: str | Path = DEFAULT_SOCKET_PATH) -> "Endpoint":
        return cls(socket_path=Path(socket_path))

    @classmethod
    def loopback(cls, port: int) -> "Endpoint":
        return cls(port=port)


def request_id(prefix: str = "sdk") -> str:
    return f"{prefix}-{uuid4()}"


def canonical_data(value: Any) -> dict[str, Any]:
    if isinstance(value, BaseModel):
        return _drop_none(value.model_dump(mode="json", exclude_none=True))
    if isinstance(value, RootModel):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return _drop_none(dict(value))
    raise TypeError(f"unsupported frame type: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(canonical_data(value), ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _drop_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _drop_none(child) for key, child in value.items() if child is not None}
    if isinstance(value, list):
        return [_drop_none(child) for child in value]
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def load_auth_token(token_path: str | Path = DEFAULT_TOKEN_PATH) -> str:
    try:
        data = json.loads(Path(token_path).read_text())
    except OSError as exc:
        raise SiriusMsgTransportError(f"auth token unavailable at {token_path}") from exc
    token = data.get("token")
    if not isinstance(token, str) or not token:
        raise SiriusMsgTransportError(f"auth token unavailable at {token_path}")
    return token


class NDJSONConnection:
    def __init__(self, endpoint: Endpoint) -> None:
        self.endpoint = endpoint
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None

    async def __aenter__(self) -> "NDJSONConnection":
        await self.open()
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.close()

    async def open(self) -> None:
        try:
            if self.endpoint.socket_path is not None:
                self.reader, self.writer = await asyncio.open_unix_connection(str(self.endpoint.socket_path))
            elif self.endpoint.port is not None:
                self.reader, self.writer = await asyncio.open_connection("127.0.0.1", self.endpoint.port)
            else:
                raise SiriusMsgTransportError("endpoint missing socket path or port")
        except OSError as exc:
            raise SiriusMsgTransportError(str(exc)) from exc

    async def authenticate(self, auth_token: str) -> None:
        await self.write(
            SiriusMsgServiceRequest(
                protocolVersion=PROTOCOL_VERSION,
                requestID=request_id("auth"),
                kind="authenticate",
                authToken=auth_token,
            )
        )
        response = await self.read_response()
        if response.kind.value != "authenticated":
            if response.kind.value == "error" and response.error is not None:
                from siriusmsg_sdk.errors import error_from_service

                raise error_from_service(
                    response.error.code.value,
                    response.error.message,
                    response.error.diagnosticCode,
                )
            raise SiriusMsgTransportError("authentication failed")

    async def write(self, frame: SiriusMsgServiceRequest | Mapping[str, Any]) -> None:
        if self.writer is None:
            raise SiriusMsgTransportError("connection is not open")
        self.writer.write((canonical_json(frame) + "\n").encode("utf-8"))
        await self.writer.drain()

    async def read_response(self) -> SiriusMsgServiceResponse:
        if self.reader is None:
            raise SiriusMsgTransportError("connection is not open")
        line = await self.reader.readline()
        if not line:
            raise SiriusMsgTransportError("connection closed")
        try:
            decoded = json.loads(line)
            return SiriusMsgServiceResponse.model_validate(decoded)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise SiriusMsgMalformedFrameError(str(exc)) from exc

    async def close(self) -> None:
        if self.writer is not None:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except OSError:
                pass
        self.reader = None
        self.writer = None
