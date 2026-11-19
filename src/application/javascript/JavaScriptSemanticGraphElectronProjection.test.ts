import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  createJavaScriptSemanticGraphProjection,
  projectJavaScriptSemanticFileSteps,
} from "./JavaScriptSemanticGraphBuilder.js";

const source = `${Array.from({ length: 40 }, (_, i) => `function library${String(i)}(){return ${String(i)}}`).join("\n")}
  const e=require("electron");
  function register(channel,callback){e.ipcMain.addListener(channel,event=>allowed(event)&&callback(event))}
  register("test:copy",event=>event.sender.copy());`;
const file: JavaScriptArtifactFile = {
  path: "main.js",
  sha256: "a".repeat(64),
  container_sha256: "b".repeat(64),
  bytes: source.length,
  inventory_artifact_id: `art_${"a".repeat(64)}`,
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: source },
};
const facts = analyzeJavaScriptStaticSource(source);
const ir = analyzeJavaScriptSemantics(source);
it("retains Electron boundary evidence until the node budget cuts the path", () => {
  for (const budget of [3, 20]) {
    const projection = createJavaScriptSemanticGraphProjection({
      totalNodes: budget,
      fileNodes: budget,
    });
    const steps = projectJavaScriptSemanticFileSteps(
      file,
      ir,
      projection.remainingFileCapacity(),
      facts.electron.call_paths,
    );
    let result = steps.next();
    while (!result.done) result = steps.next();
    projection.adoptFileProjection(result.value);
    const graph = projection.finish(file.container_sha256, {
      graph_id: `jag_${"c".repeat(64)}`,
      nodes: [],
    });

    expect(graph.nodes).toHaveLength(budget);
    expect(graph.coverage).toMatchObject({
      status: "partial",
      truncated: true,
    });
    const terminal = graph.nodes.find(
      ({ label }) => label === "ipc-event.sender.copy",
    );
    if (budget === 3) {
      expect(terminal).toBeUndefined();
      continue;
    }
    if (terminal === undefined)
      throw new Error("Expected the Electron terminal");
    expect(graph.relations).toContainEqual(
      expect.objectContaining({
        target_node_id: terminal.node_id,
        resolution: "candidate",
      }),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          entry: "test:copy",
          conditions: [expect.anything()],
        }),
      }),
    );
  }
});
