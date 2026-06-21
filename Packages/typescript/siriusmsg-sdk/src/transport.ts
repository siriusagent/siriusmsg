import { createConnection, Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SiriusMsgServiceRequest, SiriusMsgServiceResponse } from "./_models.js";
import { SiriusMsgMalformedFrameError, SiriusMsgTransportError, serviceError } from "./errors.js";
import { validateRequest, validateResponse } from "./validate.js";

export const protocolVersion = 1;
export const defaultRuntimeDir = join(homedir(), "Library", "Application Support", "SiriusMsg");
export const defaultSocketPath = join(defaultRuntimeDir, "siriusmsg.sock");
export const defaultTokenPath = join(defaultRuntimeDir, "service-token.json");

export type Endpoint = { socketPath: string } | { port: number };

export function requestID(prefix = "sdk"): string {
  return `${prefix}-${randomUUID()}`;
}

export function canonicalJSONString(value: unknown): string {
  return JSON.stringify(sortAndDropNullish(value));
}

export function sortAndDropNullish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortAndDropNullish);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined && child !== null)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortAndDropNullish(child)]),
    );
  }
  return value;
}

export async function loadAuthToken(tokenPath = defaultTokenPath): Promise<string> {
  const parsed = JSON.parse(await readFile(tokenPath, "utf8")) as { token?: unknown };
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new SiriusMsgTransportError(`auth token unavailable at ${tokenPath}`);
  }
  return parsed.token;
}

export class NDJSONConnection {
  private socket?: Socket;
  private buffer = "";
  private responses: SiriusMsgServiceResponse[] = [];
  private readers: Array<(value: SiriusMsgServiceResponse) => void> = [];
  private failures: Array<(error: Error) => void> = [];
  private failure?: Error;

  constructor(private readonly endpoint: Endpoint) {}

  async open(): Promise<void> {
    this.socket = "socketPath" in this.endpoint
      ? createConnection(this.endpoint.socketPath)
      : createConnection({ host: "127.0.0.1", port: this.endpoint.port });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.receive(String(chunk)));
    this.socket.on("error", (error) => this.reject(error));
    this.socket.on("close", () => this.reject(new SiriusMsgTransportError("connection closed")));
    await new Promise<void>((resolve, reject) => {
      this.socket?.once("connect", resolve);
      this.socket?.once("error", reject);
    });
  }

  async authenticate(authToken: string): Promise<void> {
    await this.write({
      protocolVersion,
      requestID: requestID("auth"),
      kind: "authenticate",
      authToken,
    });
    const response = await this.readResponse();
    if (response.kind === "authenticated") {
      return;
    }
    if (response.kind === "error" && response.error) {
      throw serviceError(response.error.code, response.error.message, response.error.diagnosticCode);
    }
    throw new SiriusMsgTransportError("authentication failed");
  }

  async write(frame: SiriusMsgServiceRequest): Promise<void> {
    if (!this.socket) {
      throw new SiriusMsgTransportError("connection is not open");
    }
    validateRequest(frame);
    this.socket.write(`${canonicalJSONString(frame)}\n`);
  }

  readResponse(): Promise<SiriusMsgServiceResponse> {
    const response = this.responses.shift();
    if (response) {
      return Promise.resolve(response);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.readers.push(resolve);
      this.failures.push(reject);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      try {
        const decoded = JSON.parse(line);
        validateResponse(decoded);
        const reader = this.readers.shift();
        this.failures.shift();
        if (reader) {
          reader(decoded);
        } else {
          this.responses.push(decoded);
        }
      } catch (error) {
        this.reject(error instanceof Error ? error : new SiriusMsgMalformedFrameError(String(error)));
      }
    }
  }

  private reject(error: Error): void {
    this.failure = this.failure ?? error;
    const failures = this.failures.splice(0);
    this.readers.splice(0);
    for (const reject of failures) {
      reject(error);
    }
  }
}
