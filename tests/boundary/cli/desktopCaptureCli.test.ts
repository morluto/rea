import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  EDITED_NOTE,
  HOME,
  capture,
  change,
  retained,
  seedEndCapture,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { hasReadableProcDescriptor } from "../../fixtures/desktopDconfHost.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { serveCli as serve } from "./cliServeHarness.js";
import { desktopSlashCapture } from "../../fixtures/desktopSlashCapture.js";

it("drafts checks and guards for a literal slash key distinct from a nested selector", async () => {
  const { recorded, before, after } = desktopSlashCapture();
  const folder = await writeCaptureFolder(recorded, undefined, [
    EDITED_NOTE,
    before,
    after,
  ]);
  const result = await serve([
    "describe-desktop-application-task",
    folder,
    "--seed-checkpoint",
    "seed",
    "--end-checkpoint",
    "end",
    "--json",
  ]);
  expect(result.exitCode, result.stdout).toBe(0);
  const draft = parseEvidence(JSON.parse(result.stdout)).normalized_result as {
    task: { checks: Array<{ pointer?: string }> };
    guards: Array<{ pointer?: string }>;
  };
  expect(draft.task.checks.map((check) => check.pointer)).toContain(
    "/nodes/[format=BOOK][>data~1Title=New]/data~1Title",
  );
  expect(draft.guards.map((guard) => guard.pointer)).toContain(
    "/nodes/[format=BOOK][>data~1Title=Second]/data~1Title",
  );
});

cliTest.skipIf(process.platform !== "linux")(
  "exports an env-terminated Electron-style launch that native env can execute",
  async ({ cli }) => {
    const root = await createTestTempDirectory("desktop-env-export-");
    const program = join(root, "notes");
    await writeFile(
      program,
      `#!${process.execPath}\nconsole.log(JSON.stringify({argv:process.argv.slice(2),sentinel:process.env.REA_TEST_ENV}));\n`,
      { mode: 0o755 },
    );
    const recorded = seedEndCapture();
    const argv = [
      "/usr/bin/env",
      "--",
      "REA_TEST_ENV=selected",
      program,
      "--title=sample",
    ];
    const folder = await writeCaptureFolder(
      {
        ...recorded,
        application: {
          ...recorded.application,
          argv,
          executable: {
            path: program,
            resolved_path: program,
            electron_markers: ["fuse-sentinel"],
          },
        },
      },
      undefined,
      [EDITED_NOTE],
    );
    const bundle = join(root, "bundle");
    const result = await cli.run({
      arguments: [
        "export-desktop-application",
        folder,
        bundle,
        "--seed-checkpoint",
        "seed",
        "--end-checkpoint",
        "end",
        "--json",
      ],
    });
    expect(result.exitCode, result.stdout).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence.parameters).toMatchObject({
      seed_checkpoint: "seed",
      end_checkpoint: "end",
    });
    const module = await readFile(
      join(bundle, "envs/notes/notes_app.py"),
      "utf8",
    );
    // Read the emitted Launch literal without importing agentenv or executing app hooks.
    const raw: unknown = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-c",
          'import ast,json,sys\ntree=ast.parse(sys.stdin.read())\nlaunch=next(n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=="Launch")\nprint(json.dumps(ast.literal_eval(next(k.value for k in launch.keywords if k.arg=="command"))))',
        ],
        { input: module, encoding: "utf8" },
      ),
    );
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      !raw.every((value): value is string => typeof value === "string")
    )
      throw new Error("Expected an emitted launch argument vector");
    const output = execFileSync(raw[0]!, raw.slice(1), {
      env: { PATH: "/usr/bin:/bin", HOME: root },
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({
      argv: ["--no-sandbox", "--title=sample"],
      sentinel: "selected",
    });
  },
);

it("exports and drafts between the checkpoints the command names", async () => {
  const capture = await writeCaptureFolder(seedEndCapture(), undefined, [
    EDITED_NOTE,
  ]);
  const ends = ["--seed-checkpoint", "seed", "--end-checkpoint", "end"];
  const bundle = join(await createTestTempDirectory("desktop-cli-"), "bundle");

  const exported = await serve([
    "export-desktop-application",
    capture,
    bundle,
    ...ends,
    "--json",
  ]);
  const drafted = await serve([
    "describe-desktop-application-task",
    capture,
    ...ends,
    "--json",
  ]);
  const refused = await serve([
    "describe-desktop-application-task",
    capture,
    "--end-checkpoint",
    "saved",
    "--json",
  ]);

  expect(
    parseEvidence(JSON.parse(exported.stdout)).normalized_result,
  ).toMatchObject({
    checkpoints: { seed: "seed", end: "end" },
    seed_files: [".config/notes/settings.ini", "Documents/today.txt"],
  });
  expect(
    parseEvidence(JSON.parse(drafted.stdout)).normalized_result,
  ).toMatchObject({ checkpoints: { baseline: "seed", final: "end" } });
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "describe_desktop_application_task",
      issues: [{ path: ["end_checkpoint"], reason: "invalid_value" }],
    },
  });
});

it("installs the packages each --extra-package names beside the app, and refuses a name that is not a package's", async () => {
  const capture = await writeCaptureFolder(seedEndCapture(), undefined, [
    EDITED_NOTE,
  ]);
  const root = await createTestTempDirectory("desktop-cli-");
  const extra = (bundle: string, ...names: string[]) =>
    serve([
      "export-desktop-application",
      capture,
      join(root, bundle),
      ...names.flatMap((name) => ["--extra-package", name]),
      "--json",
    ]);

  const exported = parseEvidence(
    JSON.parse(
      (await extra("bundle", "librsvg2-common", "openjdk-17-jre")).stdout,
    ),
  );
  const refused = await extra("refused", "librsvg2-common", "Java 17");

  expect(exported.parameters).toMatchObject({
    extra_packages: ["librsvg2-common", "openjdk-17-jre"],
  });
  expect(
    await readFile(join(root, "bundle/envs/notes/notes_app.py"), "utf8"),
  ).toContain(
    'packages=Packages(apt=["notes", "librsvg2-common", "openjdk-17-jre"])',
  );
  const named = (text: string) =>
    text.includes("librsvg2-common") && text.includes("openjdk-17-jre");
  expect(exported.limitations.filter(named)).toHaveLength(1);
  expect(named(await readFile(join(root, "bundle/README.md"), "utf8"))).toBe(
    true,
  );
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["extra_package"] }] },
  });
});

it("names a dconf database that changed by the seed but could not be read, so the seed holds none of its settings", async () => {
  // As GnuCash's "Show tips at startup", unticked before seed in a computer without dconf-cli.
  const database = `${HOME}/.config/dconf/user`;
  const tips = "GVariant show-tips=false";
  const recorded = seedEndCapture();
  const [baseline, seed, ...later] = recorded.state.checkpoints;
  if (baseline === undefined || seed === undefined)
    throw new Error("the fixture has a seed checkpoint");
  const capture = await writeCaptureFolder(
    {
      ...recorded,
      state: {
        ...recorded.state,
        checkpoints: [
          baseline,
          {
            ...seed,
            changes: [...seed.changes, change(database, { after: tips })],
            retained: [...seed.retained, retained(database, tips)],
          },
          ...later,
        ],
      },
    },
    undefined,
    [EDITED_NOTE, tips],
  );
  const root = await createTestTempDirectory("desktop-cli-");
  const exportAt = async (bundle: string, seedCheckpoint: string) =>
    parseEvidence(
      JSON.parse(
        (
          await serve(
            [
              "export-desktop-application",
              capture,
              join(root, bundle),
              "--seed-checkpoint",
              seedCheckpoint,
              "--end-checkpoint",
              "end",
              "--json",
            ],
            { REA_DCONF_COMMAND: join(root, "no-dconf") },
          )
        ).stdout,
      ),
    ).limitations.filter((line) => line.includes("~/.config/dconf/user"));

  const unread = await exportAt("bundle", "seed");
  // At baseline the database did not exist yet, so nothing was lost.
  const before = await exportAt("baseline", "baseline");

  expect(unread).toEqual([
    expect.stringContaining(
      "changed by the seed checkpoint but could not be read",
    ),
  ]);
  if (await hasReadableProcDescriptor())
    expect(unread[0]).toContain("dconf is not installed (dconf-cli)");
  else {
    expect(unread[0]).toContain(
      "Export on Linux with readable /proc file descriptors",
    );
    expect(unread[0]).not.toContain("where dconf-cli is installed");
  }
  expect(
    await readFile(join(root, "bundle/envs/notes/notes_app.py"), "utf8"),
  ).toContain('DCONF = ""');
  expect(before).toEqual([]);
});

it.each([
  [["--exclude", ""], "exclude"],
  [["--state-path", ""], "statePath"],
  [["--output", ""], "output"],
])(
  "refuses an empty path selection %j before it can name the current directory",
  async (option, field) => {
    const result = await serve([
      "capture-desktop-application",
      "--executable",
      "notes",
      "--output",
      "capture",
      ...option,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        expect.objectContaining({ path: expect.stringContaining(field) }),
      ],
    });
  },
);

it.each([
  { label: "omitted", policy: undefined },
  { label: "empty", policy: {} },
  { label: "selected", policy: { text_lines: 2 } },
])(
  "preserves %s desktop view policy separately from the effective policy",
  async ({ policy }) => {
    const folder = await writeCaptureFolder(seedEndCapture(), undefined, [
      EDITED_NOTE,
    ]);
    const selected =
      policy === undefined ? [] : ["--view-policy", JSON.stringify(policy)];
    for (const command of [
      "inspect-desktop-application-state",
      "describe-desktop-application-task",
    ]) {
      const observed = await serve([command, folder, ...selected, "--json"]);
      const evidence = parseEvidence(JSON.parse(observed.stdout));
      if (policy === undefined)
        expect(evidence.parameters).not.toHaveProperty("view_policy");
      else expect(evidence.parameters.view_policy).toEqual(policy);
      expect(evidence.normalized_result).toMatchObject({
        effective_view_policy: {
          text_lines: policy?.text_lines ?? 5000,
          file_bytes: 67108864,
        },
      });
    }
  },
);

it("recovers a selected captured view and exports the same policy into the Python reader", async () => {
  const path = `${HOME}/Documents/budget.txt`;
  const text = "one\ntwo\nthree";
  const local = capture();
  const first = local.state.checkpoints[0];
  if (first === undefined) throw new Error("missing fixture checkpoint");
  const folder = await writeCaptureFolder(
    {
      ...local,
      state: {
        ...local.state,
        checkpoints: [
          { ...first, retained: [...first.retained, retained(path, text)] },
          ...local.state.checkpoints.slice(1),
        ],
      },
    },
    undefined,
    [text],
  );
  const inspect = async (lines: number) => {
    const response = await serve([
      "inspect-desktop-application-state",
      folder,
      "--state-path",
      path,
      "--view-policy",
      JSON.stringify({ text_lines: lines }),
      "--json",
    ]);
    expect(response.exitCode).toBe(0);
    return parseEvidence(JSON.parse(response.stdout));
  };
  const limited = await inspect(2);
  const recovered = await inspect(3);
  expect(limited.normalized_result).toMatchObject({
    paths: [
      {
        path,
        versions: [{ view: { lines: ["one", "two"], truncated: true } }],
      },
    ],
  });
  expect(recovered.normalized_result).toMatchObject({
    paths: [
      {
        path,
        versions: [
          {
            checkpoint_index: 0,
            sha256: retained(path, text).sha256,
            view: { lines: ["one", "two", "three"], truncated: false },
          },
        ],
      },
    ],
  });
  const root = await createTestTempDirectory("desktop-view-policy-");
  const bundle = join(root, "bundle");
  const exported = await serve([
    "export-desktop-application",
    folder,
    bundle,
    "--view-policy",
    '{"text_lines":3}',
    "--json",
  ]);
  expect(exported.exitCode).toBe(0);
  const module = await readFile(
    join(bundle, "envs/notes/notes_app.py"),
    "utf8",
  );
  const helpers = module
    .split("@computer_app(")[0]
    ?.split("\n")
    .filter((line) => !line.includes("from agentenv_protocol"))
    .join("\n");
  const script = join(root, "reader.py");
  await writeFile(
    script,
    `${helpers}\nprint(json.dumps(_text_view("notes.txt", "one\\ntwo\\nthree", 13)["view"]))\n`,
  );
  const actual = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", script],
      { encoding: "utf8" },
    ),
  );
  expect(actual).toEqual({
    lines: ["one", "two", "three"],
    line_count: 3,
    truncated: false,
  });
  const invalid = await serve([
    "inspect-desktop-application-state",
    folder,
    "--view-policy",
    '{"text_lines":0}',
    "--json",
  ]);
  expect(invalid.exitCode).toBe(1);
});
