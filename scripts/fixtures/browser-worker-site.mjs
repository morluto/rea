import { createServer } from "node:http";

/** A source-owned page and workers; no external sites or application data. */
export async function startWorkerSite() {
  const sources = {
    "/worker.js":
      'onmessage=async()=>{console.log("worker fixture message");await fetch("/worker-request");postMessage("done")};postMessage("ready");',
    "/module.js":
      'export const marker="模块🧪";onmessage=async()=>{await fetch("/module-request")};',
    "/shared.js":
      'onconnect=e=>{const p=e.ports[0];p.onmessage=async()=>{await fetch("/shared-request");p.postMessage("done")};p.start();p.postMessage("ready")};',
    "/service.js":
      'self.addEventListener("install",e=>e.waitUntil(self.skipWaiting()));self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));self.addEventListener("fetch",e=>{if(new URL(e.request.url).pathname==="/cached")e.respondWith(caches.open("fixture").then(async c=>{await c.put(e.request,new Response("cached fixture"));return c.match(e.request)}))});',
  };
  const html = `<!doctype html><title>worker fixture</title><script>window.ready=(async()=>{window.worker=new Worker('/worker.js');await new Promise(r=>worker.onmessage=r);window.mod=new Worker('/module.js',{type:'module'});window.shared=new SharedWorker('/shared.js');shared.port.start();await new Promise(r=>shared.port.onmessage=r);await navigator.serviceWorker.register('/service.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));return true})();window.act=async()=>{worker.postMessage('run');mod.postMessage('run');shared.port.postMessage('run');await fetch('/cached');};</script>`;
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      sources[req.url] ? "text/javascript" : "text/html",
    );
    if (req.url.endsWith("-request")) {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'nonce-worker-fixture-secret'",
      );
      res.setHeader("Link", '</agent>; rel="mcp"');
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Set-Cookie", "worker-fixture-credential=secret");
    }
    res.end(
      sources[req.url] ??
        (req.url === "/" || req.url === "/other"
          ? html
          : req.url === "/frame"
            ? `<script>window.ready=(async()=>{window.worker=new Worker("/worker.js");await new Promise(resolve=>worker.onmessage=resolve);await navigator.serviceWorker.register('/service.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));})();</script>`
            : "ok"),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    sources,
    close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}
