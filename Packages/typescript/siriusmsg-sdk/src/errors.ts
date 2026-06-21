export class SiriusMsgSDKError extends Error {}

export class SiriusMsgTransportError extends SiriusMsgSDKError {}

export class SiriusMsgMalformedFrameError extends SiriusMsgTransportError {}

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

export const errorClassByCode = new Map<string, typeof SiriusMsgServiceErrorResponse>([
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

export function serviceError(code: string, message: string, diagnosticCode?: string): SiriusMsgServiceErrorResponse {
  const ErrorType = errorClassByCode.get(code) ?? SiriusMsgServiceErrorResponse;
  return new ErrorType(code, message, diagnosticCode);
}
