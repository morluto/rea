import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";

import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

it("builds a dispatch probe from the current runner without changing its source", async () => {
  const workspace = await createTestWorkspace("rea-ui-dispatch-builder-");
  const runner = new URL(
    "../../../bridge/adb-ui/src/main/java/dev/rea/uiautomator/ReaUiRunner.java",
    import.meta.url,
  );
  const original = await readFile(runner, "utf8");
  try {
    const output = workspace.path("probe");
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../../experiments/adb-ui/build-dispatch-probe.mjs",
            import.meta.url,
          ),
        ),
        "--output",
        output,
      ],
      { cwd: workspace.root, timeout: 15_000 },
    );
    const generated = await readFile(
      join(
        output,
        "project/src/main/java/dev/rea/uiautomator/ReaUiRunner.java",
      ),
      "utf8",
    );
    const receipt = z
      .object({
        source_sha256: z.string(),
        probe_sha256: z.string(),
        input_focus_anchor: z.string(),
        modes: z.object({ "11003": z.string() }),
      })
      .parse(JSON.parse(await readFile(join(output, "probe.json"), "utf8")));
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    expect(receipt.source_sha256).toBe(digest(original));
    expect(receipt.probe_sha256).toBe(digest(generated));
    expect(await readFile(runner, "utf8")).toBe(original);
    expect(generated).toContain(
      'if (!(input.getInt("timeout_ms") != 11003 && window.isFocused())',
    );
    expect(original).toContain(receipt.input_focus_anchor);
    expect(receipt.modes["11003"]).toContain("real active state unchanged");
    expect(
      generated.match(/input\.getInt\("timeout_ms"\) != 11003/gu),
    ).toHaveLength(1);

    for (const action of ["drag", "key_event"]) {
      const branch = generated
        .split(`case "${action}":`)[1]
        ?.split("break;")[0];
      expect(branch).toBeDefined();
      expect(branch).toMatch(
        /if \(input.getInt\("timeout_ms"\) == 11001\) call.cancelled = true;\s+if \(input.getInt\("timeout_ms"\) == 11002\) call.deadline = 0;\s+call.check\(\);\s+attempted = true;/u,
      );
    }
    expect(
      await readFile(join(output, "project/build.gradle"), "utf8"),
    ).toContain("versionName = 'dispatch-guard-probe'");
  } finally {
    await removeTestWorkspace(workspace.root);
  }
});
