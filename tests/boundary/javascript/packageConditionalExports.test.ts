import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  resolveArtifactPathByContext,
  type ArtifactPathResolution,
} from "../../../src/application/javascript/JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "../../../src/application/javascript/JavaScriptArtifactFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
const execute = promisify(execFile);
const TARGETS = [
  "default.cjs",
  "specific.cjs",
  "node.cjs",
  "require.cjs",
  "array.cjs",
  "nested.cjs",
];
const nodeExportOutcomeSchema = z.strictObject({
  target: z.string().nullable(),
  error_code: z.string().nullable(),
});

/** Resolve through the real Node resolver, retaining its refusal reason. */
const nodeTarget = async (cwd: string, moduleKind: "import" | "require") => {
  const expression =
    moduleKind === "import"
      ? '(await import("example")).default'
      : 'createRequire(import.meta.url)("example")';
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { createRequire } from "node:module";
      try {
        console.log(JSON.stringify({target: ${expression}, error_code: null}));
      } catch (error) {
        console.log(JSON.stringify({target: null, error_code: error.code}));
      }
    `,
    ],
    { cwd },
  );
  return nodeExportOutcomeSchema.parse(JSON.parse(stdout));
};
/**
 * Install one real package on disk and mirror it into an artifact inventory,
 * so Node and REA observe the same container, then resolve through both.
 */
const compareWithNode = async (
  exportsMap: unknown,
  moduleKind: "import" | "require",
  present: readonly string[] = TARGETS,
): Promise<{
  readonly node: string | null;
  readonly node_error: string | null;
  readonly outcome: ArtifactPathResolution;
}> => {
  const root = await createTestTempDirectory("rea-exports-");
  const packageDirectory = join(root, "node_modules", "example");
  await mkdir(packageDirectory, { recursive: true });
  const metadata = JSON.stringify({ name: "example", exports: exportsMap });
  await writeFile(join(packageDirectory, "package.json"), metadata);
  const contents = new Map<string, string>([
    ["main.js", ""],
    ["node_modules/example/package.json", metadata],
  ]);
  for (const target of present) {
    const source = `module.exports = ${JSON.stringify(target)};`;
    await writeFile(join(packageDirectory, target), source);
    contents.set(`node_modules/example/${target}`, source);
  }
  const files = new Map<string, JavaScriptArtifactFile>(
    [...contents].map(([path, value]) => [
      path,
      {
        path,
        container_sha256: "a".repeat(64),
        sha256: "b".repeat(64),
        bytes: Buffer.byteLength(value),
        inventory_artifact_id: path,
        kind: path.endsWith("package.json") ? "package-json" : "javascript",
        unpacked: false,
        text: { included: true, value },
      },
    ]),
  );
  const node = await nodeTarget(root, moduleKind);
  return {
    node: node.target,
    node_error: node.error_code,
    outcome: resolveArtifactPathByContext({
      declaredPath: "example",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind,
      files,
    }),
  };
};
const resolvedLeaf = (outcome: ArtifactPathResolution): string | null =>
  outcome.resolved_path?.split("/").pop() ?? null;
/** Pin the real Node result, then require REA to select the same target. */
const expectNodeAgreement = async (
  exportsMap: unknown,
  expected: string | null,
  moduleKind: "import" | "require" = "import",
  present: readonly string[] = TARGETS,
): Promise<ArtifactPathResolution> => {
  const { node, outcome } = await compareWithNode(
    exportsMap,
    moduleKind,
    present,
  );
  expect(node).toBe(expected);
  expect(resolvedLeaf(outcome)).toBe(expected);
  return outcome;
};
describe("ordered package exports conditions", () => {
  it.each(["import", "require"] as const)(
    "matches Node when default precedes %s",
    async (moduleKind) => {
      await expectNodeAgreement(
        { default: "./default.cjs", [moduleKind]: "./specific.cjs" },
        "default.cjs",
        moduleKind,
      );
    },
  );
  it.each(["import", "require"] as const)(
    "matches Node when %s precedes default",
    async (moduleKind) => {
      await expectNodeAgreement(
        { [moduleKind]: "./specific.cjs", default: "./default.cjs" },
        "specific.cjs",
        moduleKind,
      );
    },
  );
  it.each(["import", "require"] as const)(
    "matches Node when the node condition precedes %s",
    async (moduleKind) => {
      await expectNodeAgreement(
        { node: "./node.cjs", [moduleKind]: "./specific.cjs" },
        "node.cjs",
        moduleKind,
      );
    },
  );
  it.each(["import", "require"] as const)(
    "matches Node when %s precedes the node condition",
    async (moduleKind) => {
      await expectNodeAgreement(
        { [moduleKind]: "./specific.cjs", node: "./node.cjs" },
        "specific.cjs",
        moduleKind,
      );
    },
  );
  it.each(["import", "require"] as const)(
    "matches Node when node-addons precedes %s",
    async (moduleKind) => {
      await expectNodeAgreement(
        { "node-addons": "./node.cjs", [moduleKind]: "./specific.cjs" },
        "node.cjs",
        moduleKind,
      );
    },
  );
});
describe("nested and array package export targets", () => {
  it.each([
    [
      { import: { node: "./nested.cjs", default: "./default.cjs" } },
      "nested.cjs",
    ],
    [{ import: { default: "./default.cjs" } }, "default.cjs"],
    [
      { import: { browser: "./specific.cjs" }, default: "./default.cjs" },
      "default.cjs",
    ],
    [{ import: [42, "./array.cjs"] }, "array.cjs"],
    [{ import: ["./specific.cjs", 42] }, "specific.cjs"],
    [{ import: ["../outside.cjs", "./array.cjs"] }, "array.cjs"],
    [{ import: { node: { default: "./default.cjs" } } }, "default.cjs"],
    [{ import: [{ node: "./nested.cjs" }, "./array.cjs"] }, "nested.cjs"],
    [{ import: [{ browser: "./x.cjs" }, "./array.cjs"] }, "array.cjs"],
    [{ import: [null, "./array.cjs"] }, "array.cjs"],
    [{ import: ["./specific.cjs", "./array.cjs"] }, "specific.cjs"],
  ] as const)(
    "selects the same target as Node for %j",
    async (exportsMap, expected) => {
      await expectNodeAgreement(exportsMap, expected);
    },
  );
  it.each([
    [{ import: { browser: "./x.cjs" } }, "external"],
    [{ import: { node: null, default: "./default.cjs" } }, "external"],
    [{ import: [] }, "external"],
  ] as const)(
    "refuses %j with %s exactly as Node refuses it",
    async (exportsMap, status) => {
      const outcome = await expectNodeAgreement(exportsMap, null);
      expect(outcome.resolution_status).toBe(status);
    },
  );
  it.each([
    [{ import: ["./absent.cjs", "./array.cjs"] }],
    [{ import: [["./absent.cjs"], "./array.cjs"] }],
  ] as const)(
    "reports %j as absent rather than falling through to a later entry",
    async (exportsMap) => {
      const outcome = await expectNodeAgreement(exportsMap, null);
      expect(outcome.resolution_status).toBe("not-found");
    },
  );
});
describe("unmatched package export conditions", () => {
  it.each(["import", "require"] as const)(
    "names the declared conditions for %s",
    async (moduleKind) => {
      const { node, outcome } = await compareWithNode(
        { browser: "./default.cjs" },
        moduleKind,
      );
      expect(node).toBeNull();
      expect(outcome).toMatchObject({
        resolution_status: "external",
        resolved_path: null,
      });
      expect(outcome.limitations[0]).toContain("declares browser");
    },
  );
  it("does not report valid metadata as malformed", async () => {
    const { outcome } = await compareWithNode({ default: 7 }, "import");
    expect(outcome.resolution_status).toBe("unavailable");
    expect(outcome.limitations[0]).toContain("not valid package JSON");
  });
});

describe("package exports fallback refusal reasons", () => {
  it.each([
    [{ import: [42, 7] }, "ERR_INVALID_PACKAGE_TARGET", "unavailable"],
    [{ import: [null, null] }, "ERR_PACKAGE_PATH_NOT_EXPORTED", "external"],
    [{ import: [42, null] }, "ERR_PACKAGE_PATH_NOT_EXPORTED", "external"],
    [{ import: [null, 42] }, "ERR_INVALID_PACKAGE_TARGET", "unavailable"],
    [
      { import: { node: null }, default: "./default.cjs" },
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "external",
    ],
  ] as const)(
    "matches Node refusal for %j",
    async (exportsMap, code, status) => {
      const { node, node_error, outcome } = await compareWithNode(
        exportsMap,
        "import",
      );
      expect(node).toBeNull();
      expect(node_error).toBe(code);
      expect(outcome.resolved_path).toBeNull();
      expect(outcome.resolution_status).toBe(status);
    },
  );
});
