import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  renderAppClass,
  renderSkill,
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
  ["ordinary metadata", {}],
  ["quoted title with owned files", { title: 'Notes "quoted" \\ archive' }],
  [
    "quoted title with only settings",
    {
      title: 'Notes "quoted" \\ archive',
      paths: [],
      dconf: "[app]\nkey=value\n",
    },
  ],
  [
    "quoted title without state",
    { title: 'Notes "quoted" \\ archive', paths: [] },
  ],
  ["NUL in the title", { title: "Notes\0archive" }],
  ["NUL in the checkpoint label", { seedCheckpoint: "seed\0checkpoint" }],
] satisfies readonly (readonly [string, Partial<DesktopAppExportPlan>])[])(
  "compiles and preserves %s in the emitted module and class documentation",
  async (_label, fields) => {
    const selected = { ...plan, ...fields };
    const root = await createTestTempDirectory("desktop-docstring-");
    const module = join(root, "app.py");
    const probe = join(root, "probe.py");
    await writeFile(module, renderAppClass(selected));
    await writeFile(
      probe,
      `import ast, json
from pathlib import Path
source = (Path(__file__).parent / "app.py").read_text(encoding="utf-8")
tree = ast.parse(source)
# Compile the complete emitted module; no framework imports or app code execute.
compile(tree, "app.py", "exec")
app = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Notes")
print(json.dumps({"module": ast.get_docstring(tree, clean=False), "class": ast.get_docstring(app, clean=False)}))
`,
    );
    const documents: unknown = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", "-X", "utf8", probe],
        { encoding: "utf8" },
      ),
    );
    expect(documents).toEqual({
      module: `${selected.title} as an agentenv computer app, exported by REA from a desktop application capture.

Package: notes. Capture Evidence: fixture.
The seed is the user's state at checkpoint ${selected.seedCheckpoint}: keep this bundle local.
`,
      class: expect.stringContaining(`${selected.title}, launched at boot`),
    });
  },
);

it.each([
  ["ordinary metadata", "Notes", "Notes"],
  ["colon in the title", "Notes: editor", "Notes"],
  ["comment marker in the title", "Notes #1", "Notes"],
  ["a line break in the title", "Notes\nextra: value", "Notes"],
  ["colon in the window class", "Notes", "Notes: main"],
  ["NUL in the title", "Notes\0archive", "Notes"],
  ["quotes and backslashes", 'Notes "quoted" \\ archive', "Notes"],
])("keeps %s as one skill description string", (_label, title, windowClass) => {
  const source = renderSkill({ ...plan, title, windowClass });
  const frontmatter = /^---\n(?<yaml>[\s\S]*?)\n---(?:\n|$)/u.exec(source)
    ?.groups?.yaml;
  expect(frontmatter).toBeDefined();
  const document = parseDocument(frontmatter ?? "");
  expect(document.errors).toEqual([]);
  expect(document.toJSON()).toEqual({
    description: `Use ${title} on this Linux desktop; its window has class ${windowClass}.`,
  });
});
