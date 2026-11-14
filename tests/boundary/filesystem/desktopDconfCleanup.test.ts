import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { expect, it } from "vitest";

import { withArtifactFileHandle } from "../../../src/artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { inspectDesktopApplicationState } from "../../../src/application/desktop/DesktopApplicationState.js";
import {
  HOME,
  capture,
  change,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import { err } from "../../../src/domain/result.js";

it
  .skipIf(process.platform === "win32")
  .each(["completed", "failed", "cancelled", "persistent"] as const)(
  "closes the staged dconf descriptor before its directory: %s",
  async (outcome) => {
    const path = `${HOME}/.config/dconf/user`;
    const bytes = Buffer.from("GVariant\0\0\0\0");
    const original = capture();
    const folder = await writeCaptureFolder(
      {
        ...original,
        state: {
          ...original.state,
          checkpoints: [
            checkpoint(
              "baseline",
              "baseline",
              [change(path, { after: bytes })],
              [retained(path, bytes)],
            ),
          ],
        },
      },
      undefined,
      [bytes],
    );
    const resources = new ArtifactResourceScope();
    const reason = { selected: "cancel" };
    let staged = "";
    let attempts = 0;
    let release: (() => Promise<void>) | undefined;
    let fault = true;
    const stateReaders = {
      ...readers,
      resources,
      dconf: async (database: string, signal?: AbortSignal) => {
        staged = database;
        const file = await open(database, "r");
        release = file.close.bind(file);
        file.close = async () => {
          attempts++;
          // Both initial close and staged-directory retirement fail. The command
          // owner must retain this exact handle and try again during final close.
          if (fault && (outcome === "persistent" || attempts <= 2))
            throw new Error("controlled descriptor close refusal");
          // The staging directory must still exist at successful descriptor close.
          expect((await stat(dirname(database))).isDirectory()).toBe(true);
          await release?.();
        };
        return withArtifactFileHandle(
          database,
          file,
          undefined,
          signal,
          async () => {
            if (outcome === "failed") throw new Error("selected dump failed");
            if (outcome === "cancelled")
              throw new ArtifactReaderFailure(
                "cancelled",
                "selected dump cancelled",
                {
                  cause: reason,
                  cancellation: { reason },
                },
              );
            return { ok: true as const, text: "[org/notes/]\nsetting=true\n" };
          },
        );
      },
    };
    try {
      const result = await inspectDesktopApplicationState(folder, stateReaders);
      expect(result).toBeInstanceOf(AnalysisError);
      if (!(result instanceof AnalysisError)) throw result;
      if (outcome === "cancelled")
        expect(primaryAnalysisError(result)).toMatchObject({
          _tag: "AnalysisCancelledError",
          cause: reason,
        });
      expect(result.cleanupIncomplete).toBe(true);
      expect(resources.hasPending).toBe(true);
      expect((await stat(dirname(staged))).isDirectory()).toBe(true);
      const final = await finishAnalysisCommand(
        async () => err(result),
        resources,
        "rea-desktop",
        "inspect_desktop_application_state",
        new AbortController().signal,
      );
      expect(final.ok).toBe(false);
      expect(attempts).toBe(3);
      if (outcome === "persistent") {
        expect(result.cleanupIncomplete).toBe(true);
        expect((await stat(dirname(staged))).isDirectory()).toBe(true);
        fault = false;
        await resources.close();
      }
      expect(result.cleanupIncomplete).toBe(false);
      await expect(stat(dirname(staged))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      fault = false;
      await resources.close();
      await release?.();
    }
  },
);
