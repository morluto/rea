import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest(
  "reports complete coverage for a parsed module without Electron identity whose hoisted read precedes its initializer",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-coverage-hoisted-read-");
    await writeFixtureFiles(root, {
      "index.js": [
        "function schedule(callback) {",
        "  return scheduleTimeout(callback, 0);",
        "}",
        'var scheduleTimeout = "function" === typeof setTimeout ? setTimeout : void 0;',
        "module.exports = { schedule };",
        "",
      ].join("\n"),
    });
    const application = await analyzeJavaScriptDirectory("CLI", cli, root);

    expect(application.statistics).toMatchObject({
      parsed_javascript_files: 1,
      parse_failures: 0,
    });
    const source = application.graph.nodes
      .flatMap((node) => node.observations)
      .find((observation) => observation.properties.file_kind === "javascript");
    expect(source?.properties.parse_status).toBe("complete");
    expect(application.graph.coverage).toEqual({
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: [],
    });
  },
);
