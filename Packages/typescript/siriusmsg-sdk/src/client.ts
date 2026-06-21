import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  SiriusMsgAllowlist,
  SiriusMsgAttachmentFileReference,
  SiriusMsgAuthTokenRotationResult,
  SiriusMsgCapability,
  SiriusMsgContent,
  SiriusMsgEditContent,
  SiriusMsgFeature,
  SiriusMsgHealth,
  SiriusMsgMessageEffectContent,
  SiriusMsgOutboundAttachment,
  SiriusMsgReaction,
  SiriusMsgReplyContent,
  SiriusMsgRichLink,
  SiriusMsgSendRequest,
  SiriusMsgSendResult,
  SiriusMsgServiceAck,
  SiriusMsgServiceEvent,
  SiriusMsgServiceRequest,
  SiriusMsgServiceResponse,
  SiriusMsgTransport,
  SiriusMsgTypingState,
  SiriusMsgUnsendContent,
} from "./_models.js";
import { SiriusMsgTransportError, UnsupportedContentError, serviceError } from "./errors.js";
import {
  Endpoint,
  NDJSONConnection,
  defaultSocketPath,
  defaultTokenPath,
  loadAuthToken,
  protocolVersion,
  requestID,
} from "./transport.js";

const unsupportedLocalDiagnostic = "unsupportedByLocalMessagesAutomation";

type PendingSubscriptionResponse = {
  resolve: (response: SiriusMsgServiceResponse) => void;
  reject: (error: unknown) => void;
};

export function textContent(text: string): SiriusMsgContent {
  return { kind: "text", text };
}

export function richLinkContent(richLink: SiriusMsgRichLink): SiriusMsgContent {
  return { kind: "richLink", richLink };
}

export function attachmentContent(attachment: SiriusMsgOutboundAttachment): SiriusMsgContent {
  return { kind: "attachment", attachment };
}

export function reactionContent(targetMessageID: string, reaction: SiriusMsgReaction, action = "added" as const): SiriusMsgContent {
  return { kind: "reaction", reaction: { targetMessageID, reaction, action } };
}

export function replyContent(targetMessageID: string, text: string): SiriusMsgContent {
  const reply: SiriusMsgReplyContent = { targetMessageID, text };
  return { kind: "reply", reply };
}

export function editContent(targetMessageID: string, replacementText: string): SiriusMsgContent {
  const edit: SiriusMsgEditContent = { targetMessageID, replacementText };
  return { kind: "edit", edit };
}

export function unsendContent(targetMessageID: string): SiriusMsgContent {
  const unsend: SiriusMsgUnsendContent = { targetMessageID };
  return { kind: "unsend", unsend };
}

export function messageEffectContent(text: string, effectName: string): SiriusMsgContent {
  const messageEffect: SiriusMsgMessageEffectContent = { text, effectName };
  return { kind: "messageEffect", messageEffect };
}

export class SiriusMsgClient {
  private subscriptionConnection?: NDJSONConnection;
  private subscriptionPending?: Map<string, PendingSubscriptionResponse>;

  constructor(
    private readonly endpoint: Endpoint,
    private authToken: string,
  ) {}

  static async connect(opts: { socketPath?: string; tokenPath?: string } = {}): Promise<SiriusMsgClient> {
    const client = new SiriusMsgClient(
      { socketPath: opts.socketPath ?? defaultSocketPath },
      await loadAuthToken(opts.tokenPath ?? defaultTokenPath),
    );
    await client.health();
    return client;
  }

  static loopback(opts: { port: number; authToken: string }): SiriusMsgClient {
    return new SiriusMsgClient({ port: opts.port }, opts.authToken);
  }

  async health(): Promise<SiriusMsgHealth> {
    const response = await this.perform("health");
    if (response.kind !== "health" || !response.health) {
      throw new SiriusMsgTransportError("unexpected health response");
    }
    return response.health;
  }

  async capabilities(transport: SiriusMsgTransport = "localMessagesAutomation"): Promise<SiriusMsgCapability[]> {
    const response = await this.perform("capabilities", { transport });
    if (response.kind !== "capabilities" || !response.capabilities) {
      throw new SiriusMsgTransportError("unexpected capabilities response");
    }
    return response.capabilities;
  }

  async send(request: SiriusMsgSendRequest): Promise<SiriusMsgSendResult> {
    const response = await this.perform("send", { sendRequest: request });
    if (response.kind !== "sendResult" || !response.sendResult) {
      throw new SiriusMsgTransportError("unexpected send response");
    }
    return response.sendResult;
  }

  async sendContent(chatID: string, content: SiriusMsgContent, accountID?: string): Promise<SiriusMsgSendResult> {
    await this.checkSupported(content);
    return this.send({ chatID, text: fallbackText(content), accountID, content });
  }

  async sendText(chatID: string, text: string, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, textContent(text), accountID);
  }

  async sendRichLink(chatID: string, richLink: SiriusMsgRichLink, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, richLinkContent(richLink), accountID);
  }

  async sendAttachment(chatID: string, attachment: SiriusMsgOutboundAttachment, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, attachmentContent(attachment), accountID);
  }

  async sendReaction(chatID: string, targetMessageID: string, reaction: SiriusMsgReaction, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, reactionContent(targetMessageID, reaction), accountID);
  }

  async sendThreadedReply(chatID: string, targetMessageID: string, text: string, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, replyContent(targetMessageID, text), accountID);
  }

  async sendEdit(chatID: string, targetMessageID: string, replacementText: string, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, editContent(targetMessageID, replacementText), accountID);
  }

  async sendUnsend(chatID: string, targetMessageID: string, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, unsendContent(targetMessageID), accountID);
  }

  async sendTyping(chatID: string, state: SiriusMsgTypingState, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, { kind: "typing", typing: state }, accountID);
  }

  async sendMessageEffect(chatID: string, text: string, effectName: string, accountID?: string): Promise<SiriusMsgSendResult> {
    return this.sendContent(chatID, messageEffectContent(text, effectName), accountID);
  }

  async updateAllowlist(allowlist: SiriusMsgAllowlist): Promise<void> {
    const response = await this.perform("updateAllowlist", { allowlist });
    if (response.kind !== "allowlistUpdated") {
      throw new SiriusMsgTransportError("unexpected allowlist response");
    }
  }

  async rotateAuthToken(): Promise<SiriusMsgAuthTokenRotationResult> {
    const response = await this.perform("rotateAuthToken");
    if (response.kind !== "authTokenRotated" || !response.authTokenRotationResult) {
      throw new SiriusMsgTransportError("unexpected token rotation response");
    }
    this.authToken = response.authTokenRotationResult.token;
    return response.authTokenRotationResult;
  }

  async ack(ack: SiriusMsgServiceAck): Promise<void> {
    const subscriptionConnection = this.subscriptionConnection;
    const subscriptionPending = this.subscriptionPending;
    if (subscriptionConnection && subscriptionPending) {
      const frame: SiriusMsgServiceRequest = {
        protocolVersion,
        requestID: requestID("ack"),
        kind: "ack",
        ack,
      };
      const responsePromise = new Promise<SiriusMsgServiceResponse>((resolve, reject) => {
        subscriptionPending.set(frame.requestID, { resolve, reject });
      });
      try {
        await subscriptionConnection.write(frame);
      } catch (error) {
        subscriptionPending.delete(frame.requestID);
        throw error;
      }
      const response = await responsePromise;
      this.raiseIfError(response);
      if (response.kind !== "acked") {
        throw new SiriusMsgTransportError("unexpected ack response");
      }
      return;
    }
    const response = await this.perform("ack", { ack });
    if (response.kind !== "acked") {
      throw new SiriusMsgTransportError("unexpected ack response");
    }
  }

  async fetchAttachment(id: string): Promise<SiriusMsgAttachmentFileReference> {
    const response = await this.perform("fetchAttachment", { attachmentFetch: { attachmentID: id } });
    if (response.kind !== "attachmentFile" || !response.attachmentFile) {
      throw new SiriusMsgTransportError("unexpected attachment response");
    }
    return response.attachmentFile;
  }

  async fetchAttachmentData(id: string): Promise<Uint8Array> {
    const file = await this.fetchAttachment(id);
    const bytes = await readFile(file.localFilePath);
    if (bytes.length !== file.metadata.byteCount) {
      throw new SiriusMsgTransportError("attachment byte count does not match");
    }
    if (file.metadata.sha256 && createHash("sha256").update(bytes).digest("hex") !== file.metadata.sha256) {
      throw new SiriusMsgTransportError("attachment hash does not match");
    }
    return bytes;
  }

  async *subscribe(opts: { supportsAttachments?: boolean; reconnect?: boolean } = {}): AsyncIterableIterator<SiriusMsgServiceEvent> {
    let backoff = 100;
    while (true) {
      const connection = new NDJSONConnection(this.endpoint);
      const pending = new Map<string, PendingSubscriptionResponse>();
      const events = new AsyncSubscriptionQueue<SiriusMsgServiceEvent>();
      try {
        await connection.open();
        await connection.authenticate(this.authToken);
        await connection.write({
          protocolVersion,
          requestID: requestID("subscribe"),
          kind: "subscribe",
          subscriptionOptions: { supportsAttachments: opts.supportsAttachments ?? false },
        });
        const subscribed = await connection.readResponse();
        this.raiseIfError(subscribed);
        if (subscribed.kind !== "subscribed") {
          throw new SiriusMsgTransportError("unexpected subscribe response");
        }
        this.subscriptionConnection = connection;
        this.subscriptionPending = pending;
        void this.pumpSubscription(connection, pending, events);
        while (true) {
          yield await events.next();
        }
      } catch (error) {
        if (!opts.reconnect) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 2000);
      } finally {
        if (this.subscriptionConnection === connection) {
          this.subscriptionConnection = undefined;
          this.subscriptionPending = undefined;
        }
        this.rejectSubscriptionPending(pending, new SiriusMsgTransportError("subscription closed"));
        events.fail(new SiriusMsgTransportError("subscription closed"));
        connection.close();
      }
    }
  }

  private async pumpSubscription(
    connection: NDJSONConnection,
    pending: Map<string, PendingSubscriptionResponse>,
    events: AsyncSubscriptionQueue<SiriusMsgServiceEvent>,
  ): Promise<void> {
    try {
      while (true) {
        const response = await connection.readResponse();
        if (this.routeSubscriptionResponse(response, pending, events)) {
          continue;
        }
        this.raiseIfError(response);
      }
    } catch (error) {
      this.rejectSubscriptionPending(pending, error);
      events.fail(error);
    }
  }

  private routeSubscriptionResponse(
    response: SiriusMsgServiceResponse,
    pending: Map<string, PendingSubscriptionResponse>,
    events: AsyncSubscriptionQueue<SiriusMsgServiceEvent>,
  ): boolean {
    if (response.requestID) {
      const waiter = pending.get(response.requestID);
      if (waiter) {
        pending.delete(response.requestID);
        try {
          this.raiseIfError(response);
          waiter.resolve(response);
        } catch (error) {
          waiter.reject(error);
        }
        return true;
      }
    }

    if (response.kind === "event" && response.event) {
      events.push(response.event);
      return true;
    }

    return false;
  }

  private rejectSubscriptionPending(pending: Map<string, PendingSubscriptionResponse>, error: unknown): void {
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  }

  private async perform(kind: SiriusMsgServiceRequest["kind"], payload: Partial<SiriusMsgServiceRequest> = {}): Promise<SiriusMsgServiceResponse> {
    const connection = new NDJSONConnection(this.endpoint);
    await connection.open();
    try {
      await connection.authenticate(this.authToken);
      const frame: SiriusMsgServiceRequest = {
        protocolVersion,
        requestID: requestID(kind),
        kind,
        ...payload,
      };
      await connection.write(frame);
      const response = await connection.readResponse();
      this.raiseIfError(response);
      if (response.requestID && response.requestID !== frame.requestID) {
        throw new SiriusMsgTransportError("response requestID did not match request");
      }
      return response;
    } finally {
      connection.close();
    }
  }

  private async checkSupported(content: SiriusMsgContent): Promise<void> {
    const feature = featureForContent(content);
    const caps = await this.capabilities();
    const cap = caps.find((item) => item.feature === feature && item.transport === "localMessagesAutomation");
    if (!cap) {
      throw new UnsupportedContentError(feature, unsupportedLocalDiagnostic);
    }
    if (["unsupported", "researchGated", "providerOnly"].includes(cap.support)) {
      throw new UnsupportedContentError(feature, cap.diagnosticCode ?? unsupportedLocalDiagnostic);
    }
  }

  private raiseIfError(response: SiriusMsgServiceResponse): void {
    if (response.kind === "error" && response.error) {
      throw serviceError(response.error.code, response.error.message, response.error.diagnosticCode);
    }
  }
}

class AsyncSubscriptionQueue<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  private failure?: unknown;

  push(value: T): void {
    if (this.failure) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
    } else {
      this.values.push(value);
    }
  }

  fail(error: unknown): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters = [];
  }

  next(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve(value);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function featureForContent(content: SiriusMsgContent): SiriusMsgFeature {
  switch (content.kind) {
    case "text":
      return "sendText";
    case "attachment":
      return "sendFile";
    case "richLink":
      return "sendRichLink";
    case "reaction":
      return "sendReaction";
    case "reply":
      return "sendThreadedReply";
    case "edit":
      return "sendEdit";
    case "unsend":
      return "sendUnsend";
    case "typing":
      return "sendTypingIndicator";
    case "messageEffect":
      return "sendMessageEffect";
    case "unsupported":
      return content.unsupported?.feature ?? "sendText";
  }
}

function fallbackText(content: SiriusMsgContent): string {
  if (content.kind === "text") return content.text ?? "";
  if (content.kind === "richLink") return content.richLink?.url ?? "";
  if (content.kind === "reply") return content.reply?.text ?? "";
  if (content.kind === "edit") return content.edit?.replacementText ?? "";
  if (content.kind === "messageEffect") return content.messageEffect?.text ?? "";
  return "";
}
