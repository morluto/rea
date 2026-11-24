import { createDeferred } from "../../../../tests/fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../../../tests/fixtures/lifecycleAcknowledgement.js";
import { readFile, rename, copyFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../../resources/ArtifactResourceScope.js";
import { PlaywrightTraceDecoder } from "./PlaywrightTraceDecoder.js";
import { PlaywrightTraceService } from "../../../application/playwrightTrace/PlaywrightTraceService.js";
import { projectAnalysisError } from "../../../domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../domain/evidence.js";
import { playwrightTraceSchema } from "../../../domain/playwrightTrace/playwrightTrace.js";
import { playwrightTraceFixture } from "../../../../tests/fixtures/playwrightTrace.js";
import { OwnedFileHandle } from "../../../filesystem/OwnedFileHandle.js";
import { ZipArtifactReader } from "../../../resources/index.js";

it("preserves only fully verified streams when cancellation arrives before the network member", async () => {
  const fixture = await playwrightTraceFixture();
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { stage: "network-member" };
  const realOpen = ZipArtifactReader.prototype.open;
  const opened = vi
    .spyOn(ZipArtifactReader.prototype, "open")
    .mockImplementation(function (this: ZipArtifactReader, entry, signal) {
      if (entry.path.endsWith(".network")) controller.abort(reason);
      return realOpen.call(this, entry, signal);
    });
  try {
    const result = await new PlaywrightTraceService(
      new PlaywrightTraceDecoder(resources),
    ).inspect({ path: fixture.path }, controller.signal);
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    const partial = playwrightTraceSchema.parse(
      parseEvidence(result.error.partialObservation).normalized_result,
    );
    expect(partial.summary.events).toBe(20);
    expect(partial.summary.network).toBe(0);
    expect(partial.source_coverage.interpretation).toBe("partial");
    expect(resources.hasPending).toBe(false);
  } finally {
    opened.mockRestore();
    await resources.close();
  }
});

it("retains complete Evidence and the exact failed reader owner when abort arrives during final cleanup", async () => {
  const fixture = await playwrightTraceFixture();
  const bytes = await readFile(fixture.path);
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { stage: "final-reader-cleanup" };
  const realClose = ZipArtifactReader.prototype.close;
  const closed = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementationOnce(async function (this: ZipArtifactReader) {
      await realClose.call(this);
      controller.abort(reason);
      throw new Error("Injected reader close acknowledgement failure");
    });
  try {
    const result = await new PlaywrightTraceService(
      new PlaywrightTraceDecoder(resources),
    ).inspect({ path: fixture.path }, controller.signal);
    if (result.ok) throw new Error("Expected composed failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupPrimary?._tag).toBe("AnalysisCancelledError");
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
    expect(
      playwrightTraceSchema.parse(
        parseEvidence(result.error.partialObservation).normalized_result,
      ).summary.events,
    ).toBe(23);
    expect(resources.hasPending).toBe(true);
    await resources.retryCleanup();
    expect(resources.hasPending).toBe(false);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(
      parseEvidence(result.error.cleanupPrimary?.partialObservation).operation,
    ).toBe("inspect_playwright_trace");
    expect((await readFile(fixture.path)).equals(bytes)).toBe(true);
  } finally {
    closed.mockRestore();
    await resources.close();
  }
});

it("keeps completed Evidence on cancellation during the outer descriptor close", async () => {
  const fixture = await playwrightTraceFixture();
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { stage: "outer-descriptor-close" };
  const realClose = OwnedFileHandle.prototype.close;
  const closed = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedFileHandle) {
      await realClose.call(this);
      controller.abort(reason);
    });
  try {
    const result = await new PlaywrightTraceService(
      new PlaywrightTraceDecoder(resources),
    ).inspect({ path: fixture.path }, controller.signal);
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(
      playwrightTraceSchema.parse(
        parseEvidence(result.error.partialObservation).normalized_result,
      ).summary.events,
    ).toBe(23);
    expect(resources.hasPending).toBe(false);
  } finally {
    closed.mockRestore();
    await resources.close();
  }
});

it.each([false, true])(
  "keeps an unsupported-version refusal and late cancellation through reader close (fails: %s)",
  async (closeFails) => {
    const fixture = await playwrightTraceFixture({
      trace: '{"type":"context-options","version":11}\n',
      network: "",
    });
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = { stage: "late reader close" };
    const realClose = ZipArtifactReader.prototype.close;
    let allowClose = !closeFails;
    const close = vi
      .spyOn(ZipArtifactReader.prototype, "close")
      .mockImplementation(async function (this: ZipArtifactReader) {
        controller.abort(reason);
        if (!allowClose) throw new Error("Injected reader close failure");
        await realClose.call(this);
      });
    try {
      const result = await new PlaywrightTraceDecoder(resources).inspect(
        fixture.path,
        controller.signal,
      );
      if (result.ok) throw new Error("Expected version refusal");
      const primary = result.error.cleanupPrimary ?? result.error;
      expect(primary._tag).toBe("AnalysisTargetFailureError");
      expect(primary.secondaryFailures).toHaveLength(1);
      expect(primary.secondaryFailures[0]?._tag).toBe("AnalysisCancelledError");
      expect(primary.secondaryFailures[0]?.cause).toBe(reason);
      expect(
        projectAnalysisError(result.error).details?.secondary_failures,
      ).toEqual([expect.objectContaining({ code: "cancelled" })]);
      expect(result.error.cleanupIncomplete).toBe(closeFails);
      expect(resources.cleanupResources).toEqual(
        closeFails ? [`Playwright ZIP reader for ${fixture.path}`] : [],
      );
      allowClose = true;
      await resources.retryCleanup();
      expect(resources.hasPending).toBe(false);
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      allowClose = true;
      try {
        await resources.close();
      } finally {
        close.mockRestore();
      }
    }
  },
);

it("retains independent reader and file owners until both cleanup retries complete", async () => {
  const fixture = await playwrightTraceFixture();
  const resources = new ArtifactResourceScope();
  const realClose = ZipArtifactReader.prototype.close;
  const reader = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementationOnce(async function (this: ZipArtifactReader) {
      await realClose.call(this);
      throw new Error("Injected reader acknowledgement failure");
    });
  const descriptor = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedFileHandle) {
      throw new Error("Injected descriptor close failure");
    });
  try {
    const result = await new PlaywrightTraceService(
      new PlaywrightTraceDecoder(resources),
    ).inspect({ path: fixture.path });
    if (result.ok) throw new Error("Expected cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(resources.cleanupResources).toHaveLength(2);
    expect(
      playwrightTraceSchema.parse(
        parseEvidence(result.error.partialObservation).normalized_result,
      ).summary.events,
    ).toBe(23);
    await resources.retryCleanup();
    expect(resources.hasPending).toBe(false);
    expect(result.error.cleanupIncomplete).toBe(false);
  } finally {
    reader.mockRestore();
    descriptor.mockRestore();
    await resources.close();
  }
});

it.skipIf(process.platform === "win32")(
  "refuses source replacement without rebinding the archive identity",
  async () => {
    const fixture = await playwrightTraceFixture();
    const replacement = await playwrightTraceFixture({
      trace: '{"type":"context-options","version":10}\n',
      network: "",
    });
    const original = await readFile(fixture.path);
    const resources = new ArtifactResourceScope();
    const held = fixture.path + ".held";
    const realOpen = ZipArtifactReader.prototype.open;
    let replaced = false;
    const opened = vi
      .spyOn(ZipArtifactReader.prototype, "open")
      .mockImplementation(async function (
        this: ZipArtifactReader,
        entry,
        signal,
      ) {
        if (entry.path.endsWith(".network") && !replaced) {
          replaced = true;
          await rename(fixture.path, held);
          await copyFile(replacement.path, fixture.path);
        }
        return realOpen.call(this, entry, signal);
      });
    try {
      const result = await new PlaywrightTraceDecoder(resources).inspect(
        fixture.path,
      );
      if (result.ok) throw new Error("Expected source identity refusal");
      expect(result.error._tag).toBe("AnalysisArtifactChangedError");
      expect((await readFile(held)).equals(original)).toBe(true);
      expect(resources.hasPending).toBe(false);
    } finally {
      opened.mockRestore();
      await resources.close();
    }
  },
);

it("bounds active imports without an unbounded queue and releases admission after completion", async () => {
  const fixture = await playwrightTraceFixture();
  const resources = new ArtifactResourceScope();
  const port = new PlaywrightTraceDecoder(resources);
  const reached = createDeferred<void>(),
    release = createDeferred<void>();
  const realRun = resources.run.bind(resources);
  const running = vi
    .spyOn(resources, "run")
    .mockImplementationOnce(
      async <Value>(operation: () => Promise<Value>): Promise<Value> => {
        reached.resolve();
        await release.promise;
        return realRun(operation);
      },
    );
  const first = port.inspect(fixture.path);
  try {
    await awaitAcknowledgement(reached.promise, first, "trace import");
    const second = await port.inspect(fixture.path);
    if (second.ok) throw new Error("Expected capacity refusal");
    expect(second.error._tag).toBe("AnalysisResourceConstraintError");
    release.resolve();
    expect((await first).ok).toBe(true);
    expect((await port.inspect(fixture.path)).ok).toBe(true);
    expect(resources.hasPending).toBe(false);
  } finally {
    release.resolve();
    await first;
    running.mockRestore();
    await resources.close();
  }
});
