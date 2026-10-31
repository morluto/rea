import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPriResourcesService } from "../../../src/composition/binaryDiagnostics.js";
import { jsonParts } from "../../../src/domain/jsonSerialization.js";
import { priFixture } from "../../../src/native/pri/PriResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const expectInputFailure = async (
  path: string,
  reason: "invalid_format" | "invalid_value",
) => {
  const result = await createPriResourcesService().inspect({ path });
  if (result.ok) throw new Error("Expected file acquisition failure");
  expect(result.error).toMatchObject({
    _tag: "AnalysisInputError",
    operation: "inspect_pri_resources",
    issues: [{ path: ["path"], reason, message: expect.any(String) }],
  });
};

const serializedBytes = (value: unknown): number => {
  let bytes = 0;
  for (const part of jsonParts(value)) bytes += Buffer.byteLength(part);
  return bytes;
};

describe("PRI resource index stable filesystem boundary", () => {
  it("reports non-file, missing and malformed selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-pri-resource-files-");
    const path = join(root, "resources.pri");
    const malformed = join(root, "malformed.pri");
    await writeFile(path, priFixture().bytes);
    await writeFile(
      malformed,
      Buffer.from("mrm_pri2 but not a resource index"),
    );
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.pri"), "invalid_value"],
      [join(path, "child.pri"), "invalid_value"],
    ] as const)
      await expectInputFailure(candidate, reason);
  });

  // Creating symbolic links needs an elevated or developer-mode Windows session.
  it.skipIf(process.platform === "win32")(
    "rejects a symbolic link instead of following it",
    async () => {
      const root = await createTestTempDirectory("rea-pri-resource-link-");
      const path = join(root, "resources.pri");
      const alias = join(root, "alias.pri");
      await writeFile(path, priFixture().bytes);
      await symlink(path, alias);
      await expectInputFailure(alias, "invalid_format");
    },
  );

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-pri-resource-budget-");
    const path = join(root, "resources.pri");
    await writeFile(path, priFixture().bytes);
    const service = createPriResourcesService();
    const limited = await service.inspect({ path, max_file_bytes: 48 });
    if (limited.ok) throw new Error("Expected the file budget to apply");
    expect(limited.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });

  it("admits a stock-scale index by default and keeps every page bounded", async () => {
    // Windows 11 25H2's Windows.UI.SettingsAppThreshold.pri names 13,922
    // items; its stock language PRIs carry up to 112 Language qualifiers.
    const languages = Array.from(
      { length: 112 },
      (_unused, index) => `x${String(index).padStart(3, "0")}-XX`,
    );
    const resources = Array.from({ length: 14_000 }, (_unused, index) => ({
      name: `Resources/Settings/Item${String(index).padStart(5, "0")}`,
      candidates: (index < 40 ? languages : languages.slice(0, 2)).map(
        (value) => ({
          qualifiers: [{ name: "Language" as const, value }],
          type: "AsciiString" as const,
          value: `Setting ${String(index)} (${value})`,
        }),
      ),
    }));
    const root = await createTestTempDirectory("rea-pri-resource-scale-");
    const path = join(root, "resources.pri");
    await writeFile(path, priFixture({ resources }).bytes);
    const service = createPriResourcesService();
    const items = await service.inspect({ path });
    if (!items.ok) throw items.error;
    expect(items.value.normalized_result).toMatchObject({
      coverage: { status: "complete", items: 14_000, candidates: 32_400 },
      page: { collection: "items", total: 14_000, returned: 100 },
    });
    expect(serializedBytes(items.value)).toBeLessThan(64 * 1024);
    const page = await service.inspect({
      path,
      collection: "candidates",
      limit: 1000,
    });
    if (!page.ok) throw page.error;
    expect(page.value.normalized_result).toMatchObject({
      page: { total: 32_400, returned: 1000, next_offset: 1000 },
    });
    expect(serializedBytes(page.value)).toBeLessThan(1024 * 1024);
    const english = await service.inspect({
      path,
      collection: "candidates",
      query: "item00007",
      qualifiers: [{ name: "Language", value: "X001-xx" }],
    });
    if (!english.ok) throw english.error;
    expect(english.value.normalized_result).toMatchObject({
      page: {
        total: 1,
        candidates: [{ value: { text: "Setting 7 (x001-XX)" } }],
      },
    });
  });
});
