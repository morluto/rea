import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  HEADER_BYTES,
  journalBytes,
} from "../../../src/domain/linux/systemdJournal.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "pages journal object headers past the inline window from inline Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-journal-pages-cli-");
    const journal = join(root, "system.journal");
    const bytes = journalBytes({
      objects: Array.from({ length: 40 }, () => ({ type: 1, size: 32 })),
    });
    await writeFile(journal, bytes);
    const inspected = await cli.run({
      arguments: [
        "inspect-artifact",
        journal,
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const parent = parseEvidence(inspected.json);
    const page = async (offset: number) => {
      const request = join(root, `page-${String(offset)}.json`);
      await writeFile(
        request,
        JSON.stringify({
          source: { kind: "inline", evidence: parent },
          view: {
            kind: "inventory",
            collection: "format_record_headers",
            artifact_path: journal,
            offset,
            limit: 64,
          },
        }),
      );
      return cli.run({
        arguments: ["inspect-analysis-view", request, "--json"],
      });
    };
    const later = await page(32);
    expect(later.exitCode, later.stderr).toBe(0);
    const view = analysisViewResultSchema.parse(
      parseEvidence(later.json).normalized_result,
    );
    if (view.kind !== "inventory")
      throw new Error("Expected an inventory page");
    expect(view.items).toHaveLength(8);
    expect(view.items[0]).toMatchObject({ offset: HEADER_BYTES + 32 * 32 });
    expect(view.coverage).toMatchObject({ total: 40, exhausted: true });

    // A changed file refuses the page instead of returning shifted rows.
    const changed = Buffer.from(bytes);
    changed.writeUInt8(3, HEADER_BYTES + 33 * 32);
    await writeFile(journal, changed);
    const refused = await page(32);
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toMatch(/changed/u);
  },
);
