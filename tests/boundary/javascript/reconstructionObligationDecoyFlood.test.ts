import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  build,
  request,
} from "../../../src/application/ReconstructionObligationLedger.fixture.js";
import { OBLIGATION_OVERGENERATION_THRESHOLD } from "../../../src/application/ReconstructionObligationLedgerEvaluation.js";

const DECOY_COUNT = OBLIGATION_OVERGENERATION_THRESHOLD + 5;

it("keeps the real context-bridge obligation when dead-code decoy bridges flood the preload", async () => {
  const root = await createTestTempDirectory("rea-obligation-decoy-flood-");
  const decoys = Array.from(
    { length: DECOY_COUNT },
    (_, index) =>
      `  contextBridge.exposeInMainWorld("decoy${String(index)}", { probe: () => ipcRenderer.invoke("decoy:${String(index)}") });`,
  ).join("\n");
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ main: "main.js" }),
    "main.js":
      'const path = require("node:path"); const { BrowserWindow, ipcMain } = require("electron"); new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true } }); ipcMain.handle("desktop:open", () => true);',
    "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopApi", { openProject: (project) => ipcRenderer.invoke("desktop:open", project) });
if (false) {
${decoys}
}
`,
  });
  const analyzed = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  // The real bridge must come from the existing Electron binding path before
  // the ledger is asked about it.
  const bridges = result.graph.nodes.filter(
    ({ kind }) => kind === "context-bridge-api",
  );
  const realBridge = bridges.find(({ observations }) =>
    observations.some(({ properties }) => properties.api_key === "desktopApi"),
  );
  if (realBridge === undefined)
    throw new Error("Expected the preload context bridge to be detected");
  expect(bridges).toHaveLength(DECOY_COUNT + 1);

  const ledger = build(request([analyzed.value]));
  expect(
    ledger.obligations.find(
      ({ target }) => target.application_node_id === realBridge.node_id,
    ),
  ).toMatchObject({
    family: "context-bridge",
    title: "desktopApi",
    target: { artifact_sha256: result.root_artifact_sha256 },
    status: "unowned",
  });
  for (const bridge of bridges)
    expect(
      ledger.obligations.some(
        ({ target }) => target.application_node_id === bridge.node_id,
      ),
    ).toBe(true);
  const overgeneration = ledger.limitations.filter((limitation) =>
    limitation.startsWith("obligation-overgeneration:"),
  );
  expect(overgeneration).toHaveLength(1);
  expect(overgeneration[0]).toContain(
    `artifact ${result.root_artifact_sha256} has`,
  );
  expect(overgeneration[0]).toContain("context-bridge");
  expect(ledger.status).toBe("unknown");
}, 60_000);
