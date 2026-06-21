import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  SiriusMsgClient,
  UnsupportedContentError,
  SiriusMsgMalformedFrameError,
  assertSafeRowIDs,
  canonicalJSONString,
  validateDefinition,
  validateRequest,
  validateResponse,
  type SiriusMsgServiceRequest,
  type SiriusMsgServiceResponse,
} from "../src/index.js";

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../../../..");
const goldenDir = join(repoRoot, "Schema", "golden");

function canonical(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJSONString(value)));
}

function validateFrame(frame: Record<string, unknown>): SiriusMsgServiceRequest | SiriusMsgServiceResponse {
  const responsePayloads = new Set([
    "health",
    "capabilities",
    "sendResult",
    "authTokenRotationResult",
    "event",
    "attachmentFile",
    "error",
  ]);
  const responseKinds = new Set([
    "authenticated",
    "authTokenRotated",
    "subscribed",
    "acked",
    "sendResult",
    "allowlistUpdated",
    "attachmentFile",
    "event",
    "error",
  ]);
  if (responseKinds.has(String(frame.kind)) || Object.keys(frame).some((key) => responsePayloads.has(key))) {
    validateResponse(frame);
    return frame as SiriusMsgServiceResponse;
  }
  if ("recipe" in frame && "triggerEvent" in frame) {
    validateDefinition("SiriusMsgRecipeAdapterEnvelope", frame);
    return frame as SiriusMsgServiceRequest;
  }
  if ("recipeID" in frame && "recipeName" in frame) {
    validateDefinition("SiriusMsgRecipeIntegrationEnvelope", frame);
    return frame as SiriusMsgServiceRequest;
  }
  if ("actions" in frame && "trigger" in frame) {
    validateDefinition("SiriusMsgRecipe", frame);
    return frame as SiriusMsgServiceRequest;
  }
  validateRequest(frame);
  return frame as SiriusMsgServiceRequest;
}

function withTimeout<T>(promise: Promise<T>, message: string, ms = 2_000): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

describe("@siriusmsg/sdk", () => {
  test("golden frames validate and re-encode canonically", async () => {
    for (const name of await readdir(goldenDir)) {
      const lines = readFileSync(join(goldenDir, name), "utf8").trim().split("\n");
      for (const line of lines) {
        const frame = JSON.parse(line);
        const validated = validateFrame(frame);
        expect(canonical(validated), name).toEqual(canonical(frame));
      }
    }
  });

  test("rowID precision guard rejects unsafe integers", () => {
    expect(() => assertSafeRowIDs({ rowID: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/rowID exceeds/);
    expect(() => assertSafeRowIDs({ rowID: Number.MAX_SAFE_INTEGER })).not.toThrow();
  });

  test("unknown enum values fail validation cleanly", () => {
    expect(() => validateRequest({ protocolVersion: 1, requestID: "future-kind", kind: "futureKind" })).toThrow(
      SiriusMsgMalformedFrameError,
    );
  });

  test("capability gating rejects unsupported content before send", async () => {
    const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
    const caps = (validateFrame(JSON.parse(readFileSync(join(goldenDir, "capabilities-response-local.json"), "utf8"))) as SiriusMsgServiceResponse)
      .capabilities;
    (client as unknown as { capabilities: () => unknown }).capabilities = async () => caps;
    (client as unknown as { send: () => unknown }).send = async () => {
      throw new Error("send must not be called");
    };
    const unsupportedCalls = [
      () => client.sendReaction("SMS;-;+15555550100", "target", "like"),
      () => client.sendThreadedReply("SMS;-;+15555550100", "target", "threaded reply"),
      () => client.sendEdit("SMS;-;+15555550100", "target", "replacement"),
      () => client.sendUnsend("SMS;-;+15555550100", "target"),
      () => client.sendTyping("SMS;-;+15555550100", "started"),
      () => client.sendMessageEffect("SMS;-;+15555550100", "boom", "slam"),
    ];
    for (const unsupportedCall of unsupportedCalls) {
      await expect(unsupportedCall()).rejects.toBeInstanceOf(UnsupportedContentError);
    }
  });

  test("subscription ack tolerates interleaved event frames", async () => {
    const eventResponse = JSON.parse(readFileSync(join(goldenDir, "message-event-response.json"), "utf8")) as SiriusMsgServiceResponse;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";
      const writeFrame = (frame: SiriusMsgServiceResponse) => {
        socket.write(`${canonicalJSONString(frame)}\n`);
      };

      socket.on("data", (chunk) => {
        buffer += String(chunk);
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) {
            continue;
          }
          const request = JSON.parse(line) as SiriusMsgServiceRequest;
          if (request.kind === "authenticate") {
            writeFrame({ protocolVersion: 1, requestID: request.requestID, kind: "authenticated" });
          } else if (request.kind === "subscribe") {
            writeFrame({ protocolVersion: 1, requestID: request.requestID, kind: "subscribed" });
            writeFrame(eventResponse);
          } else if (request.kind === "ack") {
            writeFrame(eventResponse);
            writeFrame({ protocolVersion: 1, requestID: request.requestID, kind: "acked" });
          }
        }
      });
    });

    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });

    try {
      const address = server.address() as AddressInfo;
      const client = SiriusMsgClient.loopback({ port: address.port, authToken: "token" });
      const stream = client.subscribe({ supportsAttachments: true });
      const first = await withTimeout(stream.next(), "timed out waiting for first event");
      if (!first.value?.message) {
        throw new Error("expected first message event");
      }
      await withTimeout(
        client.ack({
          messageID: first.value.message.id,
          chatID: first.value.message.chatID,
          rowID: first.value.message.rowID,
        }),
        "timed out waiting for ack",
      );
      const second = await withTimeout(stream.next(), "timed out waiting for interleaved event");
      expect(second.value?.kind).toBe("message");
      await stream.return?.();
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  test("client round-trips against local protocol fixture", async () => {
    const attachmentBytes = Buffer.from("hello sdk", "utf8");
    const tempDir = mkdtempSync(join(tmpdir(), "siriusmsg-sdk-"));
    const attachmentPath = join(tempDir, "attachment.txt");
    writeFileSync(attachmentPath, attachmentBytes);
    const eventResponse = JSON.parse(readFileSync(join(goldenDir, "message-event-response.json"), "utf8")) as SiriusMsgServiceResponse;
    const sockets = new Set<Socket>();

    const response = (name: string, requestID: string): SiriusMsgServiceResponse => {
      const frame = JSON.parse(readFileSync(join(goldenDir, name), "utf8")) as SiriusMsgServiceResponse;
      return { ...frame, requestID };
    };
    const sendResponse = (requestID: string): SiriusMsgServiceResponse => ({
      protocolVersion: 1,
      requestID,
      kind: "sendResult",
      sendResult: {
        accepted: true,
        confirmationState: "confirmed",
        platformMessageID: "fixture-platform-message",
        resolvedContent: { kind: "text", text: "fixture" },
      },
    });
    const attachmentResponse = (requestID: string): SiriusMsgServiceResponse => ({
      protocolVersion: 1,
      requestID,
      kind: "attachmentFile",
      attachmentFile: {
        localFilePath: attachmentPath,
        metadata: {
          id: "m1-a1",
          kind: "document",
          state: "materialized",
          mimeType: "text/plain",
          displayName: "attachment.txt",
          byteCount: attachmentBytes.length,
        },
      },
    });

    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";
      const writeFrame = (frame: SiriusMsgServiceResponse) => socket.write(`${canonicalJSONString(frame)}\n`);
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const request = JSON.parse(line) as SiriusMsgServiceRequest;
          if (request.kind === "authenticate") {
            writeFrame({ protocolVersion: 1, requestID: request.requestID, kind: "authenticated" });
          } else if (request.kind === "health") {
            writeFrame(response("health-response.json", request.requestID));
          } else if (request.kind === "capabilities") {
            writeFrame(response("capabilities-response-local.json", request.requestID));
          } else if (request.kind === "send") {
            writeFrame(sendResponse(request.requestID));
          } else if (request.kind === "fetchAttachment") {
            writeFrame(attachmentResponse(request.requestID));
          } else if (request.kind === "subscribe") {
            writeFrame({ protocolVersion: 1, requestID: request.requestID, kind: "subscribed" });
            writeFrame(eventResponse);
          } else if (request.kind === "ack") {
            writeFrame({ protocolVersion: 1, requestID: request.requestID, kind: "acked" });
          }
        }
      });
    });

    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
      const address = server.address() as AddressInfo;
      const client = SiriusMsgClient.loopback({ port: address.port, authToken: "token" });
      const health = await client.health();
      expect(["healthy", "degraded", "blocked"]).toContain(health.state);
      const capabilities = await client.capabilities();
      expect(capabilities.some((cap) => cap.feature === "sendText")).toBe(true);
      expect((await client.sendText("SMS;-;+15555550100", "hello from typescript")).accepted).toBe(true);
      expect((await client.sendRichLink("SMS;-;+15555550100", { url: "https://example.com/typescript", kind: "plain" })).accepted)
        .toBe(true);

      const stream = client.subscribe({ supportsAttachments: true });
      const next = await withTimeout(stream.next(), "timed out waiting for event");
      expect(next.value?.kind).toBe("message");
      expect(next.value?.message?.text).toBe("hello from golden");
      await client.ack({
        messageID: next.value!.message!.id,
        chatID: next.value!.message!.chatID,
        rowID: next.value!.message!.rowID,
      });
      const attachment = await client.fetchAttachment(next.value!.message!.attachments[0].id);
      expect(attachment.metadata.byteCount).toBe(attachmentBytes.length);
      expect(Buffer.from(await client.fetchAttachmentData(next.value!.message!.attachments[0].id)).toString("utf8")).toBe("hello sdk");
      await stream.return?.();
      await expect(client.sendReaction("SMS;-;+15555550100", "msg-1", "like")).rejects.toBeInstanceOf(UnsupportedContentError);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
