// Regression tests for the declared public machine-readable output contracts
// (issue #6339), exercised through the compiled CLI with `--json`. They pin
// the same documented shapes as the MCP boundary suite: the canonical
// Evidence document a successful command prints, the error projection a
// failed command prints with a nonzero exit status, and result-embedded
// coverage enums that keep unavailable evidence distinguishable from a
// negative finding. When an expectation here changes because the public
// contract intentionally changed, update this file in the same change and
// explain the contract change; see docs/testing.md
// -> Public output contract regressions.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { elfExportImage } from "../fixtures/binaryDiagnostics/nativeExports.js";
import {
  assertCanonicalEvidenceContract,
  assertErrorProjectionContract,
} from "../fixtures/publicOutputContract.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../support/cli/cliFixture.js";
import { byteEntropySchema } from "../../src/domain/native/byteEntropy.js";
import { nativeExportsSchema } from "../../src/domain/native/nativeExports.js";

cliTest(
  "delivers the documented canonical Evidence document for a byte entropy success",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-output-contract-entropy-");
    const path = join(root, "firmware.bin");
    // Deterministic content: a zero block (entropy 0, low) followed by the
    // full byte range repeated 16 times (entropy 8, high).
    const high = Buffer.alloc(4096);
    for (let index = 0; index < high.length; index += 1)
      high[index] = index % 256;
    await writeFile(path, Buffer.concat([Buffer.alloc(4096), high]));
    const result = await runFileCli(cli, {
      arguments: ["inspect-byte-entropy", path, "--json"],
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
    const evidence = assertCanonicalEvidenceContract(result.json);
    expect(evidence.operation).toBe("inspect_byte_entropy");
    expect(evidence.subject?.digest.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const report = byteEntropySchema.parse(evidence.normalized_result);
    expect(report.runs).toEqual([
      { offset: 0, length: 4096, classification: "low" },
      { offset: 4096, length: 4096, classification: "high" },
    ]);
  },
);

cliTest(
  "keeps unsupported export enumeration apart from an observed empty table",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-output-contract-empty-");
    const emptyTable = join(root, "libempty.so");
    await writeFile(
      emptyTable,
      elfExportImage({ symbols: [], versionDefinitions: [] }),
    );
    const observed = await runFileCli(cli, {
      arguments: ["inspect-native-exports", emptyTable, "--json"],
      cwd: root,
    });
    expect(observed.exitCode).toBe(0);
    const empty = nativeExportsSchema.parse(
      assertCanonicalEvidenceContract(observed.json).normalized_result,
    );
    // Zero exports with complete coverage is an observed negative finding.
    expect(empty.exports).toEqual([]);
    expect(empty.coverage.status).toBe("complete");

    const noSections = join(root, "libnosections.so");
    await writeFile(
      noSections,
      elfExportImage({
        symbols: [{ name: "exported_fn" }],
        sectionHeaders: false,
      }),
    );
    const unavailable = await runFileCli(cli, {
      arguments: ["inspect-native-exports", noSections, "--json"],
      cwd: root,
    });
    expect(unavailable.exitCode).toBe(0);
    const unsupported = nativeExportsSchema.parse(
      assertCanonicalEvidenceContract(unavailable.json).normalized_result,
    );
    // The same zero rows, but coverage marks the table unavailable with a
    // reason; scripts must not read this as "no exports exist".
    expect(unsupported.exports).toEqual([]);
    expect(unsupported.coverage.status).toBe("unsupported");
    expect(typeof unsupported.coverage.reason).toBe("string");
    expect(unsupported.coverage.reason?.length).toBeGreaterThan(0);
  },
);

cliTest(
  "reports invalid and unsupported selections through the documented error contract",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-output-contract-errors-");
    const path = join(root, "small.bin");
    await writeFile(path, Buffer.alloc(512));
    const invalid = await runFileCli(cli, {
      arguments: ["inspect-byte-entropy", path, "--offset", "999999", "--json"],
      cwd: root,
    });
    expect(invalid.exitCode).toBe(1);
    expect((await assertErrorProjectionContract(invalid.json)).code).toBe(
      "invalid_request",
    );

    const machO = join(root, "library.dylib");
    const header = Buffer.alloc(64);
    header.set([0xcf, 0xfa, 0xed, 0xfe], 0);
    await writeFile(machO, header);
    const unsupported = await runFileCli(cli, {
      arguments: ["inspect-native-exports", machO, "--json"],
      cwd: root,
    });
    expect(unsupported.exitCode).toBe(1);
    const projection = await assertErrorProjectionContract(unsupported.json);
    expect(projection.code).toBe("unsupported_target");
    expect(projection.message).toContain("inspect_macho");
  },
);
