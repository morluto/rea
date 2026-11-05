import { expect, it, onTestFinished } from "vitest";

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
  expect(session.actions).toMatchObject([
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
