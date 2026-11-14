import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves trailing-slash exports uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-trailing-slash-exports-");
    const requests = ["dep/a", "dep/a/", "dep/exact", "dep/blocked/a/"];
    await writeFixtureFiles(root, {
      "consumer.mjs": requests
        .map((specifier) => `import ${JSON.stringify(specifier)};`)
        .join("\n"),
      "consumer.cjs": requests
        .map((specifier) => `require(${JSON.stringify(specifier)});`)
        .join("\n"),
      "node_modules/dep/package.json": JSON.stringify({
        name: "dep",
        exports: {
          "./*": "./lib/*.js",
          "./a/": null,
          "./exact": "./lib/a.js",
          "./blocked/*": null,
        },
      }),
      "node_modules/dep/lib/a.js": 'throw new Error("must never load");',
      "node_modules/dep/lib/a/.js": 'throw new Error("must never load");',
      "oracle.mjs": `
import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const requests = ${JSON.stringify(requests)};
const resolve = loader => requests.map(request => {
  try { return relative(process.cwd(), loader(request)).split(sep).join("/"); }
  catch (error) { return error.code; }
});
console.log(JSON.stringify({
  import: resolve(request => fileURLToPath(import.meta.resolve(request))),
  require: resolve(request => require.resolve(request)),
}));`,
    });
    // Resolve both loader forms without executing the selected modules.
    const targets = [
      "node_modules/dep/lib/a.js",
      "node_modules/dep/lib/a/.js",
      "node_modules/dep/lib/a.js",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    ];
    expect(await runNodeJsonControl(root, "oracle.mjs")).toEqual({
      import: targets,
      require: targets,
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root, {
      sourcePaths: [
        "consumer.mjs",
        "consumer.cjs",
        "node_modules/dep/package.json",
        "node_modules/dep/lib/a.js",
        "node_modules/dep/lib/a/.js",
      ],
    });
    for (const [specifier, status] of [
      ["dep/a", "unavailable"],
      ["dep/a/", "unavailable"],
      ["dep/exact", "resolved"],
      ["dep/blocked/a/", "external"],
    ] as const) {
      const edges = graph.edges.filter(
        ({ relation, properties }) =>
          relation === "imports" && properties.specifier === specifier,
      );
      for (const source of ["consumer.mjs", "consumer.cjs"])
        expect(
          edges.some(
            ({ evidence }) =>
              evidence.location.available &&
              evidence.location.value.kind === "source-range" &&
              evidence.location.value.source === source,
          ),
          `${source}: ${specifier}`,
        ).toBe(true);
      for (const edge of edges)
        expect(edge.properties).toMatchObject({
          resolution_status: status,
          resolved_path:
            status === "resolved" ? "node_modules/dep/lib/a.js" : null,
        });
    }
  },
);
