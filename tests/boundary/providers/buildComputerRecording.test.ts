import { expect, it, onTestFinished } from "vitest";

import {
  LOGGED_ACTIONS,
  LOGGED_BYTES,
  LOGGED_LIST_ITEMS,
  LOGGED_TEXT_BYTES,
} from "../../../src/application/desktop/DesktopBuildActionLog.js";
import {
  FAKE_SEGMENTS,
  type FakeComputerOptions,
  fakeBuildComputers,
} from "../../fixtures/fakeAgentEnvComputer.js";

/** A build computer held up by REA's real helper over a fake runner and driver. */
const startComputer = async (options: FakeComputerOptions = {}) => {
  const { computer, computers, start } = await fakeBuildComputers(options);
  onTestFinished(() => computers.closeAll());
  const started = await start();
  if (!started.ok) throw started.error;
  const id = started.value.value.computer_id;
  const session = computers.session(id);
  if (session === undefined) throw new Error("the started computer is held");
  return { computer, computers, id, session };
};

it("records a build session under REA's request id and fetches its segments before teardown", async () => {
  const { computer, computers, id, session } = await startComputer();
  const recording = await session.startRecording("rea-build:1");
  const acted = await computers.act(
    { computer_id: id, action: "type", text: "buy milk\n" },
    new AbortController().signal,
  );
  expect(acted.ok).toBe(true);
  const manifest = await session.endRecording(recording.recording_id);
  expect(await session.recordingSegments(manifest)).toEqual([
    { path: "rec-000000000001/0000.mp4", bytes: FAKE_SEGMENTS[0] },
    { path: "rec-000000000001/0001.mp4", bytes: FAKE_SEGMENTS[1] },
  ]);
  // One segment per request, so only one segment's body is held at a time.
  expect(computer.dataRequests).toEqual([
    [".agentenv-recordings/rec-000000000001/0000.mp4"],
    [".agentenv-recordings/rec-000000000001/0001.mp4"],
  ]);
  expect(computer.recordingRequests).toEqual([
    {
      path: "/agentenv/ext/computer-recording/start",
      body: { request_id: "rea-build:1" },
    },
    {
      path: "/agentenv/ext/computer-recording/end",
      body: { recording_id: "rec-000000000001" },
    },
  ]);
  // The witness reads what was done, in order, with the driver's arguments.
  expect(session.actions.entries).toMatchObject([
    {
      index: 0,
      action: "type",
      tool: "computer_type",
      arguments: { text: "buy milk\n" },
      outcome: "applied",
    },
  ]);
  expect(computer.unauthorized).toEqual([]);
  expect((await computers.close(id)).ok).toBe(true);
});

it("keeps a long session's action log within its allowance while the driver gets each action whole", async () => {
  const { computer, computers, id, session } = await startComputer();
  const signal = new AbortController().signal;
  const path = Array.from(
    { length: 2 * LOGGED_LIST_ITEMS },
    (_, at): [number, number] => [at, at],
  );
  expect(
    (await computers.act({ computer_id: id, action: "drag", path }, signal)).ok,
  ).toBe(true);
  const text = "buy milk ".repeat(LOGGED_TEXT_BYTES);
  const typed = LOGGED_ACTIONS;
  for (let index = 0; index < typed; index += 1)
    expect(
      (await computers.act({ computer_id: id, action: "type", text }, signal))
        .ok,
    ).toBe(true);
  expect(computer.calls.at(1)?.arguments).toEqual({ path });
  expect(computer.calls.at(-1)?.arguments).toEqual({ text });
  const { entries } = session.actions;
  expect(
    entries.reduce(
      (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)),
      0,
    ),
  ).toBeLessThanOrEqual(LOGGED_BYTES);
  expect(session.actions.total).toBe(typed + 1);
  expect(session.actions.dropped).toBe(typed + 1 - entries.length);
  expect(session.actions.dropped).toBeGreaterThan(0);
  expect(entries.at(-1)).toMatchObject({
    index: typed,
    action: "type",
    arguments: { text: text.slice(0, LOGGED_TEXT_BYTES) },
    truncated_arguments: ["text"],
    outcome: "applied",
  });
  // The drag is no longer kept, but that it was applied is.
  expect(session.actions.lastApplied).toEqual({ drag: 0, type: typed });
});

it("refuses a segment whose bytes differ from the recording's manifest", async () => {
  const { session } = await startComputer();
  const manifest = await session.endRecording("rec-000000000001");
  await expect(
    session.recordingSegments({
      ...manifest,
      segments: manifest.segments.map((segment) => ({
        ...segment,
        sha256: "0".repeat(64),
      })),
    }),
  ).rejects.toThrow(/rec-000000000001\/0000\.mp4/u);
});

it("refuses a recording larger than the allowance before reading any segment", async () => {
  const { computer, session } = await startComputer();
  const manifest = await session.endRecording("rec-000000000001");
  const total = FAKE_SEGMENTS.reduce((sum, bytes) => sum + bytes.length, 0);
  await expect(
    session.recordingSegments(manifest, undefined, total - 1),
  ).rejects.toThrow(String(total));
  expect(computer.dataRequests).toEqual([]);
});

it("stops reading a segment whose answer outgrows its manifest size", async () => {
  const { session } = await startComputer({ segmentPadding: 1024 * 1024 });
  const manifest = await session.endRecording("rec-000000000001");
  await expect(session.recordingSegments(manifest)).rejects.toThrow(
    /rec-000000000001\/0000\.mp4.*more than/u,
  );
});
