import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";

const analyzeFailure = async (input: Record<string, unknown>) => {
  const result = await analyzeJavaScriptApplication(input);
  if (result.ok) throw new Error("Expected the selection to be refused");
  return projectAnalysisError(result.error);
};

const application = async () => {
  const root = await createTestTempDirectory("rea-javascript-selection-");
  const directory = join(root, "app");
  await mkdir(directory);
  await writeFile(join(directory, "index.js"), "module.exports = 1;\n");
  return { root, directory };
};

const registerSelectedPathResolutionTests = (): void => {
  it("preserves the selected path and host reason for an overlong name", async () => {
    const { root } = await application();
    const longPath = join(root, "x".repeat(300));

    expect(await analyzeFailure({ input_path: longPath })).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["input_path"],
            reason: "invalid_value",
            message: expect.stringContaining(
              `Selected input path exceeds the host path or component length limit (ENAMETOOLONG): ${longPath}`,
            ),
          },
        ],
      },
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves the selected path when symlink traversal loops or exceeds the host limit",
    async () => {
      const { root } = await application();
      const loopPath = join(root, "loop-a");
      await symlink("loop-b", loopPath);
      await symlink("loop-a", join(root, "loop-b"));
      await writeFile(join(root, "chain-end"), "");
      let target = "chain-end";
      for (let index = 59; index >= 0; index -= 1) {
        const name = `chain-${String(index)}`;
        await symlink(target, join(root, name));
        target = name;
      }
      const chainPath = join(root, "chain-0");

      const loopError = await analyzeFailure({ input_path: loopPath });
      const chainError = await analyzeFailure({ input_path: chainPath });
      const eloopMessage = (path: string) =>
        `Selected input path could not be resolved because symbolic-link traversal looped or exceeded the host limit (ELOOP): ${path}`;
      expect(loopError).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["input_path"],
              reason: "invalid_value",
              message: expect.stringContaining(eloopMessage(loopPath)),
            },
          ],
        },
      });
      expect(chainError).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["input_path"],
              reason: "invalid_value",
              message: expect.stringContaining(eloopMessage(chainPath)),
            },
          ],
        },
      });
      expect(loopError).not.toEqual(chainError);
    },
  );
};

describe("JavaScript application input selection", () => {
  registerSelectedPathResolutionTests();

  it("reports a missing input path as invalid input, not an artifact read failure", async () => {
    const { root } = await application();
    const missing = join(root, "missing");

    expect(await analyzeFailure({ input_path: missing })).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          {
            path: ["input_path"],
            reason: "invalid_value",
            message: expect.stringContaining(missing),
          },
        ],
      },
    });
  });

  it("reports a file that is neither a directory nor an .asar as an unsupported target", async () => {
    const { root } = await application();
    const binary = join(root, "program");
    await writeFile(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));

    expect(await analyzeFailure({ input_path: binary })).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      remediation: { action: expect.stringContaining(".asar") },
      details: {
        operation: "analyze_javascript_application",
        path: binary,
      },
    });
  });

  it("refuses a directory whose complete inventory has no JavaScript application inputs", async () => {
    const { root } = await application();
    const build = join(root, "build");
    await mkdir(join(build, "CMakeFiles"), { recursive: true });
    await writeFile(join(build, "tool.exe"), pe(0x8664));
    await writeFile(join(build, "runtime.dll"), pe(0x8664, 64, 0x2002));
    await writeFile(join(build, "ctest.json"), '{"tests":[]}');
    await writeFile(join(build, "CMakeFiles", "cache.txt"), "x\n");

    const projected = await analyzeFailure({ input_path: build });
    expect(projected).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "analyze_javascript_application",
        related_operations: [
          "inspect_desktop_application",
          "audit_release_exposure",
          "inspect_artifact",
          "open_binary",
        ],
        diagnostics: {
          inventoried_entries: 4,
          entries_by_format: { file: 2, pe: 2 },
          json_files: 1,
          native_addon_files: 0,
        },
      },
    });
    expect(projected.remediation.action).toContain("entries_by_format");
    expect(JSON.stringify(projected)).not.toContain("tool.exe");
  });

  it("analyzes an empty directory with an explicit no-input limitation", async () => {
    const { root } = await application();
    const empty = join(root, "empty");
    await mkdir(join(empty, "nested"), { recursive: true });

    const result = await analyzeJavaScriptApplication({ input_path: empty });
    if (!result.ok) throw result.error;
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("No JavaScript inputs were found"),
    );
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("inspect_desktop_application"),
    );
  });

  it.each([
    ["an HTML page", "index.html", "<!doctype html><p>x</p>\n"],
    ["a package manifest", "package.json", '{"name":"app"}'],
    ["a source map", "app.js.map", '{"version":3,"sources":[],"mappings":""}'],
  ])(
    "analyzes a directory whose only application input is %s",
    async (_label, name, text) => {
      const { root } = await application();
      const directory = join(root, "only");
      await mkdir(directory);
      await writeFile(join(directory, name), text);
      await writeFile(join(directory, "data.json"), "{}");
      expect(
        (await analyzeJavaScriptApplication({ input_path: directory })).ok,
      ).toBe(true);
    },
  );

  it.each([
    ["a directory", "directory", "asar"],
    ["an .asar file", "asar", "directory"],
  ] as const)(
    "reports %s selected with a contradicting format as an invalid request",
    async (_label, observed, format) => {
      const { root, directory } = await application();
      const selected =
        observed === "directory" ? directory : join(root, "app.asar");
      if (observed === "asar") await writeFile(selected, "not inspected");

      expect(
        await analyzeFailure({ input_path: selected, format }),
      ).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["format"],
              reason: "invalid_value",
              expected: ["auto", observed],
            },
          ],
        },
      });
    },
  );

  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each([0o000, 0o400])(
    "reports denied selected-directory read/search access as a host denial (mode %s)",
    async (mode) => {
      const { directory } = await application();
      expect(
        (await analyzeJavaScriptApplication({ input_path: directory })).ok,
      ).toBe(true);
      await chmod(directory, mode);
      try {
        expect(await analyzeFailure({ input_path: directory })).toMatchObject({
          code: "access_denied",
          category: "unavailable",
          details: {
            path: directory,
            system_code: "EACCES",
            boundary: "filesystem-read",
          },
        });
      } finally {
        await chmod(directory, 0o700);
      }
      expect(
        (await analyzeJavaScriptApplication({ input_path: directory })).ok,
      ).toBe(true);
    },
  );
});
