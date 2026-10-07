import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  AttachmentHashMismatchError,
  AttachmentSizeMismatchError,
  SiriusMsgClient,
  SiriusMsgAgentControlClient,
  SiriusMsgAgentControlError,
  SiriusMsgSendOutcomeUnknownError,
  SiriusMsgServiceErrorResponse,
  UnsupportedContentError,
  NDJSONConnection,
  SiriusMsgMalformedFrameError,
  assertSafeRowIDs,
  canonicalJSONString,
  validateDefinition,
  validateRequest,
  validateResponse,
  type SiriusMsgMessageEvent,
  type SiriusMsgServiceRequest,
  type SiriusMsgServiceResponse,
} from "../src/index.js";

test("generated send operation ID is recoverable after transport failure", async () => {
  const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
  try {
    await client.send({ chatID: "allowed", text: "hello" });
    throw new Error("expected send to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SiriusMsgSendOutcomeUnknownError);
    expect((error as SiriusMsgSendOutcomeUnknownError).operationID).not.toBe(
      "",
    );
  }
});

test("history search rejects an oversized chat scope before transport", async () => {
  const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
  await expect(
    client.searchHistory("query", {
      chatIDs: Array.from({ length: 21 }, (_, index) => `chat-${index}`),
    }),
  ).rejects.toThrow("chatIDs must contain at most 20 entries");
});

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../../../..");
const goldenDir = join(repoRoot, "Schema", "golden");

interface SDKHarnessInfo {
  socketPath: string;
  tokenPath: string;
  authToken: string;
  workingDirectory: string;
  chatID: string;
  messageID: string;
  rowID: number;
  attachmentID: string;
}

interface RunningSDKHarness {
  child: ChildProcessWithoutNullStreams;
  info: SDKHarnessInfo;
  stderr: string[];
}

function canonical(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJSONString(value)));
}

function validateFrame(
  frame: Record<string, unknown>,
): SiriusMsgServiceRequest | SiriusMsgServiceResponse {
  if ("command" in frame) {
    validateDefinition("SiriusMsgAgentControlRequest", frame);
    return frame as unknown as SiriusMsgServiceRequest;
  }
  if ("accepted" in frame && !("kind" in frame)) {
    validateDefinition("SiriusMsgAgentControlResponse", frame);
    return frame as unknown as SiriusMsgServiceResponse;
  }
  const responsePayloads = new Set([
    "health",
    "capabilities",
    "sendResult",
    "allowedChats",
    "historyPage",
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
    "allowedChats",
    "historyPage",
    "allowlistUpdated",
    "attachmentFile",
    "event",
    "error",
  ]);
  if (
    responseKinds.has(String(frame.kind)) ||
    Object.keys(frame).some((key) => responsePayloads.has(key))
  ) {
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

async function readHarnessInfo(
  child: ChildProcessWithoutNullStreams,
  stderr: string[],
): Promise<SDKHarnessInfo> {
  return await new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const diagnostic = stderr.join("").trim();
      reject(
        new Error(
          diagnostic ? `${error.message}\n${diagnostic}` : error.message,
        ),
      );
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const index = buffer.indexOf("\n");
      if (index < 0 || settled) {
        return;
      }
      try {
        const decoded: unknown = JSON.parse(buffer.slice(0, index));
        const info = validateHarnessInfo(decoded);
        settled = true;
        cleanup();
        resolvePromise(info);
      } catch (error) {
        fail(
          error instanceof Error
            ? new Error(`invalid harness startup info: ${error.message}`)
            : new Error("invalid harness startup info"),
        );
      }
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `harness exited before startup (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    };
    const timer = setTimeout(
      () => fail(new Error("timed out waiting for harness startup")),
      20_000,
    );
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function validateHarnessInfo(value: unknown): SDKHarnessInfo {
  if (!value || typeof value !== "object") {
    throw new Error("expected an object");
  }
  const candidate = value as Record<string, unknown>;
  const stringKeys = [
    "socketPath",
    "tokenPath",
    "authToken",
    "workingDirectory",
    "chatID",
    "messageID",
    "attachmentID",
  ] as const;
  for (const key of stringKeys) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
      throw new Error(`expected non-empty string ${key}`);
    }
  }
  if (!Number.isSafeInteger(candidate.rowID)) {
    throw new Error("expected safe integer rowID");
  }
  return candidate as unknown as SDKHarnessInfo;
}

function harnessDirectory(info: SDKHarnessInfo): string {
  const directory = resolve(info.workingDirectory);
  const parent = dirname(directory);
  const allowedParents = new Set([resolve("/tmp"), resolve("/private/tmp")]);
  if (
    !basename(directory).startsWith("siriusmsg-sdk-harness-") ||
    !allowedParents.has(parent)
  ) {
    throw new Error(
      `refusing to clean unexpected harness directory: ${directory}`,
    );
  }
  return directory;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function terminateHarness(
  child: ChildProcessWithoutNullStreams,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
      forced: false,
    };
  }
  child.kill("SIGTERM");
  try {
    return {
      ...(await withTimeout(
        waitForExit(child),
        "Swift SDK harness ignored SIGTERM",
        5_000,
      )),
      forced: false,
    };
  } catch {
    child.kill("SIGKILL");
    return { ...(await waitForExit(child)), forced: true };
  }
}

async function startSDKHarness(): Promise<RunningSDKHarness> {
  const child = spawn("swift", ["run", "--quiet", "SiriusMsgSDKHarness"], {
    cwd: repoRoot,
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    const info = await readHarnessInfo(child, stderr);
    harnessDirectory(info);
    return { child, info, stderr };
  } catch (error) {
    await terminateHarness(child);
    throw error;
  }
}

async function stopSDKHarness(harness: RunningSDKHarness): Promise<void> {
  const result = await terminateHarness(harness.child);
  const directory = harnessDirectory(harness.info);
  const leakedDirectory = await pathExists(directory);
  if (leakedDirectory) {
    await rm(directory, { recursive: true, force: true });
  }
  const diagnostic = harness.stderr.join("").trim();
  if (result.forced) {
    throw new Error(
      `Swift SDK harness required SIGKILL${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `Swift SDK harness exited with code ${String(result.code)} and signal ${String(result.signal)}${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
  if (leakedDirectory) {
    throw new Error(
      `Swift SDK harness leaked its working directory: ${directory}`,
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  ms = 2_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

describe("@siriusmsg/sdk", () => {
  test("golden frames validate and re-encode canonically", async () => {
    for (const name of await readdir(goldenDir)) {
      const lines = readFileSync(join(goldenDir, name), "utf8")
        .trim()
        .split("\n");
      for (const line of lines) {
        const frame = JSON.parse(line);
        const validated = validateFrame(frame);
        expect(canonical(validated), name).toEqual(canonical(frame));
      }
    }
  });

  test("rowID precision guard rejects unsafe integers", () => {
    expect(() =>
      assertSafeRowIDs({ rowID: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(/rowID exceeds/);
    expect(() =>
      assertSafeRowIDs({ rowID: Number.MAX_SAFE_INTEGER }),
    ).not.toThrow();
  });

  test("unknown enum values fail validation cleanly", () => {
    expect(() =>
      validateRequest({
        protocolVersion: 1,
        requestID: "future-kind",
        kind: "futureKind",
      }),
    ).toThrow(SiriusMsgMalformedFrameError);
  });

  test("capability gating rejects unsupported content before send", async () => {
    const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
    const caps = (
      validateFrame(
        JSON.parse(
          readFileSync(
            join(goldenDir, "capabilities-response-local.json"),
            "utf8",
          ),
        ),
      ) as SiriusMsgServiceResponse
    ).capabilities;
    (client as unknown as { capabilities: () => unknown }).capabilities =
      async () => caps;
    (client as unknown as { send: () => unknown }).send = async () => {
      throw new Error("send must not be called");
    };
    const unsupportedCalls = [
      () => client.sendReaction("SMS;-;+15555550100", "target", "like"),
      () =>
        client.sendThreadedReply(
          "SMS;-;+15555550100",
          "target",
          "threaded reply",
        ),
      () => client.sendEdit("SMS;-;+15555550100", "target", "replacement"),
      () => client.sendUnsend("SMS;-;+15555550100", "target"),
      () => client.sendTyping("SMS;-;+15555550100", "started"),
      () => client.sendMessageEffect("SMS;-;+15555550100", "boom", "slam"),
    ];
    for (const unsupportedCall of unsupportedCalls) {
      await expect(unsupportedCall()).rejects.toBeInstanceOf(
        UnsupportedContentError,
      );
    }
  });

  test("subscription ack tolerates interleaved event frames", async () => {
    const eventResponse = JSON.parse(
      readFileSync(join(goldenDir, "message-event-response.json"), "utf8"),
    ) as SiriusMsgServiceResponse;
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
            writeFrame({
              protocolVersion: 1,
              requestID: request.requestID,
              kind: "authenticated",
            });
          } else if (request.kind === "subscribe") {
            writeFrame({
              protocolVersion: 1,
              requestID: request.requestID,
              kind: "subscribed",
            });
            writeFrame(eventResponse);
          } else if (request.kind === "ack") {
            writeFrame(eventResponse);
            writeFrame({
              protocolVersion: 1,
              requestID: request.requestID,
              kind: "acked",
            });
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
      const client = SiriusMsgClient.loopback({
        port: address.port,
        authToken: "token",
      });
      const stream = client.subscribe({ supportsAttachments: true });
      const first = await withTimeout(
        stream.next(),
        "timed out waiting for first event",
      );
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
      const second = await withTimeout(
        stream.next(),
        "timed out waiting for interleaved event",
      );
      expect(second.value?.kind).toBe("message");
      await stream.return?.();
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });

  test.each([
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "video/mp4",
    "video/quicktime",
  ])(
    "fetchAttachmentData preserves binary media bytes for %s",
    async (mimeType) => {
      const bytes = Buffer.from([0, 255, 1, 128, 10, 13, 0]);
      const directory = await mkdtemp(join(tmpdir(), "siriusmsg-media-sdk-"));
      const path = join(directory, "media.bin");
      const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
      client.fetchAttachment = async () => ({
        localFilePath: path,
        metadata: {
          byteCount: bytes.length,
          id: "synthetic-media",
          kind: "document",
          mimeType,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          state: "materialized",
        },
      });
      try {
        await writeFile(path, bytes);
        expect(
          Buffer.from(await client.fetchAttachmentData("synthetic-media")),
        ).toEqual(bytes);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("fetchAttachmentData rejects size and hash corruption with typed errors", async () => {
    const attachmentID = "m42-a7";
    const expected = Buffer.from("trusted attachment");
    const expectedSHA256 = createHash("sha256").update(expected).digest("hex");
    const directory = await mkdtemp(join(tmpdir(), "siriusmsg-sdk-"));
    const path = join(directory, "attachment.bin");
    const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
    client.fetchAttachment = async () => ({
      localFilePath: path,
      metadata: {
        byteCount: expected.length,
        id: attachmentID,
        kind: "document",
        mimeType: "application/octet-stream",
        sha256: expectedSHA256,
        state: "materialized",
      },
    });

    try {
      await writeFile(path, "short");
      const sizeError = await client.fetchAttachmentData(attachmentID).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(sizeError).toBeInstanceOf(AttachmentSizeMismatchError);
      expect(sizeError).toMatchObject({
        attachmentID,
        expectedByteCount: expected.length,
        actualByteCount: Buffer.byteLength("short"),
      });

      const corrupt = Buffer.alloc(expected.length, "x");
      await writeFile(path, corrupt);
      const hashError = await client.fetchAttachmentData(attachmentID).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(hashError).toBeInstanceOf(AttachmentHashMismatchError);
      expect(hashError).toMatchObject({
        attachmentID,
        expectedSHA256,
        actualSHA256: createHash("sha256").update(corrupt).digest("hex"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("subscription reconnects after a transport closure", async () => {
    const eventResponse = JSON.parse(
      readFileSync(join(goldenDir, "message-event-response.json"), "utf8"),
    ) as SiriusMsgServiceResponse;
    const sockets = new Set<Socket>();
    let subscriptions = 0;
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
            writeFrame({
              protocolVersion: 1,
              requestID: request.requestID,
              kind: "authenticated",
            });
          } else if (request.kind === "subscribe") {
            subscriptions += 1;
            writeFrame({
              protocolVersion: 1,
              requestID: request.requestID,
              kind: "subscribed",
            });
            if (subscriptions === 1) {
              socket.end();
            } else {
              writeFrame(eventResponse);
            }
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
      const client = SiriusMsgClient.loopback({
        port: address.port,
        authToken: "token",
      });
      const stream = client.subscribe({ reconnect: true });
      const event = await withTimeout(
        stream.next(),
        "timed out waiting for reconnected event",
      );

      expect(event.value?.kind).toBe("message");
      expect(subscriptions).toBe(2);
      await stream.return?.();
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });

  test("subscription reconnect fails fast on authentication errors", async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";

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
            socket.write(
              `${canonicalJSONString({
                protocolVersion: 1,
                requestID: request.requestID,
                kind: "error",
                error: {
                  code: "authFailed",
                  message: "Authentication failed.",
                },
              })}\n`,
            );
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
      const client = SiriusMsgClient.loopback({
        port: address.port,
        authToken: "wrong-token",
      });
      const stream = client.subscribe({ reconnect: true });

      try {
        await withTimeout(
          stream.next(),
          "subscription retried an authentication error",
          500,
        );
        throw new Error(
          "subscription unexpectedly survived authentication failure",
        );
      } catch (error) {
        expect(error).toBeInstanceOf(SiriusMsgServiceErrorResponse);
        expect((error as SiriusMsgServiceErrorResponse).code).toBe(
          "authFailed",
        );
      }
      expect(connections).toBe(1);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });

  describe("live Swift service harness", () => {
    let harness: RunningSDKHarness | undefined;

    beforeAll(async () => {
      harness = await startSDKHarness();
    }, 30_000);

    afterAll(async () => {
      if (harness) {
        await stopSDKHarness(harness);
      }
    }, 10_000);

    function runningHarness(): RunningSDKHarness {
      if (!harness) {
        throw new Error("Swift SDK harness did not start");
      }
      return harness;
    }

    async function clientForHarness(): Promise<SiriusMsgClient> {
      const info = runningHarness().info;
      return await SiriusMsgClient.connect({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath,
      });
    }

    test("owner setup and registered consumer permissions use the Swift service", async () => {
      const { info } = runningHarness();
      const owner = new SiriusMsgAgentControlClient({
        runtimeDirectory: info.workingDirectory,
        timeoutMs: 2000,
      });
      const activity = await owner.readActivity();
      expect(activity.activityRecords).toBeDefined();
      expect(activity.adapterStatuses).toBeDefined();
      const initial = await owner.readConfiguration();
      expect(initial.allowlist.chatIDs.length).toBeGreaterThan(0);
      const profile = await owner.createConnection(
        "TypeScript SDK consumer",
        [info.chatID],
        { repliesAllowed: false },
      );
      const client = await SiriusMsgClient.connect({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath,
        connectionID: profile.id,
      });
      expect((await client.listAllowedChats()).length).toBe(1);
      expect(
        (await client.sendText(info.chatID, "fixture reply")).accepted,
      ).toBe(false);
      await expect(
        owner.createConnection("Unshared", ["unshared"]),
      ).rejects.toBeInstanceOf(SiriusMsgAgentControlError);
      await owner.setRichMessagingConfiguration({
        provider: "nativeAccessibility",
        executablePath: "",
        enabled: true,
        allowedFeatures: ["sendReaction"],
      });
      const snapshot = await owner.readConfiguration();
      expect(snapshot.richMessaging?.nativeEnabled).toBe(true);
      expect(snapshot.richMessaging?.enabled).toBe(false);
      await owner.setActivityRetention(7);
      expect((await owner.readConfiguration()).activityRetentionDays).toBe(7);
      profile.enabled = false;
      await owner.updateConnection(profile);
      await expect(client.health()).rejects.toThrow();
      await owner.removeConnection(profile.id);
      expect(
        (await owner.readConfiguration()).connections.some(
          (p) => p.id === profile.id,
        ),
      ).toBe(false);
    });

    test("another consumer reconnects after token rotation", async () => {
      const rotating = await clientForHarness();
      const other = await clientForHarness();
      await rotating.rotateAuthToken();
      const health = await other.health();
      const token = health.components?.find((c) => c.kind === "authToken");
      expect(token?.state).toBe("healthy");
      expect(token?.detail?.tokenMaintenanceDue).toBe(false);
    });

    test("reads health and exact text capability", async () => {
      const client = await clientForHarness();
      const health = await client.health();
      expect(["healthy", "degraded", "blocked"]).toContain(health.state);

      const capabilities = await client.capabilities();
      expect(capabilities).toContainEqual(
        expect.objectContaining({
          feature: "sendText",
          support: "supported",
          transport: "localMessagesAutomation",
        }),
      );

      const info = runningHarness().info;
      const chats = await client.listAllowedChats("SDK", 5);
      expect(chats.map((chat) => chat.chatID)).toEqual([info.chatID]);
      const history = await client.readHistory(info.chatID, undefined, 5);
      expect(history.messages.map((message) => message.text)).toEqual([
        "hello sdk",
      ]);
      const search = await client.searchHistory("HELLO", {
        chatIDs: [info.chatID],
        limit: 5,
      });
      expect(search.messages.map((message) => message.id)).toEqual([
        info.messageID,
      ]);
    });

    test("file helper uses service staging and a stable operation ID", async () => {
      const directory = await mkdtemp(join(tmpdir(), "sm-sdk-file-"));
      try {
        const path = join(directory, "file # café.txt");
        const bytes = Buffer.from("SDK file fixture");
        await writeFile(path, bytes);
        const client = await clientForHarness();
        const rejected = await client.sendFile(
          runningHarness().info.chatID,
          path,
          "application/x-siriusmsg-test-unsupported",
          { operationID: "typescript-file-rejected" },
        );
        expect(rejected).toMatchObject({
          accepted: false,
          diagnosticCode: "attachmentUnsupportedType",
        });
        const results = [];
        for (let i = 0; i < 2; i++) {
          const result = await client.sendFile(
            runningHarness().info.chatID,
            path,
            "text/plain",
            { operationID: "typescript-file-once" },
          );
          expect(result.accepted).toBe(true);
          if (i === 0) {
            expect(result.resolvedContent?.attachment).toMatchObject({
              byteCount: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }
          results.push(result);
        }
        expect(results[0].platformMessageID).toBe(results[1].platformMessageID);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("sends text and rich links through the Swift service", async () => {
      const info = runningHarness().info;
      const client = await clientForHarness();
      const sent = await client.sendText(info.chatID, "hello from typescript");
      expect(sent).toMatchObject({
        accepted: true,
        confirmationState: "notRequested",
        resolvedContent: { text: "hello from typescript" },
      });
      expect(sent.platformMessageID).toMatch(/^sdk-harness-/);

      const linkSent = await client.sendRichLink(info.chatID, {
        url: "https://example.com/typescript",
        kind: "plain",
      });
      expect(linkSent).toMatchObject({
        accepted: true,
        resolvedContent: {
          richLink: {
            url: "https://example.com/typescript",
            kind: "plain",
          },
        },
      });
    });

    test("subscribes, acknowledges, and verifies attachment bytes", async () => {
      const info = runningHarness().info;
      const client = await clientForHarness();
      const stream = client.subscribe({ supportsAttachments: true });
      let message: SiriusMsgMessageEvent | undefined;
      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const candidate = await withTimeout(
            stream.next(),
            "timed out waiting for message event",
            5_000,
          );
          if (candidate.value?.kind === "message") {
            message = candidate.value.message;
            break;
          }
        }
        expect(message).toMatchObject({
          id: info.messageID,
          text: "hello sdk",
        });
        if (!message) {
          throw new Error("expected a message event");
        }
        expect(message.attachments[0]?.id).toBe(info.attachmentID);
        await client.ack({
          messageID: message.id,
          chatID: message.chatID,
          rowID: message.rowID,
        });
      } finally {
        await stream.return?.();
      }

      if (!message) {
        throw new Error("expected a message event");
      }
      const attachmentID = message.attachments[0]?.id;
      if (!attachmentID) {
        throw new Error("expected an attachment");
      }
      const attachment = await client.fetchAttachment(attachmentID);
      expect(attachment.metadata.byteCount).toBe(
        Buffer.byteLength("hello sdk"),
      );
      expect(
        Buffer.from(await client.fetchAttachmentData(attachmentID)).toString(
          "utf8",
        ),
      ).toBe("hello sdk");
    });

    test("rejects unsupported content before Swift send dispatch", async () => {
      const info = runningHarness().info;
      const client = await clientForHarness();
      const error = await client
        .sendReaction(info.chatID, info.messageID, "like")
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(UnsupportedContentError);
      expect(error).toMatchObject({
        feature: "sendReaction",
        diagnosticCode: "unsupportedByLocalMessagesAutomation",
      });
    });
  });
});

test("rich helpers preserve exact targets, removal and unconfirmed results", async () => {
  const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
  const response = JSON.parse(
    readFileSync(join(goldenDir, "capabilities-response-local.json"), "utf8"),
  ) as SiriusMsgServiceResponse;
  client.capabilities = async () =>
    response.capabilities!.map((cap) => ({ ...cap, support: "supported" }));
  const captured: import("../src/index.js").SiriusMsgSendRequest[] = [];
  client.send = async (request) => {
    captured.push(request);
    return {
      accepted: true,
      confirmationState: "unconfirmed",
      resolvedContent: request.content,
    };
  };
  const calls = [
    () => client.sendReaction("allowed", "exact-target", "like", "account"),
    () =>
      client.sendReaction(
        "allowed",
        "exact-target",
        "like",
        "account",
        "removed",
      ),
    () =>
      client.sendThreadedReply("allowed", "exact-target", "reply", "account"),
    () => client.sendEdit("allowed", "exact-target", "replacement", "account"),
    () => client.sendUnsend("allowed", "exact-target", "account"),
    () => client.sendTyping("allowed", "started", "account"),
    () => client.sendTyping("allowed", "stopped", "account"),
    () => client.sendMessageEffect("allowed", "effect", "slam", "account"),
  ];
  for (const call of calls) {
    expect(await call()).toMatchObject({
      accepted: true,
      confirmationState: "unconfirmed",
    });
  }
  expect(captured.map((r) => r.content!.kind)).toEqual([
    "reaction",
    "reaction",
    "reply",
    "edit",
    "unsend",
    "typing",
    "typing",
    "messageEffect",
  ]);
  expect(
    captured
      .filter((r) => r.content!.kind === "typing")
      .map((r) => r.content!.typing),
  ).toEqual(["started", "stopped"]);
  expect(captured[0].content!.reaction!.action).toBe("added");
  expect(captured[1].content!.reaction!.action).toBe("removed");
  for (const request of captured) {
    expect(request.chatID).toBe("allowed");
    expect(request.accountID).toBe("account");
    const content = request.content!;
    const target =
      content.reaction ?? content.reply ?? content.edit ?? content.unsend;
    if (target) expect(target.targetMessageID).toBe("exact-target");
  }
});

test("registered connection reloads scoped credential after rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sm-scoped-sdk-"));
  const tokenPath = join(directory, "token.json");
  const health = vi
    .spyOn(SiriusMsgClient.prototype, "health")
    .mockResolvedValue({} as never);
  try {
    await writeFile(tokenPath, JSON.stringify({ token: "fixture-primary" }));
    const client = await SiriusMsgClient.connect({
      tokenPath,
      connectionID: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    });
    const credential = client as unknown as {
      currentAuthToken(): Promise<string>;
    };
    expect(await credential.currentAuthToken()).toBe(
      "Jr33zUqEzp27mh4Ws5w8xKSUZenoj1pmNBejxM4Ikzg=",
    );
    await writeFile(tokenPath, JSON.stringify({ token: "fixture-rotated" }));
    expect(await credential.currentAuthToken()).toBe(
      "fA86e3Sjmgiyzy6NouMWsaRvm6bBMVW4NULxToXpIqE=",
    );
    const legacy = await SiriusMsgClient.connect({ tokenPath });
    expect(
      await (
        legacy as unknown as { currentAuthToken(): Promise<string> }
      ).currentAuthToken(),
    ).toBe("fixture-rotated");
    await expect(
      SiriusMsgClient.connect({ tokenPath, connectionID: "not-a-uuid" }),
    ).rejects.toThrow("connectionID must be a UUID");
  } finally {
    health.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  "authFailed",
  "authRequired",
  "invalidRequest",
  "peerCredentialsRejected",
  "protocolVersionUnsupported",
  "internalError",
])("send classifies %s without losing uncertainty", async (code) => {
  const client = SiriusMsgClient.loopback({ port: 1, authToken: "unused" });
  (client as unknown as { perform(): Promise<never> }).perform = async () => {
    throw new SiriusMsgServiceErrorResponse(
      code,
      "Synthetic rejection",
      "fixtureDiagnostic",
    );
  };
  const result = client.send({
    chatID: "allowed",
    text: "hello",
    operationID: "stable-operation",
  });
  if (code === "internalError") {
    await expect(result).rejects.toMatchObject({
      operationID: "stable-operation",
    });
  } else {
    await expect(result).resolves.toEqual({
      accepted: false,
      confirmationState: "notRequested",
      diagnosticCode: "fixtureDiagnostic",
    });
  }
});

describe("NDJSON transport framing", () => {
  test("reads a protocol-sized frame and rejects one above the limit", async () => {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      connections += 1;
      if (connections === 1) {
        socket.write(
          `${JSON.stringify({
            protocolVersion: 1,
            requestID: "large-frame",
            kind: "health",
            health: {
              activeTransport: "localMessagesAutomation",
              capabilities: [],
              components: [],
              reason: "x".repeat(200_000),
              state: "healthy",
            },
          })}\n`,
        );
      }
      if (connections === 2) {
        socket.write("x".repeat(1_048_576 + 4096));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const connection = new NDJSONConnection({ port });
      await connection.open();
      const response = await connection.readResponse();
      expect(response.health?.reason.length).toBe(200_000);

      const oversized = new NDJSONConnection({ port });
      await oversized.open();
      await expect(oversized.readResponse()).rejects.toBeInstanceOf(
        SiriusMsgMalformedFrameError,
      );
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  });
});
