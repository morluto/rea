import {
  chmod,
  rm,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../../src/resources/ArtifactResourceScope.js";
import {
  copyExistingGhidraProject,
  fingerprintGhidraProject,
  resolveGhidraProject,
} from "../../../../src/ghidra/GhidraProjectSnapshot.js";
import { parseConfig } from "../../../../src/config/parseConfig.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

let resources: ArtifactResourceScope;
const GHIDRA_PROJECT_PROFILE_MISMATCH =
  "Selected Ghidra project content no longer matches the profile committed by open_binary; when it changed is not established";
beforeEach(() => {
  resources = new ArtifactResourceScope();
});
afterEach(async () => {
  await resources.close();
});
const fixture = async ({ sharedParent = false } = {}) => {
  const root = await createTestTempDirectory("rea-ghidra-selected-project-");
  const source = join(root, "source");
  const destination = join(sharedParent ? source : root, "runtime", "project");
  await mkdir(join(source, "selected.rep"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(source, "selected.gpr"), "marker");
  await writeFile(join(source, "selected.rep", "data"), "original program");
  return { source, destination };
};

it("rejects a copy whose last block differs from the committed project", async () => {
  const { source, destination } = await fixture();
  const data = join(source, "selected.rep", "data");
  const contents = Buffer.alloc(256 * 1024 + 1, 0x61);
  await writeFile(data, contents);
  const original = await fingerprintGhidraProject(
    source,
    "selected",
    resources,
  );
  contents[contents.length - 1] = 0x62;
  await writeFile(data, contents);
  expect(
    await fingerprintGhidraProject(source, "selected", resources),
  ).not.toBe(original);
  await expect(
    copyExistingGhidraProject(source, destination, {
      projectName: "selected",
      expectedSha256: original,
      resources,
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisArtifactChangedError",
    operation: "open_binary",
    path: source,
    reason: GHIDRA_PROJECT_PROFILE_MISMATCH,
  });
});

it("parses an opt-in project once for shared CLI/MCP configuration and rejects import overrides", () => {
  const environment = {
    REA_GHIDRA_PROJECT_PATH: join(process.cwd(), "existing.gpr"),
    REA_GHIDRA_PROGRAM_NAME: "program.elf",
    REA_GHIDRA_DISABLED_ANALYZERS: ", ,",
  };
  expect(parseConfig(environment)).toMatchObject({
    ok: true,
    value: {
      ghidraExistingProject: {
        path: environment.REA_GHIDRA_PROJECT_PATH,
        programName: "program.elf",
      },
    },
  });
  for (const extra of [
    { REA_GHIDRA_DISABLED_ANALYZERS: "Decompiler Parameter ID" },
    { REA_GHIDRA_LANGUAGE_ID: "x86:LE:64:default" },
    { REA_GHIDRA_SEED_FILE: join(process.cwd(), "seeds") },
    { REA_GHIDRA_PROGRAM_NAME: "*" },
  ])
    expect(parseConfig({ ...environment, ...extra }).ok).toBe(false);
  expect(parseConfig({ REA_GHIDRA_PROGRAM_NAME: "program.elf" }).ok).toBe(
    false,
  );
});

it("reports an invalid derived program name at its selection boundary", async () => {
  const { source } = await fixture();
  await expect(
    resolveGhidraProject(
      { path: join(source, "selected.gpr") },
      { path: "/tmp/*" },
      resources,
    ),
  ).rejects.toMatchObject({
    _tag: "ConfigurationError",
    settings: [{ setting: "REA_GHIDRA_PROGRAM_NAME" }],
  });
});

it("derives a bundle program from the resolved executable while preserving explicit names", async () => {
  const { source } = await fixture();
  const target = {
    path: join(source, "Demo.app", "Contents", "MacOS", "ActualExecutable"),
    sourcePath: join(source, "Demo.app"),
  };
  const selection = { path: join(source, "selected.gpr") };
  expect(
    (await resolveGhidraProject(selection, target, resources)).program_name,
  ).toBe("ActualExecutable");
  expect(
    (
      await resolveGhidraProject(
        { ...selection, programName: "CallerSelected" },
        target,
        resources,
      )
    ).program_name,
  ).toBe("CallerSelected");
});

it.each([null, "caller stopped", { kind: "stop-project-read" }])(
  "preserves project cancellation and its exact reason: %j",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      resolveGhidraProject(
        { path: join(process.cwd(), "absent.gpr") },
        { path: "/tmp/target" },
        resources,
        controller.signal,
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a selected marker with a non-directory traversal before canonicalizing its parent",
  async () => {
    const root = await createTestTempDirectory("rea-ghidra-project-traversal-");
    await writeFile(join(root, "file"), "not a directory");
    await writeFile(join(root, "project.gpr"), "marker");
    await mkdir(join(root, "project.rep"));
    const path = `${root}/file/../project.gpr`;
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(
      resolveGhidraProject({ path }, { path: join(root, "target") }, resources),
    ).rejects.toMatchObject({ diagnostics: { system_code: "ENOTDIR" } });
  },
);

it("reports a missing project marker as an invalid REA_GHIDRA_PROJECT_PATH selection", async () => {
  const root = await createTestTempDirectory("rea-ghidra-project-missing-");
  await expect(
    resolveGhidraProject(
      { path: join(root, "missing", "app.gpr") },
      { path: join(root, "target") },
      resources,
    ),
  ).rejects.toMatchObject({
    _tag: "ConfigurationError",
    settings: [{ setting: "REA_GHIDRA_PROJECT_PATH" }],
    diagnostics: { system_code: "ENOENT" },
  });
});

it.skipIf(process.platform === "win32")(
  "follows native parent symlinks and preserves missing marker failures",
  async () => {
    const root = await createTestTempDirectory("rea-ghidra-project-selection-");
    await mkdir(join(root, "actual", "nested"), { recursive: true });
    await symlink("actual/nested", join(root, "link"));
    await writeFile(join(root, "actual", "project.gpr"), "marker");
    await mkdir(join(root, "actual", "project.rep"));
    const path = `${root}/link/../project.gpr`;
    const commitment = await resolveGhidraProject(
      { path },
      { path: join(root, "target") },
      resources,
    );
    expect(commitment).toMatchObject({
      configured_path: path,
      project_path: await realpath(join(root, "actual")),
      project_name: "project",
    });
    await writeFile(join(root, "missing.gpr"), "sibling decoy");
    await mkdir(join(root, "missing.rep"));
    await expect(
      resolveGhidraProject(
        { path: `${root}/link/../missing.gpr` },
        { path: join(root, "target") },
        resources,
      ),
    ).rejects.toMatchObject({ diagnostics: { system_code: "ENOENT" } });
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "preserves denied access between profile resolution and snapshot copying",
  async () => {
    const { source, destination } = await fixture();
    const project = await resolveGhidraProject(
      { path: join(source, "selected.gpr") },
      { path: "/tmp/target" },
      resources,
    );
    try {
      await chmod(source, 0);
      await expect(
        copyExistingGhidraProject(project.project_path, destination, {
          projectName: project.project_name,
          expectedSha256: project.sha256,
          resources,
        }),
      ).rejects.toMatchObject({
        _tag: "AnalysisAccessDeniedError",
        operation: "open_binary",
        systemCode: "EACCES",
        path: join(project.project_path, "selected.gpr"),
      });
    } finally {
      await chmod(source, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps missing entries and symbolic links classified as invalid selections",
  async () => {
    const { source, destination } = await fixture();
    const expectedSha256 = await fingerprintGhidraProject(
      source,
      "selected",
      resources,
    );
    const selection = { projectName: "selected", expectedSha256, resources };
    await rm(join(source, "selected.gpr"));
    await expect(
      copyExistingGhidraProject(source, destination, selection),
    ).rejects.toMatchObject({ _tag: "ConfigurationError" });
    expect(await readdir(destination)).toEqual([]);
    await writeFile(join(source, "other.gpr"), "marker");
    await symlink("other.gpr", join(source, "selected.gpr"));
    await expect(
      copyExistingGhidraProject(source, destination, selection),
    ).rejects.toMatchObject({ _tag: "ConfigurationError" });
    expect(await readdir(destination)).toEqual([]);
  },
);

it("copies only the committed project with exact multi-chunk, empty and private files", async () => {
  const { source, destination } = await fixture({ sharedParent: true });
  const unrelated = join(source, "unrelated.gpr");
  if (process.platform === "win32")
    await writeFile(unrelated, "unrelated marker");
  else await symlink("unrelated-missing-project", unrelated);
  const large = Buffer.alloc(256 * 1024 + 17, 0x41);
  large[0] = 0x5a;
  large[256 * 1024] = 0x7e;
  await writeFile(join(source, "selected.rep", "data"), large);
  await writeFile(join(source, "selected.rep", "empty"), Buffer.alloc(0));

  const commitment = await resolveGhidraProject(
    { path: join(source, "selected.gpr"), programName: "target.elf" },
    { path: "/tmp/target.elf" },
    resources,
  );
  await copyExistingGhidraProject(source, destination, {
    projectName: "selected",
    expectedSha256: commitment.sha256,
    resources,
  });

  expect((await readdir(destination)).sort()).toEqual([
    "selected.gpr",
    "selected.rep",
  ]);
  expect(await readFile(join(destination, "selected.gpr"), "utf8")).toBe(
    "marker",
  );
  expect(
    (await readFile(join(source, "selected.rep", "data"))).equals(large),
  ).toBe(true);
  if (process.platform === "win32")
    expect(await readFile(unrelated, "utf8")).toBe("unrelated marker");
  else expect(await readlink(unrelated)).toBe("unrelated-missing-project");
  expect(
    (await readFile(join(destination, "selected.rep", "data"))).equals(large),
  ).toBe(true);
  expect(
    await readFile(join(destination, "selected.rep", "empty")),
  ).toHaveLength(0);
  expect(
    await fingerprintGhidraProject(destination, "selected", resources),
  ).toBe(commitment.sha256);
  if (process.platform !== "win32") {
    expect(
      (await stat(join(destination, "selected.rep", "data"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(destination, "selected.rep", "empty"))).mode & 0o777,
    ).toBe(0o600);
    expect((await stat(join(destination, "selected.rep"))).mode & 0o777).toBe(
      0o700,
    );
  }
});

it.each([null, "stop-copy"])(
  "preserves copy cancellation reason %j without leaving partial verification",
  async (reason) => {
    const { source, destination } = await fixture();
    const commitment = await resolveGhidraProject(
      { path: join(source, "selected.gpr"), programName: "target.elf" },
      { path: "/tmp/target.elf" },
      resources,
    );
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      copyExistingGhidraProject(source, destination, {
        projectName: "selected",
        expectedSha256: commitment.sha256,
        resources,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });
    expect(await readdir(destination)).toEqual([]);
  },
);
