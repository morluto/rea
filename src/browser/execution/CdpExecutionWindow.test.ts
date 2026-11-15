import { expect, it, vi } from "vitest";
import { CdpExecutionWindow } from "./CdpExecutionWindow.js";
import { receiveCdpEvent } from "../CdpConnection.js";
import { CdpTargetDocument } from "../CdpTargetDocument.js";

const selectedSession = (options: { signal?: AbortSignal } = {}) => ({
  target: { frame_id: "selected-main" },
  document: new CdpTargetDocument({
    frameId: "selected-main",
    loaderId: "loader-selected",
    url: "https://example.test/",
  }),
  operation: "observe_web_execution" as const,
  options,
});

/** Deliver one event as the collection does: document owner first, then the window. */
const deliver = (
  session: ReturnType<typeof selectedSession>,
  window: CdpExecutionWindow,
  message: Parameters<typeof receiveCdpEvent>[0],
): void => {
  const event = receiveCdpEvent(message);
  session.document.ingest(event);
  window.ingest(event);
};

it("settles an already lost transport without arming a timer that cannot resolve", async () => {
  const window = new CdpExecutionWindow(selectedSession());
  window.end("target_terminated");
  await expect(window.start(30_000)).resolves.toBe("target_terminated");
  expect(window.active).toBe(false);
  expect(window.armedAt).toBeUndefined();
});

it("ends the actual armed window at its selected duration and disposes its timer", async () => {
  vi.useFakeTimers();
  const window = new CdpExecutionWindow(selectedSession());
  try {
    const result = window.start(10);
    expect(window.active).toBe(true);
    vi.advanceTimersByTime(10);
    await expect(result).resolves.toBe("window_elapsed");
    expect(window.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    window.dispose();
    vi.useRealTimers();
  }
});

it("settles caller cancellation and removes its local timer", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const window = new CdpExecutionWindow(
    selectedSession({ signal: controller.signal }),
  );
  try {
    const reason = new Error("operator stopped the armed window");
    const result = window.start(30_000).catch((error: unknown) => error);
    controller.abort(reason);
    const failure = await result;
    expect(failure).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
    });
    expect(() => window.check()).toThrow(failure as Error);
    const endedAt = window.endedAt;
    window.end("target_terminated");
    expect(window.reason).toBeUndefined();
    expect(window.endedAt).toBe(endedAt);
    await expect(window.start(30_000)).rejects.toBe(failure);
    expect(window.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    window.dispose();
    vi.useRealTimers();
  }
});

it("keeps a root document transition distinct from a child frame event", async () => {
  const rootSession = selectedSession();
  const root = new CdpExecutionWindow(rootSession);
  const rootResult = root.start(30_000);
  deliver(rootSession, root, {
    method: "Page.frameNavigated",
    params: { frame: { id: "new-main", url: "https://example.test/" } },
  });
  await expect(rootResult).resolves.toBe("document_changed");

  const childSession = selectedSession();
  const child = new CdpExecutionWindow(childSession);
  const childResult = child.start(30_000);
  deliver(childSession, child, {
    method: "Page.frameNavigated",
    params: {
      frame: {
        id: "child-frame",
        parentId: "selected-main",
        url: "https://example.test/child",
      },
    },
  });
  expect(child.active).toBe(true);
  child.end("window_elapsed");
  await expect(childResult).resolves.toBe("window_elapsed");
});

// The target session's document owner decides whether a main-frame commit is
// another document; a re-fired commit of the selected one keeps the window.
it.each([
  ["the selected loader again", "loader-selected", "/", "window_elapsed"],
  ["a new loader", "loader-next", "/", "document_changed"],
  ["no loader", undefined, "/", "document_changed"],
] as const)(
  "ends the window on a main-frame commit with %s only when the document may differ",
  async (_label, loaderId, path, expected) => {
    const session = selectedSession();
    const window = new CdpExecutionWindow(session);
    const result = window.start(30_000);
    deliver(session, window, {
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "selected-main",
          ...(loaderId === undefined ? {} : { loaderId }),
          url: "https://example.test" + path,
        },
      },
    });
    if (window.active) window.end("window_elapsed");
    await expect(result).resolves.toBe(expected);
  },
);

// Another root frame proves a change even when its loader is malformed, so
// the window keeps what it collected instead of failing.
it.each([
  ["another root frame", "document_changed", "new-main"],
  ["the selected frame", "protocol_error", "selected-main"],
] as const)(
  "ends on a malformed loader for %s as %s",
  async (_label, expected, frameId) => {
    const session = selectedSession();
    const window = new CdpExecutionWindow(session);
    const result = window.start(30_000).then(
      (reason) => reason,
      (cause: unknown) => (cause as { reason?: string }).reason,
    );
    deliver(session, window, {
      method: "Page.frameNavigated",
      params: {
        frame: { id: frameId, loaderId: 7, url: "https://example.test/" },
      },
    });
    await expect(result).resolves.toBe(expected);
  },
);

it("surfaces malformed frame identity as a protocol failure without guessing a transition", async () => {
  const session = selectedSession();
  const window = new CdpExecutionWindow(session);
  const result = window.start(30_000);
  deliver(session, window, {
    method: "Page.frameNavigated",
    params: {
      frame: { id: "child-frame", parentId: 7, url: "https://example.test/" },
    },
  });
  await expect(result).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "protocol_error",
  });
  expect(window.reason).toBeUndefined();
});
