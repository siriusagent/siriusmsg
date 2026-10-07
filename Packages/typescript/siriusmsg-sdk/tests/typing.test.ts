import { expect, test } from "vitest";
import { managedTyping } from "../src/typing.js";

test("renews and stops before returning the reply", async () => {
  const states: string[] = [];
  let renewed!: () => void;
  const ready = new Promise<void>((resolve) => {
    renewed = resolve;
  });
  const value = await managedTyping(
    async (state) => {
      states.push(state);
      if (states.length === 3) renewed();
      return { accepted: true, confirmationState: "unconfirmed" };
    },
    async () => {
      await ready;
      return "reply";
    },
    undefined,
    1,
  );
  expect(value).toBe("reply");
  expect(states).toEqual(["started", "started", "started", "stopped"]);
});

test.each(["error", "abort", "rejected", "unknown", "stopFailed"])(
  "cleanup for %s",
  async (mode) => {
    const states: string[] = [];
    const controller = new AbortController();
    let entered = false;
    const result = managedTyping(
      async (state) => {
        states.push(state);
        if (mode === "unknown" && state === "started")
          throw new Error("lost receipt");
        return {
          accepted: !(
            (mode === "rejected" && state === "started") ||
            (mode === "stopFailed" && state === "stopped")
          ),
          confirmationState: "unconfirmed",
        };
      },
      async () => {
        entered = true;
        if (mode === "error") throw new Error("handler");
        if (mode === "abort") {
          controller.abort();
          await new Promise(() => {});
        }
        return "reply";
      },
      controller.signal,
    );
    if (["rejected", "stopFailed", "unknown"].includes(mode))
      await expect(result).resolves.toBe("reply");
    else await expect(result).rejects.toBeDefined();
    expect(entered).toBe(true);
    expect(states).toEqual(
      mode === "rejected" ? ["started"] : ["started", "stopped"],
    );
  },
);

test("abort waits for an in-flight renewal before stopping", async () => {
  const states: string[] = [];
  const controller = new AbortController();
  let release!: () => void;
  let observed!: () => void;
  const renewing = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = managedTyping(
    async (state) => {
      states.push(state);
      if (states.length === 2) {
        observed();
        await blocked;
      }
      return { accepted: true, confirmationState: "unconfirmed" };
    },
    async () => new Promise<void>(() => {}),
    controller.signal,
    1,
  );
  const rejection = expect(result).rejects.toBeDefined();
  await renewing;
  controller.abort();
  expect(states).toEqual(["started", "started"]);
  release();
  await rejection;
  expect(states).toEqual(["started", "started", "stopped"]);
});

test("capability revoked before dispatch still prepares normally", async () => {
  const { UnsupportedContentError } = await import("../src/errors.js");
  const states: string[] = [];
  const result = await managedTyping(
    async (state) => {
      states.push(state);
      throw new UnsupportedContentError("sendTypingIndicator", "disabled");
    },
    async () => "reply",
  );
  expect(result).toBe("reply");
  expect(states).toEqual(["started"]);
});
