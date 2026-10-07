import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  SiriusMsgAgentControlClient,
  SiriusMsgControlOutcomeUnknownError,
  SiriusMsgMalformedFrameError,
  validateDefinition,
} from "../src/index.js";

for (const mode of ["silent", "trickle", "cancel", "oversize", "malformed"]) {
  test(`control ${mode} closes and never retries`, async () => {
    const root = await mkdtemp("/tmp/sm-control-");
    const path = join(root, "control.sock");
    let requests = 0;
    const peers = new Set<import("node:net").Socket>();
    const timers = new Set<ReturnType<typeof setInterval>>();
    const server = createServer((socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => peers.delete(socket));
      socket.once("data", () => {
        requests++;
        if (mode === "oversize") socket.write("x".repeat(1_048_577) + "\n");
        if (mode === "malformed") socket.write('{"accepted":"invalid"}\n');
        if (mode === "trickle") {
          const timer = setInterval(() => socket.write(" "), 20);
          timers.add(timer);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      const client = new SiriusMsgAgentControlClient({
        socketPath: path,
        timeoutMs: 80,
      });
      const abort = new AbortController();
      const operation = client.send(
        { command: "probeAutomation" },
        { signal: abort.signal },
      );
      if (mode === "cancel") {
        const assertion = expect(operation).rejects.toThrow("cancelled");
        while (!requests)
          await new Promise((resolve) => setTimeout(resolve, 5));
        abort.abort(new Error("cancelled"));
        await assertion;
      } else {
        await expect(operation).rejects.toBeInstanceOf(
          ["oversize", "malformed"].includes(mode)
            ? SiriusMsgMalformedFrameError
            : SiriusMsgControlOutcomeUnknownError,
        );
      }
      expect(requests).toBe(1);
    } finally {
      for (const timer of timers) clearInterval(timer);
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true });
    }
  });
}

test("control rejects invalid deadlines before opening a connection", () => {
  for (const timeoutMs of [NaN, Infinity, 0, -1, 600001]) {
    expect(() => new SiriusMsgAgentControlClient({ timeoutMs })).toThrow(
      RangeError,
    );
  }
});

test("owner chat pagination rejects row IDs JavaScript cannot represent", () => {
  expect(() =>
    validateDefinition("SiriusMsgAgentControlResponse", {
      accepted: true,
      allowlistCandidates: [],
      chatListPage: {
        chats: [],
        nextCursor: { sortValue: "1", chatRowID: Number.MAX_SAFE_INTEGER + 1 },
      },
    }),
  ).toThrow(SiriusMsgMalformedFrameError);
});
