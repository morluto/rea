import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("analyzes direct returns after deep source without exhausting the default process stack", async () => {
  const root = await createTestTempDirectory("rea-deep-direct-returns-");
  await writeFile(
    join(root, "app.js"),
    `export function render() { object${".property".repeat(20_000)}; function nested() { return "nested"; } class Inner { method() { return "method"; } } return "ready"; }`,
  );
  const service = new URL(
    "../../../dist/application/javascript/JavaScriptApplicationService.js",
    import.meta.url,
  ).href;
  const script = `
    import { analyzeJavaScriptApplication } from ${JSON.stringify(service)};
    const result = await analyzeJavaScriptApplication({ input_path: ${JSON.stringify(root)}, format: "directory" });
    if (!result.ok) throw result.error;
    const nodes = result.value.normalized_result.semantic_graph.nodes;
    console.log(JSON.stringify(nodes.filter(node => node.kind === "return-site").map(node => node.function_node_id)));
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10_000, env: { HOME: root, TMPDIR: root } },
  );
  expect(stderr).toBe("");
  const owners: unknown = JSON.parse(stdout);
  expect(owners).toHaveLength(3);
  expect(new Set(Array.isArray(owners) ? owners : []).size).toBe(3);
});
