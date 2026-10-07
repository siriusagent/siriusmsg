import { expect, test, vi } from "vitest";
import { run, ReplyNeedsReview } from "../examples/adapter.js";
import type { SiriusMsgClient, SiriusMsgMessageEvent } from "../src/index.js";

test.each(["caption", ""])(
  "reference mode retains metadata without fetching: %s",
  async (text) => {
    const f = fixture(text);
    f.message.attachments.push({
      id: "unavailable",
      mimeType: "audio/mp4",
      state: "unreadable",
    } as (typeof f.message.attachments)[number]);
    f.client.fetchAttachmentData.mockRejectedValue(new Error("must not fetch"));
    await run(
      f.client as unknown as SiriusMsgClient,
      f.handler,
      "connection",
      "references",
    );
    expect(f.handler.prepare.mock.calls[0][1]).toBe(f.message);
    expect(f.handler.prepare.mock.calls[0][2]).toEqual(
      f.message.attachments.map((metadata) => ({ metadata, data: null })),
    );
    expect(f.client.fetchAttachmentData).not.toHaveBeenCalled();
    expect(f.order).toEqual(["complete", "ack"]);
    expect(f.client.withTypingIndicator).not.toHaveBeenCalled();
  },
);

test("reference handler failure leaves delivery unacknowledged", async () => {
  const f = fixture();
  f.handler.prepare.mockRejectedValue(
    new Error("reference not durably handled"),
  );
  await expect(
    run(
      f.client as unknown as SiriusMsgClient,
      f.handler,
      "connection",
      "references",
    ),
  ).rejects.toThrow("not durably handled");
  expect(f.order).toEqual([]);
  expect(f.client.sendContent).not.toHaveBeenCalled();
});

test("invalid attachment mode fails before subscription", async () => {
  const f = fixture();
  await expect(
    run(
      f.client as unknown as SiriusMsgClient,
      f.handler,
      "connection",
      "typo" as "bytes",
    ),
  ).rejects.toThrow(TypeError);
  expect(f.handler.prepare).not.toHaveBeenCalled();
});

function fixture(text = "caption", state = "confirmed", complete = false) {
  const message = {
    id: "message",
    chatID: "chat",
    rowID: 1,
    text,
    attachments: [{ id: "file", mimeType: "video/mp4" }],
  } as SiriusMsgMessageEvent;
  const order: string[] = [];
  const client = {
    withTypingIndicator: vi.fn(
      async (_chatID: string, prepare: () => Promise<unknown>) => prepare(),
    ),
    async *subscribe(options: { supportsAttachments: boolean }) {
      expect(options.supportsAttachments).toBe(true);
      yield { message };
    },
    fetchAttachmentData: vi
      .fn()
      .mockResolvedValue(Buffer.from("verified media")),
    sendContent: vi
      .fn()
      .mockResolvedValue({ accepted: true, confirmationState: state }),
    sendFile: vi
      .fn()
      .mockResolvedValue({ accepted: true, confirmationState: state }),
    ack: vi.fn(async () => {
      order.push("ack");
    }),
  };
  const handler = {
    isComplete: vi.fn().mockResolvedValue(complete),
    prepare: vi.fn().mockResolvedValue({
      text: "reply",
      files: [{ path: "/owned/result.mp4", mimeType: "video/mp4" }],
    }),
    complete: vi.fn(async () => {
      order.push("complete");
    }),
  };
  return {
    client,
    handler,
    message,
    order,
    run: () => run(client as unknown as SiriusMsgClient, handler, "connection"),
  };
}

test.each(["caption", ""])(
  "adapter preserves mixed/attachment-only message %s",
  async (text) => {
    const f = fixture(text);
    await f.run();
    expect(f.handler.prepare.mock.calls[0][1]).toBe(f.message);
    expect(f.handler.prepare.mock.calls[0][2]).toEqual([
      {
        metadata: f.message.attachments[0],
        data: Buffer.from("verified media"),
      },
    ]);
    expect(f.order).toEqual(["complete", "ack"]);
  },
);
test.each(["unconfirmed", "notRequested", "dispatched"])(
  "adapter does not ack %s replies",
  async (state) => {
    const f = fixture("caption", state);
    await expect(f.run()).rejects.toBeInstanceOf(ReplyNeedsReview);
    expect(f.order).toEqual([]);
    expect(f.client.sendFile).not.toHaveBeenCalled();
  },
);
test("missing media prevents handler execution and ACK", async () => {
  const f = fixture();
  f.client.fetchAttachmentData.mockRejectedValue(
    new Error("attachmentUnavailable"),
  );
  await expect(f.run()).rejects.toThrow("attachmentUnavailable");
  expect(f.handler.prepare).not.toHaveBeenCalled();
  expect(f.order).toEqual([]);
});
test("completed replay only ACKs", async () => {
  const f = fixture("caption", "confirmed", true);
  await f.run();
  expect(f.order).toEqual(["ack"]);
  expect(f.handler.prepare).not.toHaveBeenCalled();
  expect(f.client.fetchAttachmentData).not.toHaveBeenCalled();
  expect(f.client.sendContent).not.toHaveBeenCalled();
});
test("partial replies reuse stable IDs", async () => {
  const f = fixture();
  f.client.sendFile.mockResolvedValueOnce({
    accepted: false,
    confirmationState: "notRequested",
  });
  await expect(f.run()).rejects.toBeInstanceOf(ReplyNeedsReview);
  expect(f.order).toEqual([]);
  await f.run();
  expect(f.order).toEqual(["complete", "ack"]);
  expect(f.client.sendContent.mock.calls[0][3]).toBe(
    f.client.sendContent.mock.calls[1][3],
  );
  expect(f.client.sendFile.mock.calls[0][3].operationID).toBe(
    f.client.sendFile.mock.calls[1][3].operationID,
  );
  expect(f.client.sendContent.mock.calls[0][3]).not.toBe(
    f.client.sendFile.mock.calls[0][3].operationID,
  );
});

test.each([undefined, "Here are the files"])(
  "outbound mixed media with caption %s",
  async (text) => {
    const f = fixture();
    const files = [
      { path: "/owned/image.png", mimeType: "image/png" },
      { path: "/owned/audio.m4a", mimeType: "audio/mp4" },
      { path: "/owned/video.mp4", mimeType: "video/mp4" },
      { path: "/owned/report.pdf", mimeType: "application/pdf" },
    ];
    f.handler.prepare.mockResolvedValue({ text, files });
    await f.run();
    expect(f.client.sendContent).toHaveBeenCalledTimes(text ? 1 : 0);
    expect(f.client.sendFile.mock.calls.map((c) => [c[1], c[2]])).toEqual(
      files.map((f) => [f.path, f.mimeType]),
    );
    expect(
      new Set(f.client.sendFile.mock.calls.map((c) => c[3].operationID)).size,
    ).toBe(4);
    expect(f.order).toEqual(["complete", "ack"]);
  },
);

test("partial file transport loss stops later files and ACK", async () => {
  const f = fixture();
  f.handler.prepare.mockResolvedValue({
    files: [0, 1, 2].map((i) => ({
      path: `/owned/${i}.png`,
      mimeType: "image/png",
    })),
  });
  f.client.sendFile
    .mockResolvedValueOnce({ accepted: true, confirmationState: "confirmed" })
    .mockRejectedValueOnce(new Error("response lost"));
  await expect(f.run()).rejects.toThrow("response lost");
  expect(f.client.sendFile).toHaveBeenCalledTimes(2);
  expect(f.order).toEqual([]);
  expect(f.handler.complete).not.toHaveBeenCalled();
});
