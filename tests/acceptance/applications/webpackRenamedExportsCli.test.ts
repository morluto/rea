import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports Webpack exports attached to renamed factory parameters",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-webpack-renamed-exports-");
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "chunk.js"),
      `globalThis.webpackChunkApp.push([[1], {
      17(module, __webpack_exports__, __webpack_require__) {
        __webpack_require__.d(__webpack_exports__, { alpha: () => 1, "beta.gamma": () => 2 });
        Object.defineProperty(__webpack_exports__, "delta", { enumerable: true, get() { return 3; } });
        __webpack_require__.d(__webpack_exports__.nested, { nested_target: () => 0 });
        __webpack_exports__ = { rebound: () => 0 };
        __webpack_require__.d({}, { unrelated: () => 0 });
        { const exports = {}; __webpack_require__.d(exports, { shadowed_exports: () => 5 }); }
      },
      23(m, e, r) { r.d(e, { alpha: () => 1 }); }
      }]);`,
    );
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    const modules = result.graph.nodes
      .filter(({ kind }) => kind === "javascript-module")
      .map(({ observations }) => observations[0]?.properties);
    expect(modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module_key: "17",
          exports: ["alpha", "beta.gamma", "delta"],
        }),
        expect.objectContaining({ module_key: "23", exports: ["alpha"] }),
      ]),
    );
    expect(result.graph.coverage.status).toBe("complete");
  },
);
