import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RecordingManifest } from "../../desktop/AgentEnvComputer.js";
import { parseDesktopTask } from "../../domain/desktop/appTask.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  writeWitnessRecord,
  type EndedWitness,
} from "./DesktopBuildWitnessRecord.js";

const manifest: RecordingManifest = {
  recording_id: "rec-1",
  segments: [],
};

const witness = async (): Promise<EndedWitness> => {
  const parsed = parseDesktopTask(
    {
      name: "add-eggs",
      prompt: "Add eggs.",
      checks: [
        {
          kind: "lines_present",
          file: "Documents/today.txt",
          lines: ["eggs"],
        },
      ],
    },
    (name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    task: parsed.value,
    digest: "digest",
    directory: await createTestTempDirectory("witness-record-"),
    recordingId: "rec-1",
    stages: [],
  };
};

const log = { entries: [], dropped: 0 };

describe("writeWitnessRecord", () => {
  it("does not publish a record when the recording cannot be ended, and retries the end", async () => {
    const ended = await witness();
    const endRecording = vi
      .fn()
      .mockRejectedValueOnce(new Error("recording busy"))
      .mockResolvedValue(manifest);
    const recordingSegments = vi.fn().mockResolvedValue([]);
    const computer = { endRecording, recordingSegments };
    const signal = new AbortController().signal;

    const first = await writeWitnessRecord(computer, ended, log, signal);
    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") return;
    expect(first.manifest).toBeUndefined();
    expect(first.error.userMessage).toContain("recording busy");
    await expect(
      access(join(ended.directory, "witness.json")),
    ).rejects.toThrow();

    const second = await writeWitnessRecord(computer, ended, log, signal);
    expect(second.kind).toBe("saved");
    expect(endRecording).toHaveBeenCalledTimes(2);
    await expect(
      access(join(ended.directory, "witness.json")),
    ).resolves.toBeUndefined();
  });

  it("keeps a completed manifest and fetches only its segments on the next try", async () => {
    const ended = await witness();
    const endRecording = vi.fn().mockResolvedValue(manifest);
    const recordingSegments = vi
      .fn()
      .mockRejectedValueOnce(new Error("segment unread"))
      .mockResolvedValue([]);
    const computer = { endRecording, recordingSegments };
    const signal = new AbortController().signal;

    const first = await writeWitnessRecord(computer, ended, log, signal);
    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") return;
    expect(first.manifest).toEqual(manifest);
    await expect(
      access(join(ended.directory, "witness.json")),
    ).rejects.toThrow();

    const second = await writeWitnessRecord(
      computer,
      ended,
      log,
      signal,
      first.manifest,
    );
    expect(second.kind).toBe("saved");
    expect(endRecording).toHaveBeenCalledTimes(1);
    expect(recordingSegments).toHaveBeenCalledTimes(2);
  });
});
