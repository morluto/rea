import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBinary } from "plist";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { translateArtifactFailure } from "../ArtifactOperationFailure.js";

const bundle = async () => {
  const path = await createTestTempDirectory("rea-ib-finalization-");
  await mkdir(join(path, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(path, "Contents", "Resources", "Panel.nib"),
    Buffer.from(
      buildBinary({
        "com.apple.ibtool.document.objects": {
          button: { customClass: "NSButton", label: "Retained button" },
        },
        "com.apple.ibtool.document.connections": {},
        "com.apple.ibtool.document.hierarchy": [],
        "com.apple.ibtool.document.classes": {},
      }),
    ),
  );
  return path;
};

it.each([
  { abort: false, failClose: false },
  { abort: true, failClose: false },
  { abort: false, failClose: true },
  { abort: true, failClose: true },
])(
  "retains completed IB facts across finalization %j",
  async ({ abort, failClose }) => {
    const bundlePath = await bundle();
    const input = { bundlePath, targetSha256: "a".repeat(64) };
    const expected = await analyzeInterfaceBuilderBundle(input);
    expect(expected.documents).toHaveLength(1);
    expect(expected.graph.nodes.map(({ name }) => name)).toContain(
      "Retained button",
    );
    const resources = new ArtifactResourceScope();
    const caller = new AbortController();
    const reason = { stage: "IB final close" };
    const denied = new Error("controlled IB directory close failure");
    let attempts = 0;
    const nativeClose = DirectoryArtifactReader.prototype.close;
    const close = vi
      .spyOn(DirectoryArtifactReader.prototype, "close")
      .mockImplementation(async function (this: DirectoryArtifactReader) {
        attempts++;
        if (attempts === 1) {
          if (abort) caller.abort(reason);
          if (failClose) throw denied;
        }
        await nativeClose.call(this);
      });
    try {
      const outcome = await analyzeInterfaceBuilderBundle({
        ...input,
        resources,
        signal: caller.signal,
      }).then(
        (value) => ({ ok: true as const, value }),
        (cause) => ({ ok: false as const, cause: cause as unknown }),
      );
      if (!abort && !failClose) {
        expect(outcome).toEqual({ ok: true, value: expected });
        return;
      }
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected finalization failure");
      expect(outcome.cause).toMatchObject({
        reason: abort ? "cancelled" : "io",
        partialObservation: expected,
      });
      const projected = translateArtifactFailure(
        "decode_interface_builder",
        outcome.cause,
      );
      if (abort) expect(projected.cause).toBe(reason);
      expect(projected.partialObservation).toEqual(expected);
      expect(projected.cleanupIncomplete).toBe(failClose);
      expect(resources.hasPending).toBe(failClose);
      await resources.close();
      expect(resources.hasPending).toBe(false);
      expect(projected.cleanupIncomplete).toBe(false);
      expect(attempts).toBe(failClose ? 2 : 1);
    } finally {
      await resources.close();
      close.mockRestore();
    }
  },
);

it.each([false, true])(
  "keeps a physical IB read failure primary during late abort (close fails: %s)",
  async (failClose) => {
    const resources = new ArtifactResourceScope();
    const bundlePath = await bundle();
    const caller = new AbortController();
    const reason = { stage: "after physical refusal" };
    const failure = new ArtifactReaderFailure(
      "integrity",
      "controlled physical archive refusal",
    );
    const open = vi
      .spyOn(DirectoryArtifactReader.prototype, "open")
      .mockRejectedValue(failure);
    const nativeClose = DirectoryArtifactReader.prototype.close;
    let attempts = 0;
    const close = vi
      .spyOn(DirectoryArtifactReader.prototype, "close")
      .mockImplementation(async function (this: DirectoryArtifactReader) {
        attempts++;
        if (attempts === 1) {
          caller.abort(reason);
          if (failClose) throw new Error("controlled close failure");
        }
        await nativeClose.call(this);
      });
    try {
      const rejected: unknown = await analyzeInterfaceBuilderBundle({
        bundlePath,
        targetSha256: "a".repeat(64),
        resources,
        signal: caller.signal,
      }).catch((cause: unknown) => cause);
      expect(rejected).toMatchObject({
        reason: "integrity",
        message: failure.message,
      });
      if (failClose) expect((rejected as Error).cause).toBe(failure);
      else expect(rejected).toBe(failure);
      const projected = translateArtifactFailure(
        "decode_interface_builder",
        rejected,
      );
      expect(projected.partialObservation).toBeUndefined();
      expect(projected.cleanupIncomplete).toBe(failClose);
      await resources.close();
      expect(projected.cleanupIncomplete).toBe(false);
    } finally {
      await resources.close();
      open.mockRestore();
      close.mockRestore();
    }
  },
);
