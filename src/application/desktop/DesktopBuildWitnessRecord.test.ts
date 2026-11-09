import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AnalysisCleanupLease } from "../../artifacts/AnalysisCleanupLease.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { retryPublishedCleanup } from "./DesktopBuildWitness.js";

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

describe("published witness cleanup", () => {
  it("returns the same published error when closing the handles fails again", async () => {
    const published = new ProviderAdapterError("agentenv", "check_build_task", {
      userMessage: "handles open",
      cleanup: { reason: "handles open", resources: ["/tmp/witness"] },
    });
    const lease = new AnalysisCleanupLease(async () => {
      throw new Error("still open");
    }, ["/tmp/witness"]);
    lease.bindCleanupError(published);
    const failClose = async () => {
      throw new Error("still open");
    };
    const again = await retryPublishedCleanup(published, failClose);
    const third = await retryPublishedCleanup(published, failClose);
    expect(again.ok).toBe(false);
    expect(third.ok).toBe(false);
    if (again.ok || third.ok) return;
    expect(again.error).toBe(published);
    expect(third.error).toBe(published);
    expect(published.cleanup?.resources).toEqual(["/tmp/witness"]);
    expect(lease.released).toBe(false);
  });
});

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

    const first = await writeWitnessRecord(computer, ended, log, { signal });
    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") return;
    expect(first.manifest).toBeUndefined();
    expect(first.error.userMessage).toContain("recording busy");
    await expect(
      access(join(ended.directory, "witness.json")),
    ).rejects.toThrow();

    const second = await writeWitnessRecord(computer, ended, log, { signal });
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

    const first = await writeWitnessRecord(computer, ended, log, { signal });
    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") return;
    expect(first.manifest).toEqual(manifest);
    await expect(
      access(join(ended.directory, "witness.json")),
    ).rejects.toThrow();

    const second = await writeWitnessRecord(computer, ended, log, {
      signal,
      pendingManifest: first.manifest,
    });
    expect(second.kind).toBe("saved");
    expect(endRecording).toHaveBeenCalledTimes(1);
    expect(recordingSegments).toHaveBeenCalledTimes(2);
  });
});
