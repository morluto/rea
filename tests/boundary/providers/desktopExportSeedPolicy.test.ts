import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { exportDesktopApplication } from "../../../src/application/desktop/DesktopApplicationExport.js";
import {
  HOME,
  capture,
  change,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  {
    label: "scrubbed bytes over limit",
    before: HOME,
    bytes: 9,
    readable: false,
  },
  {
    label: "scrubbed bytes exactly at limit",
    before: HOME,
    bytes: 10,
    readable: true,
  },
  {
    label: "scrubbed bytes below limit",
    before: HOME,
    bytes: 11,
    readable: true,
  },
  {
    label: "ordinary unmodified seed",
    before: "old",
    bytes: 9,
    readable: true,
  },
])(
  "admits task seed views like the shipped reader: $label",
  async ({ before, bytes, readable }) => {
    const scratch = await createTestTempDirectory("desktop-seed-policy-");
    const homePath = ".config/notes/seed.txt";
    const path = `${HOME}/${homePath}`;
    const base = capture();
    const captured = {
      ...base,
      state: {
        ...base.state,
        checkpoints: [
          checkpoint("baseline", "baseline", [], [retained(path, before)]),
          checkpoint(
            "end",
            "request",
            [change(path, { before, after: "done" })],
            [retained(path, "done")],
          ),
        ],
      },
    };
    const folder = await writeCaptureFolder(captured, undefined, [
      before,
      "done",
    ]);
    const directory = join(scratch, "plain");
    const request = {
      capture: folder,
      directory,
      name: "notes",
      tasks: [],
      viewPolicy: { file_bytes: bytes },
    };
    // Export acquisition stays independent: an unreadable view still ships its seed.
    const plain = await exportDesktopApplication(request, readers);
    if (plain instanceof Error) throw plain;
    expect(plain.parameters).toMatchObject({
      view_policy: { file_bytes: bytes },
    });
    const seed = join(directory, "envs/notes/seed", homePath);
    expect(await readFile(seed, "utf8")).toBe(
      before === HOME ? "/home/user" : before,
    );

    // Run the actual emitted module's helpers without importing the app framework
    // or defining/launching the computer app class.
    const driver = join(scratch, "read.py");
    await writeFile(
      driver,
      `import ast, json, sys
from pathlib import Path
source = Path(sys.argv[1])
tree = ast.parse(source.read_text(), str(source))
tree.body = [node for node in tree.body if not isinstance(node, ast.ClassDef) and not (isinstance(node, ast.ImportFrom) and (node.module or "").startswith("agentenv_protocol"))]
exec(compile(tree, str(source), "exec"), globals())
print(json.dumps(_view(Path(sys.argv[2]))))
`,
    );
    const emitted = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", driver, join(directory, "envs/notes/notes_app.py"), seed],
        { encoding: "utf8" },
      ),
    ) as { view: unknown; error?: string };
    expect(emitted.view !== null).toBe(readable);
    if (!readable)
      expect(emitted.error).toBe(
        "larger than 9 bytes, the most the view reads",
      );

    const task = join(scratch, "task.json");
    await writeFile(
      task,
      JSON.stringify({
        name: "finish",
        prompt: "Write done.",
        checks: [
          {
            id: "done",
            kind: "lines_present",
            file: homePath,
            lines: ["done"],
          },
        ],
      }),
    );
    const withTask = await exportDesktopApplication(
      { ...request, directory: join(scratch, "task"), tasks: [task] },
      readers,
    );
    if (!readable) {
      expect(withTask).toBeInstanceOf(AnalysisInputError);
      expect((withTask as AnalysisInputError).userMessage).toContain(
        "No check fails on what the seed's views show",
      );
      expect((withTask as AnalysisInputError).userMessage).toContain(
        "larger than 9 bytes",
      );
    } else {
      if (withTask instanceof Error) throw withTask;
      expect(withTask.normalized_result).toMatchObject({
        tasks: [{ name: "finish", failing_on_seed: ["done"] }],
      });
    }
  },
);
