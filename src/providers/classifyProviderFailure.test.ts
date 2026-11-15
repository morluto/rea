import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  ArtifactFileCleanupFailure,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { AnalysisPartialObservation } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "./classifyProviderFailure.js";

describe("classifyProviderFailure attribution", () => {
  const unclassified = (cause: unknown) =>
    new AnalysisOutputError("list", String(cause), { cause });

  it("attributes a typed failure through the dialect and passes it through without one", () => {
    const typed = new AnalysisTimeoutError("startup", 5);
    const attributed = new AnalysisTimeoutError("list", 5, { cause: typed });
    expect(
      classifyProviderFailure(typed, {
        providerId: "fixture",
        operation: "list",
        attribute: (failure) => (failure === typed ? attributed : failure),
        unclassified,
      }),
    ).toBe(attributed);
    expect(
      classifyProviderFailure(typed, {
        providerId: "fixture",
        operation: "list",
        unclassified,
      }),
    ).toBe(typed);
  });

  it("attributes a cleanup-failed read's typed primary before its cleanup is reported", async () => {
    const root = await createTestTempDirectory("rea-attributed-cleanup-");
    const path = join(root, "selected");
    await writeFile(path, "bytes");
    const scope = new ArtifactResourceScope();
    let mayClose = false;
    const typed = new AnalysisTimeoutError("startup", 5);
    const attributed = new AnalysisTimeoutError("list", 5, { cause: typed });
    try {
      const cause: unknown = await withArtifactRegularFile(
        path,
        scope,
        undefined,
        async ({ handle: file }) => {
          const close = file.close.bind(file);
          file.close = async () => {
            if (!mayClose) throw new Error("controlled close failure");
            await close();
          };
          throw typed;
        },
      ).catch((failure: unknown) => failure);
      expect(cause).toBeInstanceOf(ArtifactFileCleanupFailure);
      let reported: unknown;
      classifyProviderFailure(cause, {
        providerId: "fixture",
        operation: "list",
        attribute: (failure) => (failure === typed ? attributed : failure),
        readCleanup: (read, primary) => {
          reported = primary;
          return new AnalysisOutputError("list", read.message);
        },
        unclassified,
      });
      expect(reported).toBe(attributed);
    } finally {
      mayClose = true;
      await scope.close();
    }
  });

  it("does not attribute the provider's own unclassified report", () => {
    const failure = classifyProviderFailure("raw", {
      providerId: "fixture",
      operation: "list",
      attribute: () => {
        throw new Error("only typed causes are attributed");
      },
      unclassified,
    });
    expect(failure).toBeInstanceOf(AnalysisOutputError);
  });
});

describe("classifyProviderFailure cancelled reads", () => {
  const partial: AnalysisPartialObservation = {
    kind: "omitted-observation",
    reason: "recovery-input-invalid",
  };
  const unclassified = (cause: unknown) =>
    new AnalysisOutputError("read", String(cause), { cause });

  it("keeps the read's partial observation and the provider's diagnostics", () => {
    const reason = { caller: "stop" };
    const failure = classifyProviderFailure(
      new ArtifactReaderFailure("cancelled", "read cancelled", {
        cause: reason,
        partialObservation: partial,
      }),
      {
        providerId: "fixture",
        operation: "read",
        diagnostics: { path: "/selected" },
        unclassified,
      },
    );
    expect(failure).toMatchObject({
      _tag: "AnalysisCancelledError",
      partialObservation: partial,
      diagnostics: { path: "/selected" },
    });
  });

  it("keeps them on the primary of a cancelled read whose cleanup failed", () => {
    let primary: unknown;
    classifyProviderFailure(
      new ArtifactReaderFailure("cancelled", "read cancelled", {
        cause: { caller: "stop" },
        partialObservation: partial,
        cleanup: { reason: "close failed", resources: ["/selected"] },
      }),
      {
        providerId: "fixture",
        operation: "read",
        diagnostics: { path: "/selected" },
        readCleanup: (read, reported) => {
          primary = reported;
          return new AnalysisOutputError("read", read.message);
        },
        unclassified,
      },
    );
    expect(primary).toMatchObject({
      _tag: "AnalysisCancelledError",
      partialObservation: partial,
      diagnostics: { path: "/selected" },
    });
  });
});
