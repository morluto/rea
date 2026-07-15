import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Materialize a source-owned Electron/Webpack/Rspack fixture tree. */
export const writeJavaScriptArtifactFixture = async (
  root: string,
): Promise<void> => {
  const sourceMapDirective = `${String.fromCharCode(47, 47)}# sourceMap${"ping"}URL=renderer.js.map`;
  await Promise.all([
    mkdir(join(root, "renderer", "chunks"), { recursive: true }),
    mkdir(join(root, "native"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "rea-javascript-fixture",
          version: "1.0.0",
          main: "./main.js",
          renderer: "./renderer/index.html",
        },
        null,
        2,
      ),
    ),
    writeFile(
      join(root, "main.js"),
      `
        import { BrowserWindow } from "electron";
        import path from "node:path";
        const window = new BrowserWindow({
          webPreferences: { preload: path.join(__dirname, "preload.js") }
        });
        window.loadFile("./renderer/index.html");
        require("./native/addon.node");
      `,
    ),
    writeFile(
      join(root, "preload.js"),
      `
        import { contextBridge, ipcRenderer } from "electron";
        contextBridge.exposeInMainWorld("fixture", {
          lookup: (id) => ipcRenderer.invoke("fixture:lookup", id)
        });
      `,
    ),
    writeFile(
      join(root, "renderer", "index.html"),
      '<!doctype html><script type="module" src="./renderer.js"></script>',
    ),
    writeFile(
      join(root, "renderer", "renderer.js"),
      `
        import "./chunks/webpack.js";
        import "./chunks/rspack.js";
        const routes = [{ path: "/items/:id" }];
        fetch("https://api.example.test/items?token=fixture-secret");
        localStorage.setItem("theme", "dark");
        indexedDB.open("fixture-db");
        new Worker("./worker.js");
        navigator.serviceWorker.register("./sw.js");
        void routes;
        ${sourceMapDirective}
      `,
    ),
    writeFile(
      join(root, "renderer", "worker.js"),
      "self.onmessage = (event) => postMessage(event.data);\n",
    ),
    writeFile(
      join(root, "renderer", "sw.js"),
      'caches.open("fixture-cache");\n',
    ),
    writeFile(
      join(root, "renderer", "chunks", "webpack.js"),
      `
        globalThis.__rea_bundle_executed = true;
        (globalThis.webpackChunkfixture = globalThis.webpackChunkfixture || []).push([
          [101],
          {
            1: (module, exports, r) => {
              const dependency = r(2);
              exports.lookup = () => dependency;
            },
            2: (module) => { module.exports = { value: 42 }; }
          }
        ]);
        throw new Error("bundle execution must never happen");
      `,
    ),
    writeFile(
      join(root, "renderer", "chunks", "rspack.js"),
      `
        (self.rspackChunkfixture = self.rspackChunkfixture || []).push([
          ["editor"],
          {
            "src/editor.ts": (module, exports, r) => {
              exports.render = () => r("src/model.ts");
            },
            "src/model.ts": (module) => { module.exports = "model"; }
          }
        ]);
      `,
    ),
    writeFile(
      join(root, "renderer", "renderer.js.map"),
      JSON.stringify({
        version: 3,
        file: "renderer.js",
        sourceRoot: "webpack://fixture/",
        sources: ["src/renderer.ts"],
        sourcesContent: [
          'export const route = "/items/:id"; fetch("/api/items");',
        ],
        names: [],
        mappings: "AAAA",
      }),
    ),
    writeFile(
      join(root, "native", "addon.node"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    ),
  ]);
};
