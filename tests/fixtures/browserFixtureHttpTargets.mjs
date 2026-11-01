import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { networkInterfaces } from "node:os";
import {
  closeVerifierResources,
  withVerifierCleanup,
} from "../../scripts/lib/verifier-cleanup.mjs";

const kind = process.argv[2];
const owned = [];
let alternateRequests = 0;
let site;

const upstream = async (name) => {
  const server = createServer((incoming, response) => {
    if (name === "alternate") alternateRequests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ name, target: incoming.url }));
  });
  owned.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};

const send = (origin, target) =>
  new Promise((resolve, reject) => {
    const selected = new URL(origin);
    const pending = request(
      {
        hostname: selected.hostname,
        port: selected.port,
        path: target,
        timeout: 2_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    pending.on("error", reject);
    pending.on("timeout", () =>
      pending.destroy(new Error("Fixture HTTP request timed out")),
    );
    pending.end();
  });

await withVerifierCleanup(async () => {
  let origin;
  let ordinary;
  let expected;
  if (kind === "proxy") {
    const configured = await upstream("configured");
    const alternate = await upstream("alternate");
    const { startProxy } =
      await import("../../scripts/lib/browser-scenario-service-worker-setup-e2e.mjs");
    site = await startProxy(configured, "http-discovery");
    origin = site.endpoint;
    ordinary = "/probe?x=1";
    expected = JSON.stringify({ name: "configured", target: ordinary });
    for (const [target, path] of [
      ["/probe?x=a%20b&x=2", "/probe?x=a%20b&x=2"],
      [`${alternate}/probe?absolute=1`, "/probe?absolute=1"],
      [
        `${alternate.replace("http:", "")}/probe?x=1`,
        `${alternate.replace("http:", "")}/probe?x=1`,
      ],
      ["https://unused.invalid/probe?escaped=%2f", "/probe?escaped=%2f"],
      ["/%40scope%2fmodule?x=%252f", "/%40scope%2fmodule?x=%252f"],
    ]) {
      const reply = await send(origin, target);
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), {
        name: "configured",
        target: path,
      });
    }
    assert.equal(alternateRequests, 0);
  } else if (kind === "workers") {
    const { startSite } =
      await import("../../scripts/lib/browser-scenario-service-workers-e2e.mjs");
    site = await startSite();
    origin = site.origin;
    ordinary = "/probe";
    expected = "network";
  } else {
    assert.equal(kind, "storage");
    const { startStorageSite } =
      await import("../../scripts/lib/browser-scenario-storage-e2e.mjs");
    site = await startStorageSite();
    origin = site.origin;
    ordinary = "/storage-main";
  }
  const checkOrdinary = async () => {
    const reply = await send(origin, ordinary);
    assert.equal(reply.status, 200);
    if (expected !== undefined) assert.equal(reply.body, expected);
    else assert(reply.body.includes('id="main-report"'));
  };
  await checkOrdinary();
  if (process.argv[3] === "listener-scope") {
    assert.equal(kind, "storage");
    const named = new URL(origin);
    named.hostname = "localhost";
    const localhost = await send(named.href, ordinary);
    assert.equal(localhost.status, 200);
    assert(localhost.body.includes('id="main-report"'));
    const address = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal);
    assert(
      address,
      "Listener scope probe requires an owned non-loopback IPv4 interface",
    );
    const nonLoopback = new URL(origin);
    nonLoopback.hostname = address.address;
    await assert.rejects(send(nonLoopback.href, ordinary), {
      code: "ECONNREFUSED",
    });
    console.log("storage: localhost served; non-loopback connection refused");
  }
  for (const target of [
    "http://[",
    "ftp://127.0.0.1/probe",
    "ws://127.0.0.1/probe",
  ]) {
    const reply = await send(origin, target);
    assert.equal(reply.status, 400);
    assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.equal(reply.body, "Invalid HTTP request target");
    await checkOrdinary();
  }
  await site.close();
  site = undefined;
  await assert.rejects(send(origin, ordinary));
  console.log(
    `${kind}: target routing, invalid-target recovery and physical close passed`,
  );
}, [
  () => site?.close(),
  () =>
    closeVerifierResources(
      owned.map((server) => async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((cause) => (cause ? reject(cause) : resolve())),
        );
      }),
    ),
]);
