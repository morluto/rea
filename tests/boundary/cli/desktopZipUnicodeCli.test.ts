import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import {
  HOME,
  capture,
  change,
  retained,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { desktopApplicationStateSchema } from "../../../src/domain/desktop/desktopState.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  unicodePathExtra,
  zipArchive,
} from "../../../src/domain/desktop/zipArchive.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const retainedZipCapture = async () => {
  const member = "settings.json";
  const file = "Documents/state.zip";
  const path = `${HOME}/${file}`;
  const archives = [1, 2].map((zoom) =>
    zipArchive([
      {
        name: member,
        data: JSON.stringify({ zoom }),
        ...(zoom === 1
          ? {}
          : {
              centralExtra: Buffer.concat([
                unicodePathExtra(member, "hidden/"),
                unicodePathExtra(member, member),
              ]),
            }),
      },
    ]),
  );
  const [before, after] = archives;
  const base = capture();
  const [seed, end] = base.state.checkpoints;
  if (
    before === undefined ||
    after === undefined ||
    seed === undefined ||
    end === undefined
  )
    throw new Error("missing fixture checkpoint");
  const folder = await writeCaptureFolder(
    {
      ...base,
      state: {
        ...base.state,
        checkpoints: [
          { ...seed, retained: [...seed.retained, retained(path, before)] },
          {
            ...end,
            changes: [...end.changes, change(path, { before, after })],
            retained: [...end.retained, retained(path, after)],
          },
        ],
      },
    },
    undefined,
    archives,
  );
  return { member, file, path, archives, folder };
};

cliTest(
  "retains a ZIP file through compiled state inspection and task export despite an earlier Unicode directory claim",
  async ({ cli }) => {
    const { member, file, path, archives, folder } = await retainedZipCapture();
    const root = await createTestTempDirectory("desktop-zip-unicode-");
    const absentTask = join(root, "absent.json");
    await writeFile(
      absentTask,
      JSON.stringify({
        name: "removed",
        prompt: "Remove settings.json from the archive.",
        checks: [
          {
            id: "removed",
            kind: "value_absent",
            file,
            pointer: "/entries/[name=settings.json]",
          },
        ],
      }),
    );
    const absent = await cli.run({
      arguments: [
        "export-desktop-application",
        folder,
        join(root, "absent-bundle"),
        "--task",
        absentTask,
        "--json",
      ],
    });
    // A complete-looking empty view once made this false removal task pass
    // against the captured end, despite the file still being present.
    expect(absent.exitCode, absent.stdout).toBe(1);
    expect(absent.json).toMatchObject({ code: "invalid_request" });
    const inspected = await cli.run({
      arguments: [
        "inspect-desktop-application-state",
        folder,
        "--state-path",
        path,
        "--json",
      ],
    });
    expect(inspected.exitCode, inspected.stdout).toBe(0);
    const state = desktopApplicationStateSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    expect(state.paths[0]?.versions).toMatchObject(
      [1, 2].map((zoom, i) => ({
        sha256: createHash("sha256").update(archives[i]!).digest("hex"),
        view: {
          entries: [{ name: member, view: { zoom }, view_error: null }],
          entry_count: 1,
          truncated: false,
        },
      })),
    );
    const task = join(root, "task.json");
    await writeFile(
      task,
      JSON.stringify({
        name: "zoom",
        prompt: "Set zoom to 2 and save the document.",
        checks: [
          {
            id: "zoom",
            kind: "value_equals",
            file,
            pointer: "/entries/[name=settings.json]/view/zoom",
            value: 2,
          },
        ],
      }),
    );
    const bundle = join(root, "bundle");
    const exported = await cli.run({
      arguments: [
        "export-desktop-application",
        folder,
        bundle,
        "--task",
        task,
        "--json",
      ],
    });
    expect(exported.exitCode, exported.stdout).toBe(0);
    expect(parseEvidence(exported.json).normalized_result).toMatchObject({
      tasks: [{ name: "zoom", failing_on_seed: ["zoom"] }],
    });
    // Run the exact emitted reader, without the unavailable AgentEnv framework.
    const module = await readFile(
      join(bundle, "envs/notes/notes_app.py"),
      "utf8",
    );
    const helpers = module
      .split("@computer_app(")[0]!
      .split("\n")
      .filter((line) => !line.includes("from agentenv_protocol"))
      .join("\n");
    const verifier = (
      await readFile(join(bundle, "artifacts/zoom-check/verify.py"), "utf8")
    )
      .split("\n")
      .filter((line) => !line.includes("from agentenv_protocol"))
      .join("\n");
    const copies = [join(root, "seed.zip"), join(root, "end.zip")];
    await Promise.all(copies.map((copy, i) => writeFile(copy, archives[i]!)));
    const script = join(root, "reader.py");
    await writeFile(
      script,
      `${helpers}\n${verifier}\nseen = [_view(Path(p)) for p in json.load(sys.stdin)]\nprint(json.dumps({"views": [v["view"] for v in seen], "grades": [[r["result"] for r in evaluate(CHECKS, {${JSON.stringify(file)}: v})] for v in seen]}))\n`,
    );
    const views: unknown = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", script],
        { input: JSON.stringify(copies), encoding: "utf8" },
      ),
    );
    expect(views).toMatchObject({
      views: [1, 2].map((zoom) => ({
        entries: [{ name: member, view: { zoom } }],
        entry_count: 1,
        truncated: false,
      })),
      grades: [[false], [true]],
    });
    expect(await Promise.all(copies.map((copy) => readFile(copy)))).toEqual(
      archives,
    );
  },
);
