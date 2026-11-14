import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./worker.mjs";

function assets({ markdownStatus = 200, requests = [] } = {}) {
  return {
    ASSETS: {
      async fetch(request) {
        requests.push(request);
        const url = new URL(request.url);
        const markdown = url.pathname.endsWith("index.md");
        if (url.pathname === "/missing/")
          return new Response("Missing", { status: 404 });
        if (url.pathname === "/guide")
          return Response.redirect(`${url.origin}/guide/`, 307);
        const headers = {
          "Content-Type": markdown ? "text/plain" : "text/html",
          ETag: markdown ? '"markdown"' : '"html"',
          Link: '<https://rea.tools/.well-known/ard.json>; rel="ard"',
        };
        const status =
          request.headers.get("If-None-Match") === headers.ETag
            ? 304
            : markdown
              ? markdownStatus
              : 200;
        return new Response(
          request.method === "HEAD" || status === 304
            ? null
            : markdown
              ? "# Guide"
              : "<h1>Guide</h1>",
          { headers, status },
        );
      },
    },
  };
}

await test("HTML is the default and explicit Accept preferences select Markdown", async () => {
  for (const [accept, markdown] of [
    [null, false],
    ["*/*", false],
    ["text/html", false],
    ["text/markdown", true],
    ["text/markdown;q=0", false],
    ["text/markdown;q=0.5,text/html", false],
    ["text/markdown,text/html;q=0.5", true],
    ["text/markdown,text/html", false],
    ["TEXT/MARKDOWN; q=1,text/*;q=0.5", true],
    ["text/markdown;q=bad", false],
    ["text/markdown;q=1e0", false],
    ["text/markdown;q=+1", false],
    ["text/markdown;q=1.0000", false],
    ["text/markdown;q=0.125,text/html;q=0.124", true],
    ["text/markdown;q=1.000", true],
    ["text/markdown;q=0,*/*;q=1", false],
  ]) {
    const response = await worker.fetch(
      new Request("https://rea.tools/guide/", {
        headers: accept === null ? {} : { Accept: accept },
      }),
      assets(),
    );
    assert.equal(
      response.headers.get("Content-Type"),
      markdown ? "text/markdown; charset=utf-8" : "text/html",
      accept,
    );
    assert.equal(
      await response.text(),
      markdown ? "# Guide" : "<h1>Guide</h1>",
      accept,
    );
    assert.match(response.headers.get("Vary"), /Accept/);
    assert.match(response.headers.get("Link"), /rel="ard"/);
    assert.match(
      response.headers.get("Link"),
      /<\/guide\/index.md>; rel="alternate"/,
    );
  }
});

await test("HEAD and validators use the selected representation", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      new Request("https://rea.tools/guide/", {
        method,
        headers: { Accept: "text/markdown", "If-None-Match": '"html"' },
      }),
      assets(),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("ETag"), '"markdown"');
    assert.equal(await response.text(), method === "HEAD" ? "" : "# Guide");
  }
  for (const [accept, tag] of [
    ["text/html", '"html"'],
    ["text/markdown", '"markdown"'],
  ]) {
    const response = await worker.fetch(
      new Request("https://rea.tools/guide/", {
        headers: { Accept: accept, "If-None-Match": tag },
      }),
      assets(),
    );
    assert.equal(response.status, 304);
    assert.equal(await response.text(), "");
    assert.match(response.headers.get("Vary"), /Accept/);
  }
});

await test("missing Markdown keeps HTML, and asset redirects and missing routes survive", async () => {
  const requests = [];
  const html = await worker.fetch(
    new Request("https://rea.tools/guide/", {
      headers: { Accept: "text/markdown" },
    }),
    assets({ markdownStatus: 404, requests }),
  );
  assert.equal(await html.text(), "<h1>Guide</h1>");
  assert.equal(requests.length, 2, "reuse the unchanged HTML probe");
  for (const [path, status] of [
    ["/guide", 307],
    ["/missing/", 404],
  ]) {
    const response = await worker.fetch(
      new Request(`https://rea.tools${path}`, {
        headers: { Accept: "text/markdown" },
      }),
      assets(),
    );
    assert.equal(response.status, status);
  }
});

await test("a Markdown-preferring client keeps the HTML validator when the sidecar is missing", async () => {
  const requests = [];
  const response = await worker.fetch(
    new Request("https://rea.tools/guide/", {
      headers: { Accept: "text/markdown", "If-None-Match": '"html"' },
    }),
    assets({ markdownStatus: 404, requests }),
  );
  assert.equal(response.status, 304);
  assert.equal(requests.length, 3, "reevaluate the original HTML validator");
});
