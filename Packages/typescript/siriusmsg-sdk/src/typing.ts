import type { SiriusMsgSendResult, SiriusMsgTypingState } from "./_models.js";
import { UnsupportedContentError } from "./errors.js";

export async function managedTyping<T>(
  send: (state: SiriusMsgTypingState) => Promise<SiriusMsgSendResult>,
  prepare: () => Promise<T>,
  signal?: AbortSignal,
  interval = 2000,
): Promise<T> {
  signal?.throwIfAborted();
  let started: boolean;
  try {
    started = (await send("started")).accepted;
  } catch (error) {
    if (error instanceof UnsupportedContentError) {
      signal?.throwIfAborted();
      return prepare();
    }
    await send("stopped").catch(() => undefined);
    signal?.throwIfAborted();
    return prepare();
  }
  if (!started) {
    signal?.throwIfAborted();
    return prepare();
  }
  let done = false;
  let wake: (() => void) | undefined;
  const heartbeat = (async () => {
    try {
      while (!done) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (done) break;
        if (!(await send("started")).accepted) break;
      }
    } catch {
      /* Cleanup follows every renewal failure. */
    }
  })();
  let onAbort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason ?? new Error("Aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const value = await Promise.race([prepare(), aborted]);
    signal?.throwIfAborted();
    return value;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    done = true;
    wake?.();
    await heartbeat;
    try {
      await send("stopped");
    } catch {
      /* Typing is advisory; delivery owns its safety and receipt checks. */
    }
  }
}
