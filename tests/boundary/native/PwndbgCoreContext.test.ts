import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../../tests/support/workspace/workspaceFixture.js";
import { inspectPwndbgCore } from "../../../src/native/pwndbg/PwndbgCoreContext.js";

const diagnostics = { stdout: "", stderr: "", truncated: false };

it.each(["pre-aborted", "aborted-during-probe"] as const)(
  "cancellation wins over debugger path failures: %s",
  async (scenario) => {
    const workspace = await createTestWorkspace("rea-pwndbg-cancel-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const controller = new AbortController();
    const gdb = join(workspace.root, "missing-gdb");
    let probes = 0;
    const probePath = async () => {
      probes++;
      if (scenario === "aborted-during-probe") {
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            controller.abort();
            resolve();
          });
        });
        throw new Error("path became unavailable");
      }
      throw new Error("path is unavailable");
    };
    if (scenario === "pre-aborted") controller.abort();
    await expect(
      inspectPwndbgCore({
        environment: {
          REA_PWNDBG_GDB: gdb,
          REA_PWNDBG_GDBINIT: join(workspace.root, "missing-init"),
          REA_PWNDBG_VENV_PATH: join(workspace.root, "missing-venv"),
        },
        rootPath: workspace.root,
        diagnostics,
        options: { signal: controller.signal },
        probePath,
      }),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(probes).toBe(scenario === "pre-aborted" ? 0 : 1);
    await expect(
      access(join(workspace.root, "debugger")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
