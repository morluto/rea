import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import { json, run } from "./lib/verify-package-core.mjs";

/** Run inventory-artifact and analyze-javascript-application against packaged fixtures. */
export async function verifyPackageArtifactAndElectron({
  cli,
  workspace,
  environment,
}) {
  const artifactArchive = join(workspace, "artifact.zip");
  const artifactWriter = new ZipWriter(new Uint8ArrayWriter());
  await artifactWriter.add("app/main.js", new TextReader("main();"));
  await writeFile(artifactArchive, await artifactWriter.close());
  const artifactInventory = json(
    await run(
      cli,
      ["inventory-artifact", artifactArchive, "--limit", "500", "--json"],
      environment,
    ),
  );
  if (
    artifactInventory.operation !== "inventory_artifact" ||
    artifactInventory.provider?.id !== "rea-artifact-graph" ||
    artifactInventory.normalized_result?.manifest?.root_format !== "zip"
  )
    throw new Error("packaged artifact inventory CLI failed");
  const applicationRoot = join(workspace, "electron-app");
  await mkdir(applicationRoot);
  await writeFile(
    join(applicationRoot, "package.json"),
    '{"name":"packaged-electron-fixture","main":"main.js"}\n',
  );
  await writeFile(
    join(applicationRoot, "main.js"),
    'const { BrowserWindow, ipcMain } = require("electron");\nnew BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true } });\nipcMain.handle("rea:ping", () => true);\n',
  );
  await writeFile(
    join(applicationRoot, "preload.js"),
    'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("rea", { ping: () => ipcRenderer.invoke("rea:ping") });\n',
  );
  const applicationAnalysis = json(
    await run(
      cli,
      [
        "analyze-javascript-application",
        applicationRoot,
        "--approved",
        "--json",
      ],
      environment,
    ),
  );
  if (
    applicationAnalysis.operation !== "analyze_javascript_application" ||
    applicationAnalysis.provider?.id !== "rea-javascript-application" ||
    applicationAnalysis.normalized_result?.summary?.browser_windows !== 1 ||
    applicationAnalysis.normalized_result?.summary?.ipc
      ?.paired_renderer_transmissions !== 1
  )
    throw new Error("packaged JavaScript application analysis CLI failed");

  return { artifactArchive };
}
