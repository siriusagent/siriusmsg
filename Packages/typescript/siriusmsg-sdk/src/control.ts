import { createConnection } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SiriusMsgAgentControlRequest,
  SiriusMsgAgentControlResponse,
  SiriusMsgConnectionProfile,
  SiriusMsgLocalConfigurationSnapshot,
  SiriusMsgRichMessagingConfiguration,
  SiriusMsgPythonAdapterConfiguration,
  SiriusMsgChatListQuery,
  SiriusMsgChatListPage,
} from "./_models.js";
import { defaultRuntimeDir, canonicalJSONString } from "./transport.js";
import { validateDefinition } from "./validate.js";
import {
  SiriusMsgMalformedFrameError,
  SiriusMsgTransportError,
} from "./errors.js";

export class SiriusMsgAgentControlError extends Error {}
export class SiriusMsgControlOutcomeUnknownError extends SiriusMsgTransportError {
  constructor(readonly command: SiriusMsgAgentControlRequest["command"]) {
    super(
      `control outcome unknown for ${command}; inspect state before retrying`,
    );
  }
}

/** Local-owner Unix administration, separate from a scoped agent connection. */
export class SiriusMsgAgentControlClient {
  readonly socketPath: string;
  readonly timeoutMs: number;
  constructor(
    options: {
      runtimeDirectory?: string;
      socketPath?: string;
      timeoutMs?: number;
    } = {},
  ) {
    this.socketPath =
      options.socketPath ??
      join(
        options.runtimeDirectory ?? defaultRuntimeDir,
        "siriusmsg-control.sock",
      );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 600_000
    ) {
      throw new RangeError(
        "control timeout must be finite and between 0 and 600000 milliseconds",
      );
    }
  }

  /** One overall deadline; no automatic retries. Abort closes the owned socket. */
  async send(
    request: SiriusMsgAgentControlRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<SiriusMsgAgentControlResponse> {
    validateDefinition("SiriusMsgAgentControlRequest", request);
    const frame = Buffer.from(canonicalJSONString(request) + "\n");
    if (frame.length > 1_048_576)
      throw new RangeError("control request exceeds the frame limit");
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (
        error?: unknown,
        response?: SiriusMsgAgentControlResponse,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      const abort = () =>
        finish(options.signal?.reason ?? new Error("control request aborted"));
      const timer = setTimeout(
        () => finish(new SiriusMsgControlOutcomeUnknownError(request.command)),
        this.timeoutMs,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => socket.write(frame));
      socket.on("error", () =>
        finish(new SiriusMsgControlOutcomeUnknownError(request.command)),
      );
      socket.once("close", () =>
        finish(new SiriusMsgControlOutcomeUnknownError(request.command)),
      );
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if ((newline < 0 ? buffer.length : newline + 1) > 1_048_576) {
          finish(
            new SiriusMsgMalformedFrameError(
              "control response exceeds the frame limit",
            ),
          );
          return;
        }
        if (newline < 0) return;
        try {
          const response: unknown = JSON.parse(
            buffer.subarray(0, newline).toString("utf8"),
          );
          validateDefinition("SiriusMsgAgentControlResponse", response);
          finish(undefined, response as SiriusMsgAgentControlResponse);
        } catch {
          finish(
            new SiriusMsgMalformedFrameError(
              "invalid control response payload",
            ),
          );
        }
      });
    });
  }

  private async accepted(
    request: SiriusMsgAgentControlRequest,
  ): Promise<SiriusMsgAgentControlResponse> {
    const response = await this.send(request);
    if (!response.accepted)
      throw new SiriusMsgAgentControlError(
        response.error ?? "The command was rejected.",
      );
    return response;
  }
  async readActivity(): Promise<SiriusMsgAgentControlResponse> {
    return this.accepted({ command: "readActivity" });
  }
  async readConfiguration(): Promise<SiriusMsgLocalConfigurationSnapshot> {
    const response = await this.accepted({ command: "readConfiguration" });
    if (!response.configuration)
      throw new SiriusMsgMalformedFrameError("configuration is missing");
    return response.configuration;
  }
  async createConnection(
    displayName: string,
    chatIDs: string[],
    options: {
      repliesAllowed?: boolean;
      enabled?: boolean;
      incomingAllowed?: boolean;
    } = {},
  ): Promise<SiriusMsgConnectionProfile> {
    const profile: SiriusMsgConnectionProfile = {
      id: randomUUID(),
      displayName,
      createdAt: Date.now() / 1000 - 978307200,
      enabled: options.enabled ?? true,
      incomingAllowed: options.incomingAllowed ?? true,
      repliesAllowed: options.repliesAllowed ?? true,
      includedChatIDs: chatIDs,
      excludedChatIDs: [],
    };
    const response = await this.accepted({
      command: "createConnection",
      connectionProfile: profile,
    });
    if (!response.connectionProfile)
      throw new SiriusMsgMalformedFrameError("connection profile is missing");
    return response.connectionProfile;
  }
  async updateConnection(profile: SiriusMsgConnectionProfile): Promise<void> {
    await this.accepted({
      command: "updateConnection",
      connectionProfile: profile,
    });
  }
  async removeConnection(connectionID: string): Promise<void> {
    await this.accepted({ command: "removeConnection", connectionID });
  }
  async setRichMessagingConfiguration(
    configuration: SiriusMsgRichMessagingConfiguration,
  ): Promise<void> {
    if (configuration.provider === "nativeAccessibility") {
      configuration = {
        ...configuration,
        nativeEnabled: configuration.nativeEnabled ?? configuration.enabled,
        enabled: false,
      };
    }
    await this.accepted({
      command: "setRichMessagingConfiguration",
      richMessagingConfiguration: configuration,
    });
  }
  async savePythonAdapterConfiguration(
    configuration: SiriusMsgPythonAdapterConfiguration,
  ): Promise<SiriusMsgAgentControlResponse> {
    return this.accepted({
      command: "savePythonAdapterConfiguration",
      pythonAdapterConfiguration: configuration,
    });
  }
  async listChats(
    query: SiriusMsgChatListQuery,
  ): Promise<SiriusMsgChatListPage> {
    const response = await this.accepted({
      command: "listChats",
      chatListQuery: query,
    });
    if (!response.chatListPage)
      throw new SiriusMsgMalformedFrameError("chat page is missing");
    return response.chatListPage;
  }
  async setVMAccessEnabled(
    enabled: boolean,
  ): Promise<SiriusMsgAgentControlResponse> {
    return this.accepted({
      command: "setVMAccessEnabled",
      vmAccessEnabled: enabled,
    });
  }
  async setActivityRetention(
    days: 0 | 7 | 30 | 90,
  ): Promise<SiriusMsgAgentControlResponse> {
    return this.accepted({
      command: "setActivityRetention",
      activityRetentionDays: days,
    });
  }
  async clearAdapterReview(
    adapterID: string,
  ): Promise<SiriusMsgAgentControlResponse> {
    return this.accepted({ command: "clearAdapterReview", adapterID });
  }
}
