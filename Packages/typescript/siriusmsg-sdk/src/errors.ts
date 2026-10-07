export class SiriusMsgSDKError extends Error {}

export class SiriusMsgTransportError extends SiriusMsgSDKError {}

export class SiriusMsgSendOutcomeUnknownError extends SiriusMsgTransportError {
  constructor(
    public readonly operationID: string,
    options?: ErrorOptions,
  ) {
    super(
      `send outcome unknown; retry with operation ID ${operationID}`,
      options,
    );
  }
}

export class SiriusMsgMalformedFrameError extends SiriusMsgTransportError {}

export class AttachmentSizeMismatchError extends SiriusMsgTransportError {
  constructor(
    public readonly attachmentID: string,
    public readonly expectedByteCount: number,
    public readonly actualByteCount: number,
  ) {
    super("attachment byte count does not match");
  }
}

export class AttachmentHashMismatchError extends SiriusMsgTransportError {
  constructor(
    public readonly attachmentID: string,
    public readonly expectedSHA256: string,
    public readonly actualSHA256: string,
  ) {
    super("attachment hash does not match");
  }
}

export class UnsupportedContentError extends SiriusMsgSDKError {
  constructor(
    public readonly feature: string,
    public readonly diagnosticCode: string,
  ) {
    super(`${feature} is unsupported: ${diagnosticCode}`);
  }
}

export class SiriusMsgServiceErrorResponse extends SiriusMsgSDKError {
  constructor(
    public readonly code: string,
    message: string,
    public readonly diagnosticCode?: string,
  ) {
    super(diagnosticCode ? `${message} (${diagnosticCode})` : message);
  }
}

export const errorClassByCode = new Map<
  string,
  typeof SiriusMsgServiceErrorResponse
>([
  ["authRequired", SiriusMsgServiceErrorResponse],
  ["authFailed", SiriusMsgServiceErrorResponse],
  ["protocolVersionUnsupported", SiriusMsgServiceErrorResponse],
  ["malformedFrame", SiriusMsgServiceErrorResponse],
  ["invalidRequest", SiriusMsgServiceErrorResponse],
  ["ackNotOutstanding", SiriusMsgServiceErrorResponse],
  ["subscriptionAlreadyActive", SiriusMsgServiceErrorResponse],
  ["backpressure", SiriusMsgServiceErrorResponse],
  ["sendRejected", SiriusMsgServiceErrorResponse],
  ["peerCredentialsRejected", SiriusMsgServiceErrorResponse],
  ["tokenRotationFailed", SiriusMsgServiceErrorResponse],
  ["transportUnavailable", SiriusMsgServiceErrorResponse],
  ["attachmentNotFound", SiriusMsgServiceErrorResponse],
  ["attachmentNotDelivered", SiriusMsgServiceErrorResponse],
  ["attachmentUnavailable", SiriusMsgServiceErrorResponse],
  ["attachmentTransportUnsupported", SiriusMsgServiceErrorResponse],
  ["attachmentHashMismatch", SiriusMsgServiceErrorResponse],
  ["attachmentTooLarge", SiriusMsgServiceErrorResponse],
  ["attachmentUnsupportedType", SiriusMsgServiceErrorResponse],
  ["internalError", SiriusMsgServiceErrorResponse],
]);

export function serviceError(
  code: string,
  message: string,
  diagnosticCode?: string,
): SiriusMsgServiceErrorResponse {
  const ErrorType = errorClassByCode.get(code) ?? SiriusMsgServiceErrorResponse;
  return new ErrorType(code, message, diagnosticCode);
}

/**
 * Reserved compatibility type; managed typing scopes do not raise it. Managed
 * typing is advisory, so inspect `SiriusMsgSendResult.confirmationState`
 * instead of treating typing failures as delivery facts.
 */
export class SiriusMsgTypingCleanupError extends Error {
  readonly requiresReview = true;
  constructor() {
    super(
      "Typing cleanup could not be verified. Check Messages before retrying.",
    );
    this.name = "SiriusMsgTypingCleanupError";
  }
}
