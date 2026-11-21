import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createDebPackageService } from "../../../src/composition/debPackage.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  DEFAULT_CONTROL_TEXT,
  debPackageFixture,
  notArBytes,
} from "../../../src/deb/DebPackage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports non-file and malformed Debian package selections as caller input errors", async () => {
  const root = await createTestTempDirectory("rea-deb-files-");
  const path = join(root, "hello.deb");
  const alias = join(root, "alias.deb");
  const malformed = join(root, "malformed.deb");
  await writeFile(path, debPackageFixture());
  await writeFile(malformed, notArBytes());
  await symlink(path, alias);
  const service = createDebPackageService();
  for (const [candidate, reason] of [
    [root, "invalid_format"],
    [alias, "invalid_format"],
    [malformed, "invalid_format"],
    [join(root, "missing.deb"), "invalid_value"],
    [join(path, "child.deb"), "invalid_value"],
  ] as const) {
    const result = await service.inspect({ path: candidate });
    if (result.ok) throw new Error("Expected file acquisition failure");
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      operation: "inspect_deb_package",
      issues: [
        {
          path: ["path"],
          reason,
          message: expect.any(String),
        },
      ],
    });
  }
});

it("returns typed resource and cancellation failures", async () => {
  const root = await createTestTempDirectory("rea-deb-budget-");
  const path = join(root, "hello.deb");
  const bytes = debPackageFixture();
  await writeFile(path, bytes);
  const service = createDebPackageService();
  const tooSmall = await service.inspect({ path, max_file_bytes: 16 });
  if (tooSmall.ok) throw new Error("Expected resource budget failure");
  expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
  const oversize = await service.inspect({ path, max_data_entries: 1 });
  if (oversize.ok) throw new Error("Expected data-entry budget failure");
  expect(oversize.error._tag).toBe("AnalysisResourceConstraintError");
  expect(projectAnalysisError(oversize.error)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    remediation: {
      action: expect.stringContaining("max_data_entries (--max-data-entries)"),
    },
  });
  const cancelled = await service.inspect(
    { path },
    { signal: AbortSignal.abort() },
  );
  if (cancelled.ok) throw new Error("Expected cancellation");
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
});

it("reports a fixed reader allowance as a limit with the partial report", async () => {
  const root = await createTestTempDirectory("rea-deb-allowance-");
  const path = join(root, "wide.deb");
  await writeFile(
    path,
    debPackageFixture({
      controlText: `${DEFAULT_CONTROL_TEXT}Depends: ${Array(65_537).fill("a").join("|")}\n`,
    }),
  );
  const result = await createDebPackageService().inspect({ path });
  if (result.ok) throw new Error("Expected relationship allowance failure");
  expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
  });
  expect(result.error).toMatchObject({
    reportedLimits: { boundary: "relationship_alternatives", maximum: 65_536 },
    recovery: {
      fixedAllowance: {
        name: "The control relationship alternatives allowance",
        kind: "parser",
        limit: 65_536,
      },
    },
    diagnostics: { partial: { ar: { format_version: "2.0" } } },
  });
});
