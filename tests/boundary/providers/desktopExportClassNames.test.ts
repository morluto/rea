import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  className,
  renderAppClass,
  type DesktopAppExportPlan,
} from "../../../src/domain/desktop/appExport.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const plan: DesktopAppExportPlan = {
  name: "notes",
  className: "Notes",
  title: "Notes",
  aptPackage: "notes",
  aptRelease: null,
  packageVersion: null,
  libraryPackages: [],
  aptSources: [],
  architectures: ["amd64"],
  packageFile: null,
  electron: false,
  command: ["notes"],
  windowClass: "Notes",
  paths: ["Documents"],
  capturedHome: "/home/fixture",
  seedCheckpoint: "seed",
  seedFiles: [],
  textSeeds: [],
  unseededFiles: [],
  dconf: "",
  captureEvidenceId: "fixture",
};

it.each([
  "value-error",
  "unicode-decode-error",
  "o-s-error",
  "e-o-f-error",
  "not-implemented-error",
  "recursion-error",
  "notes",
])(
  "keeps reader failures local after defining the %s app class",
  async (name) => {
    const root = await createTestTempDirectory("desktop-class-name-");
    const module = join(root, "app.py");
    const probe = join(root, "probe.py");
    await writeFile(
      module,
      renderAppClass({ ...plan, name, className: className(name) }),
    );
    await writeFile(
      probe,
      `import ast, json
from pathlib import Path
root = Path(__file__).parent
module = root / "app.py"
tree = ast.parse(module.read_text(encoding="utf-8"))
# Exercise the emitted class binding and readers without installing or launching agentenv.
tree.body = [node for node in tree.body if not isinstance(node, ast.ImportFrom)
             or not (node.module or "").startswith("agentenv_protocol")]
for node in ast.walk(tree):
    if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
        node.decorator_list = []
scope = {"__file__": str(module), "ComputerAppEnvironment": object}
exec(compile(tree, str(module), "exec"), scope)
files = {"valid.json": b'{"mode":"done"}', "invalid.json": b'{"mode":"unfinished}',
         "binary.dat": b"\\xff", "broken.zip": b"PK\\x03\\x04bad",
         "broken.db": b"SQLite format 3\\x00" + bytes(84)}
for name, data in files.items():
    (root / name).write_bytes(data)
views = scope["_views"](root, list(files))
assert all((root / name).read_bytes() == data for name, data in files.items())
print(json.dumps(views))
`,
    );
    const views: unknown = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", "-X", "utf8", probe],
        { encoding: "utf8" },
      ),
    );
    expect(views).toEqual({
      "valid.json": {
        format: "json",
        view: { mode: "done" },
        truncated: false,
      },
      "invalid.json": {
        format: "text",
        view: {
          lines: ['{"mode":"unfinished}'],
          line_count: 1,
          truncated: false,
        },
        truncated: false,
      },
      "binary.dat": { format: "binary", view: null, truncated: false },
      "broken.zip": {
        format: "zip",
        view: null,
        error: "not a readable zip archive",
      },
      "broken.db": { format: null, view: null, error: expect.any(String) },
    });
  },
);
