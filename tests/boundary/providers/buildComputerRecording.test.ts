import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { DesktopBuildComputers } from "../../../src/application/desktop/DesktopBuildComputers.js";
import {
  FAKE_SEGMENT,
  fakeAgentEnvRunner,
  startFakeComputer,
} from "../../fixtures/fakeAgentEnvComputer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** A build computer held up by REA's real helper over a fake runner and driver. */
const startComputer = async () => {
  const computer = await startFakeComputer();
  onTestFinished(() => computer.close());
  const runner = await fakeAgentEnvRunner(computer);
  const computers = new DesktopBuildComputers({
    ...process.env,
    ...runner.environment,
  });
  onTestFinished(() => computers.closeAll());
  const bundle = await createTestTempDirectory("exported-bundle-");
  await mkdir(join(bundle, "tasks"));
  await writeFile(join(bundle, "tasks", "smoke.json"), "[]\n");
  const started = await computers.start(
    { source: { kind: "bundle", path: bundle } },
    new AbortController().signal,
  );
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
    { path: "rec-000000000001/0000.mp4", bytes: FAKE_SEGMENT },
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
