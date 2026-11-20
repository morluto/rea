import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../support/javascriptApplicationScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/workspace/writeFixtureFiles.js";

it("requires exact HTML script paths when fallback candidates exist", async () => {
  const root = await createTestTempDirectory("rea-html-resources-");
  await writeFixtureFiles(root, {
    "index.html": [
      '<script src="./extension"></script>',
      '<script src="./directory"></script>',
      '<script src="./package"></script>',
    ].join("\n"),
    "base.html": [
      '<base href="%61ssets/">',
      '<script src="./app"></script>',
      '<script src="%61pp.js?cache=1#v2"></script>',
    ].join("\n"),
    "extension.js": "globalThis.extensionDecoy = true;",
    "directory/index.js": "globalThis.directoryDecoy = true;",
    "package/package.json": '{"main":"entry.js"}',
    "package/entry.js": "globalThis.packageDecoy = true;",
    "app.js": "globalThis.rootDecoy = true;",
    "assets/app.js": "globalThis.exactScript = true;",
  });

  const { graph } = await reconstructJavaScriptArtifact({ input_path: root });
  const loads = graph.edges.filter(
    ({ relation, properties }) =>
      relation === "loads" && properties.script_path !== undefined,
  );
  expect(loads).toMatchObject([
    {
      properties: {
        script_path: "%61pp.js?cache=1#v2",
        base_href: "%61ssets/",
        resolution_status: "resolved",
        resolved_path: "assets/app.js",
      },
    },
  ]);

  const unresolved = graph.nodes
    .flatMap(({ observations }) => observations)
    .filter(
      ({ properties }) => properties.mechanism === "html-script-reference",
    );
  expect(unresolved).toHaveLength(4);
  for (const [source, scriptPath, candidate, base] of [
    ["index.html", "./extension", "extension", null],
    ["index.html", "./directory", "directory", null],
    ["index.html", "./package", "package", null],
    ["base.html", "./app", "assets/app", "%61ssets/"],
  ] as const) {
    const reference = unresolved.find(
      ({ properties }) => properties.script_path === scriptPath,
    );
    expect(reference, scriptPath).toMatchObject({
      properties: {
        script_path: scriptPath,
        base_href: base,
        resolution_context: "html-reference",
        resolution_status: "not-found",
        resolved_path: null,
      },
      evidence: {
        authority: "static-relationship-inference",
        location: {
          available: true,
          value: { kind: "source-range", source },
        },
        limitations: expect.arrayContaining([
          expect.stringContaining(
            `The exact HTML resource ${candidate} was not found`,
          ),
        ]),
      },
    });
  }
});
