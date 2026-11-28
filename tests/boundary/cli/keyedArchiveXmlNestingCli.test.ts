import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { build } from "plist";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { deeplyNestedXmlPlist } from "../../fixtures/keyedArchiveXmlNesting.js";
import { XML_ELEMENT_DEPTH_LIMIT } from "../../../src/domain/xmlDocument.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// The plist envelope and the innermost string sit outside the container chain.
const syntaxLegalDepth = XML_ELEMENT_DEPTH_LIMIT - 2;

for (const [name, xml] of [
  ["dictionaries", deeplyNestedXmlPlist(syntaxLegalDepth)],
  [
    "quoted attributes",
    deeplyNestedXmlPlist(syntaxLegalDepth).replaceAll(
      "<dict>",
      '<dict note="/>">',
    ),
  ],
  [
    "plist wrappers",
    "<plist>".repeat(XML_ELEMENT_DEPTH_LIMIT - 1) +
      "<string>x</string>" +
      "</plist>".repeat(XML_ELEMENT_DEPTH_LIMIT - 1),
  ],
] as const) {
  cliTest(
    `compiled CLI reports deeply nested XML ${name} as the decode limit`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-keyed-cli-depth-");
      const path = join(root, "Deep.plist");
      await writeFile(path, xml);
      const output = await cli.run({
        arguments: ["inspect-keyed-archive", path, "--json"],
        environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
      });
      expect(output.exitCode, output.stderr).toBe(1);
      expect(output.json).toMatchObject({
        code: "partial",
        category: "partial",
        details: {
          reason: "limit",
          truncated: true,
          reported_limits: { boundary: "plist-nesting-depth", maximum: 128 },
          detail: expect.stringMatching(
            /keyed archive.*128 nesting levels.*no runtime override/iu,
          ),
        },
      });
    },
  );
}

cliTest(
  "compiled CLI decodes a shallow archive with opaque DOCTYPE markup",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-keyed-cli-doctype-");
    const path = join(root, "Shallow.plist");
    const archive = build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null", "leaf"],
      $top: { root: { UID: 1 } },
    });
    await writeFile(
      path,
      archive.replace(
        /<!DOCTYPE[^>]*>/u,
        `<!DOCTYPE plist [<!ENTITY first "unused"><!ENTITY second "${"<dict>".repeat(130)}">]>`,
      ),
    );
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    expect(parseEvidence(output.json).normalized_result).toMatchObject({
      archive_format: "xml-plist",
      objects: expect.arrayContaining([
        expect.objectContaining({ value: "leaf" }),
      ]),
    });
  },
);
