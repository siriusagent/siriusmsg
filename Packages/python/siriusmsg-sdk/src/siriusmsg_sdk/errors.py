"""Typed SiriusMsg SDK errors."""

from __future__ import annotations

from typing import Optional, Type


class SiriusMsgSDKError(Exception):
    """Base SDK error."""


class SiriusMsgTransportError(SiriusMsgSDKError):
    """Socket, framing, or local transport failure."""


class SiriusMsgSendOutcomeUnknownError(SiriusMsgTransportError):
    """A send may have reached the service; retry with the same operation ID."""

    def __init__(self, operation_id: str) -> None:
        self.operation_id = operation_id
        super().__init__(f"send outcome unknown; retry with operation ID {operation_id}")


class SiriusMsgMalformedFrameError(SiriusMsgTransportError):
    """A peer returned malformed JSON or a frame that failed validation."""


class UnsupportedContentError(SiriusMsgSDKError):
    """Raised before send when the capability matrix rejects content."""

    def __init__(self, feature: str, diagnostic_code: str) -> None:
        self.feature = feature
        self.diagnostic_code = diagnostic_code
        super().__init__(f"{feature} is unsupported: {diagnostic_code}")


class SiriusMsgServiceErrorResponse(SiriusMsgSDKError):
    code = "internalError"

    def __init__(self, message: str, diagnostic_code: Optional[str] = None) -> None:
        self.message = message
        self.diagnostic_code = diagnostic_code
        super().__init__(message if diagnostic_code is None else f"{message} ({diagnostic_code})")


class AuthRequiredError(SiriusMsgServiceErrorResponse):
    code = "authRequired"


class AuthFailedError(SiriusMsgServiceErrorResponse):
    code = "authFailed"


class ProtocolVersionUnsupportedError(SiriusMsgServiceErrorResponse):
    code = "protocolVersionUnsupported"


class MalformedFrameServiceError(SiriusMsgServiceErrorResponse):
    code = "malformedFrame"


class InvalidRequestError(SiriusMsgServiceErrorResponse):
    code = "invalidRequest"


class AckNotOutstandingError(SiriusMsgServiceErrorResponse):
    code = "ackNotOutstanding"


class SubscriptionAlreadyActiveError(SiriusMsgServiceErrorResponse):
    code = "subscriptionAlreadyActive"


class BackpressureError(SiriusMsgServiceErrorResponse):
    code = "backpressure"


class SendRejectedError(SiriusMsgServiceErrorResponse):
    code = "sendRejected"


class PeerCredentialsRejectedError(SiriusMsgServiceErrorResponse):
    code = "peerCredentialsRejected"


class TokenRotationFailedError(SiriusMsgServiceErrorResponse):
    code = "tokenRotationFailed"


class TransportUnavailableError(SiriusMsgServiceErrorResponse):
    code = "transportUnavailable"


class AttachmentNotFoundError(SiriusMsgServiceErrorResponse):
    code = "attachmentNotFound"


class AttachmentNotDeliveredError(SiriusMsgServiceErrorResponse):
    code = "attachmentNotDelivered"


class AttachmentUnavailableError(SiriusMsgServiceErrorResponse):
    code = "attachmentUnavailable"

    def __init__(
        self,
        message: str,
        diagnostic_code: Optional[str] = None,
        *,
        attachment_id: Optional[str] = None,
    ) -> None:
        self.attachment_id = attachment_id
        super().__init__(message, diagnostic_code)


class AttachmentSizeMismatchError(AttachmentUnavailableError):
    """The fetched file length did not match its authenticated metadata."""

    def __init__(self, attachment_id: str, expected_byte_count: int, actual_byte_count: int) -> None:
        self.expected_byte_count = expected_byte_count
        self.actual_byte_count = actual_byte_count
        super().__init__(
            "attachment byte count does not match",
            attachment_id=attachment_id,
        )


class AttachmentTransportUnsupportedError(SiriusMsgServiceErrorResponse):
    code = "attachmentTransportUnsupported"


class AttachmentHashMismatchError(SiriusMsgServiceErrorResponse):
    code = "attachmentHashMismatch"

    def __init__(
        self,
        message: str,
        diagnostic_code: Optional[str] = None,
        *,
        attachment_id: Optional[str] = None,
        expected_sha256: Optional[str] = None,
        actual_sha256: Optional[str] = None,
    ) -> None:
        self.attachment_id = attachment_id
        self.expected_sha256 = expected_sha256
        self.actual_sha256 = actual_sha256
        super().__init__(message, diagnostic_code)


class AttachmentTooLargeError(SiriusMsgServiceErrorResponse):
    code = "attachmentTooLarge"


class AttachmentUnsupportedTypeError(SiriusMsgServiceErrorResponse):
    code = "attachmentUnsupportedType"


class InternalServiceError(SiriusMsgServiceErrorResponse):
    code = "internalError"


ERROR_BY_CODE: dict[str, Type[SiriusMsgServiceErrorResponse]] = {
    cls.code: cls
    for cls in [
        AuthRequiredError,
        AuthFailedError,
        ProtocolVersionUnsupportedError,
        MalformedFrameServiceError,
        InvalidRequestError,
        AckNotOutstandingError,
        SubscriptionAlreadyActiveError,
        BackpressureError,
        SendRejectedError,
        PeerCredentialsRejectedError,
        TokenRotationFailedError,
        TransportUnavailableError,
        AttachmentNotFoundError,
        AttachmentNotDeliveredError,
        AttachmentUnavailableError,
        AttachmentTransportUnsupportedError,
        AttachmentHashMismatchError,
        AttachmentTooLargeError,
        AttachmentUnsupportedTypeError,
        InternalServiceError,
    ]
}


def error_from_service(code: str, message: str, diagnostic_code: Optional[str] = None) -> SiriusMsgServiceErrorResponse:
    error_type = ERROR_BY_CODE.get(code, SiriusMsgServiceErrorResponse)
    return error_type(message, diagnostic_code)


class SiriusMsgTypingCleanupError(SiriusMsgSDKError):
    """Reserved compatibility type; managed typing scopes do not raise it.

    Managed typing is advisory, so typing start/stop failures never surface here.
    Inspect ``SiriusMsgSendResult.confirmationState`` for delivery facts.
    """

    requires_review = True

    def __init__(self) -> None:
        super().__init__("Typing cleanup could not be verified. Check Messages before retrying.")
