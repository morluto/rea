import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

// This fixture uses a path longer than the legacy Windows MAX_PATH limit.
it.skipIf(process.platform === "win32").each(["complete", "cancel"])(
  "retains the inventory when %s Evidence exceeds the parent budget",
  async (mode) => {
    const root = await createTestTempDirectory("rea-js-final-evidence-limit-");
    const parts = Array.from(
      { length: 10 },
      (_, index) => `${String(index)}${"a".repeat(69)}`,
    );
    const directory = join(root, ...parts);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "app.js"), "export const value = 1;");
    const selected = [...parts, "app.js"].join("/");
    const script = `
      import { analyzeJavaScriptApplication } from './dist/application/javascript/JavaScriptApplicationService.js';
      import { ArtifactResourceScope } from './dist/artifacts/ArtifactResourceScope.js';
      const [root, selected, mode] = process.argv.slice(1);
      const scope = new ArtifactResourceScope();
      const controller = new AbortController();
      try {
        const result = await analyzeJavaScriptApplication({
          input_path: root,
          source_paths: Array(40000).fill(selected),
        }, scope, {
          signal: controller.signal,
          progress: { report: async ({ phase }) => {
            if (mode === 'cancel' && phase === 'create_javascript_application_evidence') controller.abort('fixture cancellation');
          } },
        });
        if (result.ok) throw new Error('Expected completed Evidence refusal');
        const partial = result.error.partialObservation;
        console.log(JSON.stringify({
          reason: result.error.reason,
          kind: partial?.kind,
          selected: partial?.inventory?.occurrences.some((item) => item.logical_path === selected),
        }));
      } finally { await scope.close(); }
    `;
    const { stdout } = await execute(
      process.execPath,
      [
        "--max-old-space-size=448",
        "--max-semi-space-size=8",
        "--input-type=module",
        "-e",
        script,
        root,
        selected,
        mode,
      ],
      { cwd: process.cwd(), timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      reason: "Completed application Evidence exceeds the Evidence budget",
      kind: "artifact-inventory",
      selected: true,
    });
  },
  40_000,
);
