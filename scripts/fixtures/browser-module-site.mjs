import { createServer } from "node:http";

const SAFE_BROWSER_PORT_START = 49_152;
const SAFE_BROWSER_PORT_ATTEMPTS = 64;

const listenOnSafeBrowserPort = async (server) => {
  for (let attempt = 0; attempt < SAFE_BROWSER_PORT_ATTEMPTS; attempt += 1) {
    const port = SAFE_BROWSER_PORT_START + attempt;
    try {
      await new Promise((resolve, reject) => {
        const listening = () => {
          server.off("error", failed);
          resolve();
        };
        const failed = (cause) => {
          server.off("listening", listening);
          reject(cause);
        };
        server.once("listening", listening);
        server.once("error", failed);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (cause) {
      if (cause?.code !== "EADDRINUSE" && cause?.code !== "EACCES") throw cause;
    }
  }
  throw new Error("Module fixture could not bind a safe loopback browser port");
};

/** Source-owned module graph with actual native loading and an uncalled lazy edge. */
export async function startBrowserModuleSite() {
  const requests = [];
  const importMap = {
    imports: { "pkg/": "/pkg/", alias: "./global.js", blocked: null },
    scopes: { "/scoped/": { alias: "./scoped.js" } },
  };
  const main = `
import {marker as alias} from 'alias';
import {marker as pkg} from 'pkg/nested.js';
const a = await import('/query.js?v=1#one');
const b = await import('/query.js?v=1#two');
const c = await import('/query.js?v=2');
const again = await import('/query.js?v=1#one');
const specifiers = ['alias', 'pkg/nested.js', '/query.js?v=1#one', '/query.js?v=1#two', '/query.js?v=2', '/query.js?v=1#one', './lazy.js', 'blocked', 'pkg/../escape.js', 'pkg/%2e%2e/escape.js', ''];
globalThis.__moduleProof = {alias, pkg, urls: [a.url,b.url,c.url], instances: [a.instance,b.instance,c.instance], same_module: again === a, different_fragments: a !== b, resolutions: specifiers.map(specifier => {try{return {state: 'resolved', url: import.meta.resolve(specifier)}}catch(error){return {state: 'rejected', message: String(error)}}})};
document.body.dataset.ready = 'true';
function uncalled(){return import('./lazy.js')}
function blocked(){return import('blocked')}
function escaped(){return import('pkg/../escape.js')}
function encodedEscape(){return import('pkg/%2e%2e/escape.js')}
function empty(){return import('')}
function computed(name){return import(name)}
`;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/")
      return response
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          `<body><base href="/maps/"><script type="importmap">${JSON.stringify(importMap)}</script><script type="module" src="/scoped/main.js?build=2#entry"></script></body>`,
        );
    response.setHeader("Content-Type", "text/javascript");
    if (request.url?.startsWith("/scoped/main.js?")) return response.end(main);
    if (request.url === "/maps/scoped.js")
      return response.end("export const marker = 'scoped';");
    if (request.url === "/pkg/nested.js")
      return response.end("export const marker = 'pkg';");
    if (request.url?.startsWith("/query.js?"))
      return response.end(
        "globalThis.__moduleCount = (globalThis.__moduleCount ?? 0) + 1; export const instance = globalThis.__moduleCount; export const url = import.meta.url;",
      );
    response.writeHead(404).end("Not selected");
  });
  const port = await listenOnSafeBrowserPort(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    importMap,
    main,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
