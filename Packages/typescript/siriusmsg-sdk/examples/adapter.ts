/** Reference runner; the consumer supplies its existing durable job store. */
import { createHash } from "node:crypto";
import {
  SiriusMsgClient,
  textContent,
  type SiriusMsgMessageEvent,
  type SiriusMsgAttachmentMetadata,
} from "../src/index.js";

export interface Reply {
  text?: string;
  files?: { path: string; mimeType: string; displayName?: string }[];
}
export interface DurableHandler {
  isComplete(key: string): Promise<boolean>;
  /** Persist the reply before returning; replay returns the same reply/files. */
  prepare(
    key: string,
    message: SiriusMsgMessageEvent,
    attachments: {
      metadata: SiriusMsgAttachmentMetadata;
      data: Uint8Array | null;
    }[],
  ): Promise<Reply>;
  complete(key: string): Promise<void>;
}
export class ReplyNeedsReview extends Error {
  constructor(readonly operationID: string) {
    super(`Reply requires review; operation ID ${operationID}`);
  }
}
export function operationID(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export async function run(
  client: SiriusMsgClient,
  handler: DurableHandler,
  connectionKey: string,
  attachmentMode: "bytes" | "references" = "bytes",
): Promise<void> {
  if (attachmentMode !== "bytes" && attachmentMode !== "references")
    throw new TypeError("attachmentMode must be bytes or references");
  for await (const event of client.subscribe({
    supportsAttachments: true,
    reconnect: true,
  })) {
    if (!event.message) continue;
    const message = event.message;
    const key = operationID(connectionKey, message.chatID, message.id);
    if (!(await handler.isComplete(key))) {
      const attachments = [];
      for (const metadata of message.attachments) {
        attachments.push({
          metadata,
          data:
            attachmentMode === "bytes"
              ? await client.fetchAttachmentData(metadata.id)
              : null,
        });
      }
      const reply = await handler.prepare(key, message, attachments);
      if (reply.text) {
        const operation = operationID(key, "text");
        const result = await client.sendContent(
          message.chatID,
          textContent(reply.text),
          undefined,
          operation,
        );
        if (!result.accepted || result.confirmationState !== "confirmed")
          throw new ReplyNeedsReview(operation);
      }
      for (const [index, file] of (reply.files ?? []).entries()) {
        const operation = operationID(key, "file", String(index));
        const result = await client.sendFile(
          message.chatID,
          file.path,
          file.mimeType,
          { displayName: file.displayName, operationID: operation },
        );
        if (!result.accepted || result.confirmationState !== "confirmed")
          throw new ReplyNeedsReview(operation);
      }
      await handler.complete(key);
    }
    await client.ack({
      messageID: message.id,
      chatID: message.chatID,
      rowID: message.rowID,
    });
  }
}
