import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";

import {
  readJsonFile,
  readJsonObjectMembersFile,
} from "../../src/application/JsonFiles.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

it.each(["document", "selected members"] as const)(
  "preserves the opaque caller reason when cancelling a streamed JSON %s",
  async (mode) => {
    const workspace = await createTestWorkspace("rea-json-pipeline-cancel-");
    const path = await workspace.write(
      "input.json",
      `${" ".repeat(9 * 1024 * 1024)}{"value":1}`,
    );
    const controller = new AbortController();
    const reason = new AggregateError(
      [new Error("caller-owned data, not a pipeline error")],
      "opaque cancellation",
    );
    const open = fs.open;
    let handle: FileHandle | undefined;
    let reads = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const opened = await open(...args);
      if (String(args[0]) === path) {
        handle = opened;
        const read = opened.read;
        vi.spyOn(opened, "read").mockImplementation(async (...parameters) => {
          reads += 1;
          // An in-flight physical read races the parser's abort. Node may
          // aggregate both cancellation envelopes before the file owner closes.
          if (reads === 1) controller.abort(reason);
          return Reflect.apply(read, opened, parameters);
        });
      }
      return opened;
    });
    syncBuiltinESMExports();
    try {
      const result =
        mode === "document"
          ? await readJsonFile(path, controller.signal)
          : await readJsonObjectMembersFile(
              path,
              [new Map()],
              controller.signal,
            );
      if (result.ok) throw new Error("Expected cancelled JSON input");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(reads).toBe(1);
      expect(handle?.fd).toBe(-1);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      if (handle !== undefined && handle.fd >= 0) await handle.close();
      await removeTestWorkspace(workspace.root);
    }
  },
);
