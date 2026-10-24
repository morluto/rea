import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../../fixtures/artifactInventory.js";
import { readJavaScriptArtifactFiles } from "../../../support/javascriptApplicationScope.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { analyzeJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";

it("keeps an endpoint uncertain after mutation through a declared inherited field", async () => {
  const root = await createTestTempDirectory("rea-js-erased-field-");
  await writeFile(
    join(root, "app.ts"),
    `
    const options = { url: "/before" };
    class Base { field = options; }
    class Derived extends Base { declare field: { url: string }; }
    new Derived().field.url = "/after";
    const target = options.url;
    fetch(target);
  `,
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.observations[0]).toMatchObject({
      properties: { value: "target", resolution: "partial" },
      evidence: {
        authority: "ast-static-analysis",
        state: "observed",
        limitations: [expect.stringContaining("not an exact literal")],
      },
    });
  } finally {
    await reader.close();
  }
});

it("projects a qualified global socket with its source evidence and excludes a local lookalike", async () => {
  const root = await createTestTempDirectory("rea-js-qualified-socket-");
  await writeFile(
    join(root, "app.js"),
    [
      'function local(window) { new window.WebSocket("wss://example.test/local"); }',
      'new globalThis.WebSocket("wss://example.test/socket");',
    ].join("\n"),
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    expect(endpoints).toHaveLength(1);
    const observation = endpoints[0]?.observations[0];
    expect(observation?.properties).toMatchObject({
      value: "wss://example.test/socket",
      mechanism: "call:globalThis.WebSocket",
    });
    expect(observation?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
      location: {
        available: true,
        value: {
          kind: "source-range",
          source: "app.js",
          start: { line: 2, column: 0 },
        },
      },
    });
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains constructor captures, ws imports and template keys with their graph source ranges", async () => {
  const root = await createTestTempDirectory("rea-js-bound-socket-");
  await writeFile(
    join(root, "app.js"),
    [
      'import Socket from "ws";',
      "const Captured = globalThis.WebSocket;",
      'new Socket("wss://example.test/imported");',
      'new Captured("wss://example.test/captured");',
      'new globalThis[`WebSocket`]("wss://example.test/template");',
      "",
      "",
      "const { WebSocket: Projected } = globalThis;",
      'new Projected("wss://example.test/projected");',
      "function connect() {",
      'new Deferred("wss://example.test/deferred");',
      "}",
      "const Deferred = globalThis.WebSocket;",
      "connect();",
      "",
      "",
      "",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "import-equals.ts"),
    'import Socket = require("ws");\nnew Socket("wss://example.test/import-equals");',
  );
  // Keep the native loader in its real CommonJS wrapper, separate from ESM.
  await writeFile(
    join(root, "commonjs.cjs"),
    [
      'const CommonJs = require("ws");',
      'new CommonJs("wss://example.test/commonjs");',
      'const { WebSocket: Named } = require("ws");',
      'new Named("wss://example.test/named-commonjs");',
      'const Member = require("ws").WebSocket;',
      'new Member("wss://example.test/member-commonjs");',
    ].join("\n"),
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    expect(endpoints).toHaveLength(9);
    for (const [path, constructor, line, source] of [
      ["imported", "Socket", 3, "app.js"],
      ["captured", "Captured", 4, "app.js"],
      ["template", "globalThis.WebSocket", 5, "app.js"],
      ["commonjs", "CommonJs", 2, "commonjs.cjs"],
      ["projected", "Projected", 9, "app.js"],
      ["deferred", "Deferred", 11, "app.js"],
      ["import-equals", "Socket", 2, "import-equals.ts"],
      ["named-commonjs", "Named", 4, "commonjs.cjs"],
      ["member-commonjs", "Member", 6, "commonjs.cjs"],
    ] as const) {
      const observation = endpoints.find(({ observations }) =>
        observations.some(
          ({ properties }) => properties.value === `wss://example.test/${path}`,
        ),
      )?.observations[0];
      expect(observation?.properties).toMatchObject({
        value: `wss://example.test/${path}`,
        mechanism: `call:${constructor}`,
      });
      expect(observation?.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        confidence: "exact",
        location: {
          available: true,
          value: {
            kind: "source-range",
            source,
            start: { line, column: 0 },
          },
        },
      });
    }
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

const socketExecutionPhaseSources = {
  "review-getter.js":
    '({ get run() { new Socket("wss://example.test/review-getter"); return () => {}; } }).run(); const Socket = globalThis.WebSocket;',
  "review-pattern.mjs":
    'export {}; const { pending, unused = new (await pending).WebSocket("wss://example.test/review-pattern") } = { pending: import("ws") };',
  "review-label.js":
    '(async () => { label: { for (;;) { break; } await 0; } new Socket("wss://example.test/review-label"); })(); const Socket = globalThis.WebSocket;',
  "review-caught.mjs":
    'export {}; const pending=(async()=>{await 0;new Socket("wss://example.test/review-caught")})(); try { try {throw 0;} finally {} await pending; } catch {} const Socket=globalThis.WebSocket;',
  "review-capture.js":
    'const ws=require("ws");const {WebSocket:Socket,[(ws.WebSocket=class{},"x")]:ignored}=ws;new Socket("wss://example.test/review-capture");',
  "review-nested-loop.js":
    '(async()=>{do {while(true){break;} await 0;}while(false);new Socket("wss://example.test/review-nested-loop")})(); const Socket=globalThis.WebSocket;',
  "review-generator.js":
    'for(const ignored of (function*(){new Socket("wss://example.test/review-generator");yield 0;})()){} const Socket=globalThis.WebSocket;',
  "review-instance.js":
    '(new(class {run(){new Socket("wss://example.test/review-instance")}})()).run();const Socket=globalThis.WebSocket;',
  "phase-class.js":
    "(class { static run() { new Socket('wss://example.test/invalid-phase-class') } }).run(); const Socket = globalThis.WebSocket;",
  "phase-wrapper.js":
    "(async () => { const pending = (async () => { await 0; new Socket('wss://example.test/invalid-phase-wrapper') })(); await (() => pending)(); const Socket = globalThis.WebSocket; })();",
  "phase-label.js":
    "(async () => { label: { await 0; } new Socket('wss://example.test/phase-label') })(); const Socket = globalThis.WebSocket;",
  "phase-finally.js":
    "(async () => { try { throw await 0; } finally { new Socket('wss://example.test/phase-finally') } })(); const Socket = globalThis.WebSocket;",
  "phase-projection.mjs":
    "export {}; const { pending } = { pending: import('ws') }; const { WebSocket: Socket } = await pending; new Socket('wss://example.test/phase-projection');",
  "phase-accessor.ts":
    "const Client = class { accessor socket = new Socket('wss://example.test/phase-accessor') }; const Socket = globalThis.WebSocket; new Client();",
  "phase-jsx.jsx":
    "(async () => { <div>{await ready}</div>; new Socket('wss://example.test/phase-jsx'); })(); const Socket = globalThis.WebSocket;",
  "selected-call.js":
    '(true ? () => new Socket("wss://example.test/invalid-selected-call") : noop)(); const Socket = globalThis.WebSocket;',
  "import-source.js":
    '(async () => { import(await ready); new Socket("wss://example.test/import-source"); })(); const Socket = globalThis.WebSocket;',
  "case-coupled.js":
    '(async () => { switch (kind) { case 0: const pending = (async () => { await ready; new Socket("wss://example.test/invalid-case-coupled"); })(); await pending; } const Socket = globalThis.WebSocket; })();',
  "fresh-method.js":
    '({ run() { new Socket("wss://example.test/invalid-fresh-method"); } }).run(); const Socket = globalThis.WebSocket;',
  "decorator.ts":
    '@(function () { new Socket("wss://example.test/invalid-decorator"); }) class Client {}; const Socket = globalThis.WebSocket;',
  "selected-stored.js":
    'const connect = (true ? () => new Socket("wss://example.test/selected-stored") : noop); const Socket = globalThis.WebSocket; connect();',
  "import-no-wait.js":
    '(async () => { import("owned:module"); new Socket("wss://example.test/invalid-import-no-wait"); })(); const Socket = globalThis.WebSocket;',
  "case-skipped.js":
    '(async () => { switch (kind) { case 0: const pending = (async () => { await ready; new Socket("wss://example.test/case-skipped"); })(); break; await pending; } const Socket = globalThis.WebSocket; })();',
  "blocking-wrapper.mjs":
    'const pending = (async () => { await 0; new Socket("wss://example.test/invalid-blocking-wrapper"); })(); await (async () => { await pending; })(); const Socket = globalThis.WebSocket;',
  "suspended-blocking-wrapper.mjs":
    'const pending = (async () => { await 0; new Socket("wss://example.test/invalid-suspended-wrapper"); })(); await (async () => { await 0; await pending; })(); const Socket = globalThis.WebSocket;',
  "unawaited-wrapper.js":
    'const pending = (async () => { await 0; new Socket("wss://example.test/unawaited-wrapper"); })(); (async () => { await pending; })(); const Socket = globalThis.WebSocket;',
  "optional-wrapper.mjs":
    'const pending = (async () => { await ready; new Socket("wss://example.test/optional-wrapper"); })(); await (async () => { if (condition) await pending; })(); const Socket = globalThis.WebSocket;',
  "caught-alias.mjs":
    'const pending = (async () => { await 0; new Socket("wss://example.test/caught-alias"); })(); try { await alias; } catch {} const alias = pending; const Socket = globalThis.WebSocket;',
  "dead-wait.js":
    '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/dead-wait"); })(); while (true) { break; await pending; } const Socket = globalThis.WebSocket; })();',
  "logical-rhs.js":
    '(async () => { (await ready).value &&= new Socket("wss://example.test/logical-assignment"); })(); const Socket = globalThis.WebSocket;',
  "case-prefix.js":
    '(async () => { switch (kind) { case 0: await ready; new Socket("wss://example.test/case-prefix"); } })(); const Socket = globalThis.WebSocket;',
  "rebound-import.cts":
    'import ws = require("ws"); const other = require("ws"); ws = {}; ws.WebSocket = class {}; new other.WebSocket("wss://example.test/rebound-import");',
  "branch-alias.js":
    '(async () => { if (condition) { const pending = (async () => { await ready; new Socket("wss://example.test/invalid-branch-alias"); })(); await pending; } const Socket = globalThis.WebSocket; })();',
  "escaped-literal.js":
    'let box; const { unused = (box.WebSocket = class {}), WebSocket: Socket } = (box = { WebSocket: globalThis.WebSocket }); new Socket("wss://example.test/invalid-escaped");',
  "replaced-iterator.js":
    'Array.prototype[Symbol.iterator] = function* () { yield class {}; }; const [Socket] = [globalThis.WebSocket]; new Socket("wss://example.test/invalid-iterator");',
  "ordinary-call.js":
    'globalThis.WebSocket("wss://example.test/invalid-call");',
  "resource-registration.js":
    '(async () => { try { using resource = 1; await 0; } finally { new Socket("wss://example.test/invalid-using"); } })(); const Socket = globalThis.WebSocket;',
  "finally-entry.js":
    '(async () => { try { await 0; } finally { new Socket("wss://example.test/finally-entry"); } })(); const Socket = globalThis.WebSocket;',
  "wrapped-array.js":
    'const [Socket] = (0, [globalThis.WebSocket]); new Socket("wss://example.test/wrapped-array");',
  "switch-await.js":
    '(async () => { switch (await ready) { default: new Socket("wss://example.test/switch-await"); } })(); const Socket = globalThis.WebSocket;',
  "optional-argument.js":
    '(async () => { (await ready)?.(new Socket("wss://example.test/optional-argument")); })(); const Socket = globalThis.WebSocket;',
  "update-operand.js":
    '(async () => { (await ready).count++; new Socket("wss://example.test/update-operand"); })(); const Socket = globalThis.WebSocket;',
  "nested-write.js":
    'const ws = require("ws"); const Socket = ws.WebSocket; if (flag) { ws.WebSocket = Fake; } new Socket("wss://example.test/nested-write");',
  "ws-self.js":
    'const ws = require("ws"); new ws.WebSocket.WebSocket("wss://example.test/ws-self");',
  "exact-result-write.js":
    'let holder; const ws = (holder = require("ws")); ws.WebSocket = Fake; new ws.WebSocket("wss://example.test/invalid-exact-write");',
  "conditional-producer.js":
    '(async () => { if (condition) await (async () => { await ready; new Socket("wss://example.test/invalid-wait"); })(); const Socket = globalThis.WebSocket; })();',
  "implicit-await.js":
    '(async () => { for await (const item of [0]) { new Socket("wss://example.test/implicit-await"); } })(); const Socket = globalThis.WebSocket;',
  "do-await.js":
    '(async () => { do { await ready; } while (false); new Socket("wss://example.test/do-await"); })(); const Socket = globalThis.WebSocket;',
  "try-await.js":
    '(async () => { try { await ready; } finally {} new Socket("wss://example.test/try-await"); })(); const Socket = globalThis.WebSocket;',
  "update-await.js":
    '(async () => { for (let i = 0; i < 1; new Socket("wss://example.test/update-await"), i++) { await ready; } })(); const Socket = globalThis.WebSocket;',
  "pattern-await.js":
    '(async () => { const {[await 0]: value} = {}; new Socket("wss://example.test/pattern-await"); })(); const Socket = globalThis.WebSocket;',
  "binding-event.js":
    'const { WebSocket: Socket, unused = new Socket("wss://example.test/binding-event") } = globalThis;',
  "copy-order.js":
    'const ws = require("ws"); const { WebSocket: Socket } = { WebSocket: ws.WebSocket, later: (ws.WebSocket = class {}) }; new Socket("wss://example.test/copy-order");',
  "binding-before-event.js":
    'const { unused = new Socket("wss://example.test/tdz-binding-event"), WebSocket: Socket } = globalThis;',
  "do-skipped-await.js":
    '(async () => { do { break; await ready; } while (false); new Socket("wss://example.test/tdz-do-jump"); })(); const Socket = globalThis.WebSocket;',
  "tag-eager.js":
    '(function () { new Socket("wss://example.test/tdz-tag"); })``; const Socket = globalThis.WebSocket;',
  "tag-generator.js":
    '(function* () { new Socket("wss://example.test/tag-generator"); })``; const Socket = globalThis.WebSocket;',
  "template.js":
    '(async () => { `${await ready}`; new Socket("wss://example.test/template-continuation"); })(); const Socket = globalThis.WebSocket;',
  "iterable.js":
    '(async () => { for (const item of await ready) {} new Socket("wss://example.test/iterable-continuation"); })(); const Socket = globalThis.WebSocket;',
  "iterable-body.js":
    '(async () => { for (const key in await ready) { new Socket("wss://example.test/iterable-body"); } })(); const Socket = globalThis.WebSocket;',
  "assignment-capture.js":
    'let holder; const Socket = (holder = globalThis.WebSocket); new Socket("wss://example.test/assignment-capture");',
  "numeric-object.js":
    'const [Socket] = { 0: globalThis.WebSocket }; new Socket("wss://example.test/tdz-noniterable");',
  "object-key.js":
    'const { 0: Socket } = { 0: globalThis.WebSocket }; new Socket("wss://example.test/object-key");',
  "wrapped.ts":
    '(function () { new Socket("wss://example.test/eager-wrapper"); } as any)();\nconst Socket = globalThis.WebSocket;',
  "fields.js":
    'class Client { socket = new Socket("wss://example.test/field"); }\nconst Socket = globalThis.WebSocket; new Client();',
  "generator.js":
    '(function* (x = new Socket("wss://example.test/eager-parameter")) {})();\n(function* () { new Socket("wss://example.test/generator-body"); })();\nconst Socket = globalThis.WebSocket;',
  "bound.js":
    '(function () { new Socket("wss://example.test/eager-bind"); }).bind(null)();\nconst connect = (function () { new Socket("wss://example.test/deferred-bind"); }).bind(null);\nconst Socket = globalThis.WebSocket; connect();',
  "async.js":
    '(async () => { new Socket("wss://example.test/eager-async"); await ready; })();\n(async () => { await ready; new Socket("wss://example.test/continuation"); })();\nconst Socket = globalThis.WebSocket;',
  "await-inputs.js": [
    'let value; (async () => { value = await ready; new Socket("wss://example.test/assignment"); })();',
    '(async () => { new (class { socket = new Socket("wss://example.test/argument-field"); })(await ready); })();',
    '(async () => { new (class { constructor() { new Socket("wss://example.test/argument-constructor"); } })(await ready); })();',
    '(async () => { new (class { socket = new Socket("wss://example.test/computed-key"); [await ready] = 0; })(); })();',
    "const Socket = globalThis.WebSocket;",
  ].join("\n"),
  "immediate-generator.js":
    '(function* () { new Socket("wss://example.test/tdz-generator"); })().next(); const Socket = globalThis.WebSocket;',
  "delegated-generator.js":
    '(function* () { yield* []; new Socket("wss://example.test/tdz-delegation"); })().next(); const Socket = globalThis.WebSocket;',
  "waiting-caller.js":
    '(async () => { await (async () => { await ready; new Socket("wss://example.test/tdz-waiting"); })(); const Socket = globalThis.WebSocket; })();',
  "switch-case.js":
    'switch (kind) { case 0: const Socket = globalThis.WebSocket; break; case 1: new Socket("wss://example.test/tdz-case"); }',
  "loop-array.js": [
    '(async () => { while (await ready) { new Socket("wss://example.test/loop-continuation"); break; } })();',
    '(async () => { [await ready, new Socket("wss://example.test/array-continuation")]; })();',
    "const Socket = globalThis.WebSocket;",
  ].join("\n"),
  "sequence-capture.js":
    'const Socket = (0, globalThis.WebSocket); new Socket("wss://example.test/sequence-capture");',
  "dynamic-import.mjs":
    'const { WebSocket: Socket } = await import("ws"); new Socket("wss://example.test/dynamic-import");',
  "object-await.js":
    '(async () => { ({ first: await ready, second: new Socket("wss://example.test/object-continuation") }); })(); const Socket = globalThis.WebSocket;',
  "pending-before.mjs":
    'const pending = (async () => { await ready; new Socket("wss://example.test/tdz-pending"); })(); await pending; const Socket = globalThis.WebSocket;',
  "pending-after.mjs":
    'const pending = (async () => { await ready; new Socket("wss://example.test/pending-initialized"); })(); const Socket = globalThis.WebSocket; await pending;',
  "import-alias.mjs":
    'const pending = import("ws"); const { WebSocket: Socket } = await pending; new Socket("wss://example.test/import-alias");',
  "skipped-wait.mjs":
    'const pending = (async () => { await 0; new Socket("wss://example.test/skipped-wait"); })(); if (false) await pending; const Socket = globalThis.WebSocket;',
  "member-await.js":
    '(async () => { const value = (await ready).value; new Socket("wss://example.test/member-await"); })(); const Socket = globalThis.WebSocket;',
  "optional-capture.js":
    'const Socket = globalThis?.WebSocket; new Socket("wss://example.test/optional-capture");',
  "selected-branch.js":
    '(async () => { if (true) await ready; new Socket("wss://example.test/selected-branch"); })(); const Socket = globalThis.WebSocket;',
  "compound-continuation.js":
    '(async () => { let count = 0; count += await ready; new Socket("wss://example.test/compound-continuation"); })(); const Socket = globalThis.WebSocket;',
  "compound-wait.mjs":
    'const pending = (async () => { await 0; new Socket("wss://example.test/tdz-compound-wait"); })(); let count = 0; count += await pending; const Socket = globalThis.WebSocket;',
  "optional-call.js":
    '(async () => { (await ready)?.(); new Socket("wss://example.test/optional-call"); })(); const Socket = globalThis.WebSocket;',
  "logical-assignment.js":
    '(async () => { let count = 0; count &&= await ready; new Socket("wss://example.test/tdz-logical-assignment"); })(); const Socket = globalThis.WebSocket;',
  "import-equals-member.ts":
    'import ws = require("ws"); const Socket = ws.WebSocket; new Socket("wss://example.test/import-equals-member");',
  "import-equals-written.ts":
    'import ws = require("ws"); ws.WebSocket = class {}; const Socket = ws.WebSocket; new Socket("wss://example.test/tdz-import-equals-write");',
  "array-projection.js":
    'const [[Socket]] = [[globalThis.WebSocket]]; new Socket("wss://example.test/array-projection");',
  "assigned-call.js":
    'let connect; (connect = () => new Socket("wss://example.test/tdz-assignment"))(); const Socket = globalThis.WebSocket;',
  "await-branch.js":
    '(async () => { if (await ready) new Socket("wss://example.test/branch-continuation"); })(); const Socket = globalThis.WebSocket;',
  "immediate-sequence.js":
    '(0, function () { new Socket("wss://example.test/tdz-sequence"); })(); const Socket = globalThis.WebSocket;',
  "async-local.js":
    '(async () => { new Socket("wss://example.test/tdz-before-await"); await ready; const Socket = globalThis.WebSocket; })();',
  "async-phases.js":
    '(async () => { await ready; new Socket("wss://example.test/tdz-between-awaits"); await ready; const Socket = globalThis.WebSocket; })();',
  "immediate-class.js":
    'new (class { socket = new Socket("wss://example.test/tdz-field"); })(); const Socket = globalThis.WebSocket;',
  "immediate-constructor.js":
    'new (class { constructor() { new Socket("wss://example.test/tdz-constructor"); } })(); const Socket = globalThis.WebSocket;',
};

const socketExecutionPhaseLocations = [
  ["review-capture", "review-capture.js", 1],
  ["review-caught", "review-caught.mjs", 1],
  ["review-label", "review-label.js", 1],
  ["review-nested-loop", "review-nested-loop.js", 1],
  ["review-pattern", "review-pattern.mjs", 1],
  ["phase-label", "phase-label.js", 1],
  ["phase-finally", "phase-finally.js", 1],
  ["phase-projection", "phase-projection.mjs", 1],
  ["phase-accessor", "phase-accessor.ts", 1],
  ["phase-jsx", "phase-jsx.jsx", 1],
  ["case-skipped", "case-skipped.js", 1],
  ["import-source", "import-source.js", 1],
  ["selected-stored", "selected-stored.js", 1],
  ["unawaited-wrapper", "unawaited-wrapper.js", 1],
  ["optional-wrapper", "optional-wrapper.mjs", 1],
  ["caught-alias", "caught-alias.mjs", 1],
  ["dead-wait", "dead-wait.js", 1],
  ["logical-assignment", "logical-rhs.js", 1],
  ["case-prefix", "case-prefix.js", 1],
  ["rebound-import", "rebound-import.cts", 1],
  ["finally-entry", "finally-entry.js", 1],
  ["wrapped-array", "wrapped-array.js", 1],
  ["switch-await", "switch-await.js", 1],
  ["optional-argument", "optional-argument.js", 1],
  ["update-operand", "update-operand.js", 1],
  ["nested-write", "nested-write.js", 1],
  ["ws-self", "ws-self.js", 1],
  ["implicit-await", "implicit-await.js", 1],
  ["do-await", "do-await.js", 1],
  ["try-await", "try-await.js", 1],
  ["update-await", "update-await.js", 1],
  ["pattern-await", "pattern-await.js", 1],
  ["binding-event", "binding-event.js", 1],
  ["copy-order", "copy-order.js", 1],
  ["assignment-capture", "assignment-capture.js", 1],
  ["iterable-body", "iterable-body.js", 1],
  ["iterable-continuation", "iterable.js", 1],
  ["object-key", "object-key.js", 1],
  ["tag-generator", "tag-generator.js", 1],
  ["template-continuation", "template.js", 1],
  ["assignment", "await-inputs.js", 1],
  ["argument-field", "await-inputs.js", 2],
  ["argument-constructor", "await-inputs.js", 3],
  ["computed-key", "await-inputs.js", 4],
  ["branch-continuation", "await-branch.js", 1],
  ["continuation", "async.js", 2],
  ["deferred-bind", "bound.js", 2],
  ["field", "fields.js", 1],
  ["generator-body", "generator.js", 2],
  ["array-continuation", "loop-array.js", 2],
  ["loop-continuation", "loop-array.js", 1],
  ["sequence-capture", "sequence-capture.js", 1],
  ["dynamic-import", "dynamic-import.mjs", 1],
  ["object-continuation", "object-await.js", 1],
  ["pending-initialized", "pending-after.mjs", 1],
  ["import-alias", "import-alias.mjs", 1],
  ["skipped-wait", "skipped-wait.mjs", 1],
  ["member-await", "member-await.js", 1],
  ["optional-capture", "optional-capture.js", 1],
  ["selected-branch", "selected-branch.js", 1],
  ["compound-continuation", "compound-continuation.js", 1],
  ["optional-call", "optional-call.js", 1],
  ["import-equals-member", "import-equals-member.ts", 1],
  ["array-projection", "array-projection.js", 1],
] as const;

it("preserves eager and deferred socket phases through filesystem graph projection", async () => {
  const root = await createTestTempDirectory("rea-js-socket-phases-");
  for (const [path, source] of Object.entries(socketExecutionPhaseSources))
    await writeFile(join(root, path), source);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations);
    expect(
      observations.map(({ properties }) => properties.value).sort(),
    ).toEqual([
      "wss://example.test/argument-constructor",
      "wss://example.test/argument-field",
      "wss://example.test/array-continuation",
      "wss://example.test/array-projection",
      "wss://example.test/assignment",
      "wss://example.test/assignment-capture",
      "wss://example.test/binding-event",
      "wss://example.test/branch-continuation",
      "wss://example.test/case-prefix",
      "wss://example.test/case-skipped",
      "wss://example.test/caught-alias",
      "wss://example.test/compound-continuation",
      "wss://example.test/computed-key",
      "wss://example.test/continuation",
      "wss://example.test/copy-order",
      "wss://example.test/dead-wait",
      "wss://example.test/deferred-bind",
      "wss://example.test/do-await",
      "wss://example.test/dynamic-import",
      "wss://example.test/field",
      "wss://example.test/finally-entry",
      "wss://example.test/generator-body",
      "wss://example.test/implicit-await",
      "wss://example.test/import-alias",
      "wss://example.test/import-equals-member",
      "wss://example.test/import-source",
      "wss://example.test/iterable-body",
      "wss://example.test/iterable-continuation",
      "wss://example.test/logical-assignment",
      "wss://example.test/loop-continuation",
      "wss://example.test/member-await",
      "wss://example.test/nested-write",
      "wss://example.test/object-continuation",
      "wss://example.test/object-key",
      "wss://example.test/optional-argument",
      "wss://example.test/optional-call",
      "wss://example.test/optional-capture",
      "wss://example.test/optional-wrapper",
      "wss://example.test/pattern-await",
      "wss://example.test/pending-initialized",
      "wss://example.test/phase-accessor",
      "wss://example.test/phase-finally",
      "wss://example.test/phase-jsx",
      "wss://example.test/phase-label",
      "wss://example.test/phase-projection",
      "wss://example.test/rebound-import",
      "wss://example.test/review-capture",
      "wss://example.test/review-caught",
      "wss://example.test/review-label",
      "wss://example.test/review-nested-loop",
      "wss://example.test/review-pattern",
      "wss://example.test/selected-branch",
      "wss://example.test/selected-stored",
      "wss://example.test/sequence-capture",
      "wss://example.test/skipped-wait",
      "wss://example.test/switch-await",
      "wss://example.test/tag-generator",
      "wss://example.test/template-continuation",
      "wss://example.test/try-await",
      "wss://example.test/unawaited-wrapper",
      "wss://example.test/update-await",
      "wss://example.test/update-operand",
      "wss://example.test/wrapped-array",
      "wss://example.test/ws-self",
    ]);
    for (const [path, source, line] of socketExecutionPhaseLocations) {
      const observation = observations.find(
        ({ properties }) => properties.value === `wss://example.test/${path}`,
      );
      expect(observation?.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        confidence: "exact",
        location: {
          available: true,
          value: { kind: "source-range", source, start: { line } },
        },
      });
    }
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps CommonJS socket member writes separate from earlier constructor captures", async () => {
  const root = await createTestTempDirectory("rea-js-socket-member-writes-");
  const fixtures = {
    "replaced.js":
      'const ws = require("ws"); ws.WebSocket = class {}; new ws.WebSocket("wss://example.test/replaced");',
    "aliased.js":
      'const ws = require("ws"); const alias = ws; alias.WebSocket = class {}; new ws.WebSocket("wss://example.test/aliased");',
    "repeated.js":
      'require("ws").WebSocket = class {}; const ws = require("ws"); new ws.WebSocket("wss://example.test/repeated");',
    "captured.js":
      'const ws = require("ws"); const Socket = ws.WebSocket; ws.WebSocket = class {};\nnew Socket("wss://example.test/captured-before-write");',
    "loop-capture.js":
      'const ws = require("ws"); const Socket = ws.WebSocket; for (const item of items) { ws.WebSocket = class {}; }\nnew Socket("wss://example.test/loop-captured");',
    "sibling.js":
      'const ws = require("ws"); ws.Server = class {};\nnew ws.WebSocket("wss://example.test/unchanged-sibling");',
  };
  for (const [path, source] of Object.entries(fixtures))
    await writeFile(join(root, path), source);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      analyzeJavaScriptArtifactFiles(files),
    );
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations);
    expect(
      observations.map(({ properties }) => properties.value).sort(),
    ).toEqual([
      "wss://example.test/captured-before-write",
      "wss://example.test/loop-captured",
      "wss://example.test/unchanged-sibling",
    ]);
    for (const [value, source] of [
      ["captured-before-write", "captured.js"],
      ["loop-captured", "loop-capture.js"],
      ["unchanged-sibling", "sibling.js"],
    ]) {
      const observation = observations.find(
        ({ properties }) => properties.value === `wss://example.test/${value}`,
      );
      expect(observation?.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        confidence: "exact",
        location: {
          available: true,
          value: { kind: "source-range", source, start: { line: 2 } },
        },
      });
    }
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps ambiguous endpoint candidates inferred through artifact graph projection", async () => {
  const root = await createTestTempDirectory("rea-js-endpoint-certainty-");
  await writeFile(join(root, "app.js"), 'form.get("shared"); fetch("shared");');
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    const candidate = endpoints.find(({ observations }) =>
      observations.some(
        ({ properties }) => properties.interpretation === "candidate",
      ),
    );
    const observed = endpoints.find(({ observations }) =>
      observations.some(
        ({ properties }) =>
          properties.value === "shared" &&
          properties.interpretation === undefined,
      ),
    );

    expect(candidate).toBeDefined();
    expect(observed).toBeDefined();
    expect(candidate?.node_id).not.toBe(observed?.node_id);
    const candidateObservation = candidate?.observations[0];
    expect(candidateObservation?.properties).toMatchObject({
      value: "shared",
      interpretation: "candidate",
    });
    expect(candidateObservation?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
      confidence: "low",
      location: {
        available: true,
        value: { kind: "source-range", source: "app.js" },
      },
    });
    expect(candidateObservation?.evidence.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("only a candidate")]),
    );
    expect(observed?.observations[0]?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
    });
    const candidateEdge = graph.edges.find(
      ({ target_node_id }) => target_node_id === candidate?.node_id,
    );
    expect(candidateEdge?.properties.interpretation).toBe("candidate");
    expect(candidateEdge?.evidence).toMatchObject({
      state: "inferred",
      confidence: "low",
    });
    expect(candidateEdge?.evidence.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("only a candidate")]),
    );
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves partial and exact endpoint identity through graph projection", async () => {
  const root = await createTestTempDirectory(
    "rea-js-endpoint-partial-identity-",
  );
  await writeFile(
    join(root, "app.js"),
    'fetch(target); fetch("target"); function other(target) { fetch(target); }',
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    const partialNodes = endpoints.filter(({ observations }) =>
      observations.some(
        ({ properties }) => properties.resolution === "partial",
      ),
    );
    const partial = partialNodes[0];
    const exact = endpoints.find(({ observations }) =>
      observations.some(
        ({ properties }) =>
          properties.value === "target" && properties.resolution === undefined,
      ),
    );

    expect(partialNodes).toHaveLength(2);
    expect(new Set(partialNodes.map(({ node_id }) => node_id)).size).toBe(2);
    expect(exact).toBeDefined();
    expect(partial?.node_id).not.toBe(exact?.node_id);
    expect(partial?.observations[0]).toMatchObject({
      properties: {
        endpoint_kind: "network",
        value: "target",
        mechanism: "call:fetch",
        resolution: "partial",
      },
      evidence: {
        authority: "ast-static-analysis",
        state: "observed",
        limitations: [expect.stringContaining("not an exact literal")],
      },
    });
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

const completedWriteAndConsumerSources = [
  {
    file: "r64-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{new connect()}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-1.js",
    source:
      'async function connect(){new Socket("wss://example.test/review-latest")}try{new connect()}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-2.js",
    source:
      'function* connect(){new Socket("wss://example.test/review-latest")}try{new connect()}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-3.js",
    source:
      'function connect(){new Socket("wss://example.test/review-latest")}try{new connect()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r64-4.js",
    source:
      'const connect=(()=>new Socket("wss://example.test/review-latest")).bind(null);try{new connect()}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-5.js",
    source:
      'const connect=(function(){new Socket("wss://example.test/review-latest")}).bind(null);try{new connect()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r64-6.js",
    source:
      'function connect(){new Socket("wss://example.test/review-latest")}try{new connect.call(null)}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-7.js",
    source:
      'function connect(){new Socket("wss://example.test/review-latest")}try{new connect.apply(null,[])}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-8.js",
    source:
      'try{new (()=>new Socket("wss://example.test/review-latest"))()}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-9.js",
    source:
      'try{new (function(){new Socket("wss://example.test/review-latest")}).call(null)}catch{}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-10.js",
    source:
      'const invoke=run=>{try{new run()}catch{}};invoke(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r64-11.js",
    source:
      "export {};Object.prototype.with=null;const{WebSocket:Socket}=await import('ws',{set with(value){}});new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r64-12.js",
    source:
      "export {};Object.prototype.with=null;const options={with:null,set with(value){}};const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r64-13.js",
    source:
      "export {};const{WebSocket:Socket}=await import('ws',{get with(){return null},set with(value){}});new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r64-14.js",
    source:
      "export {};const{WebSocket:Socket}=await import('ws',{set with(value){},with:null});new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r63-extra-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect(...null)}catch{}const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r63-extra-1.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r63-extra-2.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};try{new Client()}catch{}try{new Client()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-extra-3.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};const Socket=globalThis.WebSocket;new Client();new Client();',
    present: true,
  },
  {
    file: "r63-extra-4.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};try{new Client()}catch{}const Socket=globalThis.WebSocket;new Client();',
    present: true,
  },
  {
    file: "r63-extra-5.js",
    source:
      'const invoke=run=>run();invoke.apply(null,[()=>new Socket("wss://example.test/review-latest")]);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-extra-6.js",
    source:
      'const invoke=run=>run();invoke.call=()=>{};invoke.call(null,()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r63-extra-7.js",
    source:
      'const invoke=(ignored,run)=>run();invoke.bind(null,0)(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r63-extra-8.js",
    source:
      "export{};Object.setPrototypeOf(Function.prototype,{with:null});const{WebSocket:Socket}=await import('ws',()=>{});new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r63-extra-9.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}finally{0}const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r63-extra-10.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}finally{throw 0}const Socket=globalThis.WebSocket;connect();',
    present: false,
  },
  {
    file: "r63-extra-11.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}throw 0;const Socket=globalThis.WebSocket;connect();',
    present: false,
  },
  {
    file: "r63-extra-12.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}connect();const Socket=globalThis.WebSocket;connect();',
    present: false,
  },
  {
    file: "r63-extra-13.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{const ignored=0}const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r63-extra-14.js",
    source:
      '(async()=>{for(const[x=await 0]of(function*(){yield null;yield[];new Socket("wss://example.test/review-latest")})()){}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-extra-15.js",
    source:
      '(async()=>{for(const[x=await 0]of(function*(){yield[];yield null;new Socket("wss://example.test/review-latest")})()){}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect(null.value)}catch{}const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r63-1.js",
    source:
      'function connect(){new Socket("wss://example.test/review-latest")}try{new connect(null.value)}catch{}const Socket=globalThis.WebSocket;new connect();',
    present: true,
  },
  {
    file: "r63-2.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect`${null.value}`}catch{}const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r63-3.js",
    source:
      '(new(class{static effect=(this.prototype.run=()=>{});run(){new Socket("wss://example.test/review-latest")}})()).run();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r63-4.js",
    source:
      '(new(class{run(){new Socket("wss://example.test/review-latest")}})()).run();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-5.js",
    source:
      '(new(class{static effect=1;run(){new Socket("wss://example.test/review-latest")}})()).run();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-6.js",
    source:
      '(async()=>{for(const[x=await 0]of(function*(){yield[];yield[1];new Socket("wss://example.test/review-latest")})()){}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r63-7.js",
    source:
      '(async()=>{for(const[x=await 0]of(function*(){yield[1];yield[];new Socket("wss://example.test/review-latest")})()){}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r63-8.js",
    source:
      '(async()=>{for(const[x=await 0]of(function*(){yield[1];yield[2];new Socket("wss://example.test/review-latest")})()){}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-9.js",
    source:
      "export{};Function.prototype.__proto__={with:null};const options=()=>{};const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r63-10.js",
    source:
      "export{};Array.prototype.__proto__={with:null};const{WebSocket:Socket}=await import('ws',[]);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r63-11.js",
    source:
      "export{};const{WebSocket:Socket}=await import('ws',()=>{});Function.prototype.__proto__={with:null};new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r63-12.js",
    source:
      "export{};Array.prototype.__proto__={with:null};const{WebSocket:Socket}=await import('ws',()=>{});new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r63-13.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};new Client();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-14.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};const Socket=globalThis.WebSocket;new Client();',
    present: true,
  },
  {
    file: "r63-15.js",
    source:
      'class Client{socket=new Socket("wss://example.test/review-latest")}new Client();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-16.js",
    source:
      'const Client=class{constructor(){new Socket("wss://example.test/review-latest")}};new Client();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-17.js",
    source:
      'const Client=class{socket=new Socket("wss://example.test/review-latest")};const Alias=Client;new Alias();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-18.js",
    source:
      'const invoke=run=>run();invoke(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-19.js",
    source:
      'const invoke=run=>run();const Socket=globalThis.WebSocket;invoke(()=>new Socket("wss://example.test/review-latest"));',
    present: true,
  },
  {
    file: "r63-20.js",
    source:
      'const invoke=run=>run();invoke.call(null,()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-21.js",
    source:
      'const invoke=run=>run();const alias=invoke;alias(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-22.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r63-23.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect();const Socket=globalThis.WebSocket;connect();',
    present: false,
  },
  {
    file: "r63-24.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-25.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{}try{connect()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r63-26.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect()}catch{throw 0}const Socket=globalThis.WebSocket;connect();',
    present: false,
  },
  {
    file: "r62-21.js",
    source:
      'const values=[];values[Symbol.asyncIterator]=()=>{throw 0};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for await(const y of values){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-22.js",
    source:
      'const values=[];Object.defineProperty(values,Symbol.asyncIterator,{get(){throw 0}});(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for await(const y of values){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-20.js",
    source:
      'Number.prototype[Symbol.iterator]=function*(){throw 0};(async()=>{const[[x],y=await 0]=(function*(){try{yield 1;yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-0.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){for await(const y of[]){}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r62-1.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){for await(const y of[1]){}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r62-2.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for await(const y of null){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-3.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for await(const y of{[Symbol.asyncIterator](){throw 0}}){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-4.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for await(const y of null.x){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-5.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){if(false){for await(const y of[]){}}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-6.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for await(const y of(await 0,null)){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r62-7.js",
    source:
      '(async()=>{const[[...{0:x=await 0}],next]=(function*(){yield[];new Socket("wss://example.test/review-latest");yield 1})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r62-8.js",
    source:
      '(async()=>{const[[first,...{0:x=await 0}],next]=(function*(){yield[1];new Socket("wss://example.test/review-latest");yield 1})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r62-9.js",
    source:
      '(async()=>{const[[first,...{0:x=await 0}],next]=(function*(){yield[1,2];new Socket("wss://example.test/review-latest");yield 1})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-10.js",
    source:
      '(async()=>{const[[...{1:x=await 0}],next]=(function*(){yield[2];new Socket("wss://example.test/review-latest");yield 1})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r62-11.js",
    source:
      '(async()=>{const[[...{length:x=await 0}],next]=(function*(){yield[];new Socket("wss://example.test/review-latest");yield 1})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-12.js",
    source:
      'Array.prototype[0]=7;(async()=>{const[[...{0:x=await 0}],next]=(function*(){yield[];new Socket("wss://example.test/review-latest");yield 1})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r62-13.js",
    source:
      "export{};const options=()=>{};options.__proto__={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r62-14.js",
    source:
      "export{};const options=()=>{};const alias=options;alias.__proto__={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r62-15.js",
    source:
      "export{};function options(){}options.__proto__={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r62-16.js",
    source:
      "export{};const options=()=>{};const{WebSocket:Socket}=await import('ws',options);options.__proto__={with:null};new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r62-17.js",
    source:
      "export{};const options=()=>{};options.extra=null;const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r62-18.js",
    source:
      "export{};function options(){}options.prototype={with:null};const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "r62-19.js",
    source:
      "export{};const options=()=>{};options.with=null;const{WebSocket:Socket}=await import('ws',options);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "r61-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect``;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-1.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const Socket=globalThis.WebSocket;connect``;',
    present: true,
  },
  {
    file: "r61-2.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const tag=connect;tag``;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-3.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const tag=connect.bind(null);tag``;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-4.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");function run(){connect``}run();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-5.js",
    source:
      'const connect=async()=>{await 0;new Socket("wss://example.test/review-latest")};connect``;const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r61-6.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{tag``}catch{}const tag=connect;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r61-7.js",
    source:
      '(async()=>{const connect=()=>new Socket("wss://example.test/review-latest");connect`${await 0}`;})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r61-8.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){while(await 0){}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r61-9.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){for(;await 0;){}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r61-10.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){for(await 0;false;){}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r61-11.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){while(false){await 0}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-12.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){for(;false;await 0){}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-13.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{for(null.x;await 0;){}}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-14.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){if(globalThis.flag){while(await 0){}}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r61-15.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){do{continue}while(await 0)}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r61-16.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){do{break}while(await 0)}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-23.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{alias()}catch{}var alias=connect;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r60-24.js",
    source:
      '(async()=>{const[{...copy},next=await 0,last]=(function*(){yield{get x(){return undefined}};yield undefined;new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{alias()}catch{}const alias=connect;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r60-1.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const first=connect;try{alias()}catch{}const alias=first;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r60-2.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{alias.call(null)}catch{}const alias=connect;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r60-3.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{alias.bind(null)()}catch{}const alias=connect;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r60-4.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const alias=connect;try{alias()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-5.js",
    source:
      'try{connect()}catch{}function connect(){new Socket("wss://example.test/review-latest")}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-6.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");function run(){try{alias()}catch{}}run();const alias=connect;const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r60-7.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const alias=connect;function run(){alias()}try{run()}catch{}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-8.js",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return undefined;}};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-9.js",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return void 0;}};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-10.js",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return 0;}};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-11.js",
    source:
      '((undefined)=>{(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return undefined;}};new Socket("wss://example.test/review-latest");yield 1;})();})();})(0);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-12.js",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){throw 0;}};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-13.js",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return (null.value,undefined);}};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-14.js",
    source:
      '(async()=>{const [{x=await 0},next]=(function*(){yield {get x(){return;}};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-15.js",
    source:
      '(async()=>{try{if(true){await 0}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-16.js",
    source:
      '(async()=>{try{if(false){}else{await 0}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-17.js",
    source:
      '(async()=>{try{if(false){await 0}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-18.js",
    source:
      '(async()=>{try{if(globalThis.flag){await 0}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-19.js",
    source:
      '(async()=>{try{if(true){null.value;await 0}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r60-20.js",
    source:
      '(async()=>{try{if(true){if(false){}else{await 0}}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-21.js",
    source:
      '(async()=>{try{true?await 0:0}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r60-22.js",
    source:
      '(async()=>{try{true&&await 0}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r59-0.js",
    source:
      'Function.prototype.call=()=>{};(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-latest");yield 0;})());const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r59-1.js",
    source:
      'Function.prototype.apply=()=>{};(function([x]){}).apply(null,[(function*(){new Socket("wss://example.test/review-latest");yield 0;})()]);const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r59-3.js",
    source:
      '(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-latest");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r59-4.js",
    source:
      '(function([x]){}).apply(null,[(function*(){new Socket("wss://example.test/review-latest");yield 0;})()]);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r59-6.js",
    source:
      'try{(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-latest");yield 0;})())}catch{}Function.prototype.call=()=>{};const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r59-7.js",
    source:
      'Function.prototype.apply=()=>{};(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-latest");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r59-8.js",
    source:
      'Function.prototype.call=()=>{};const values=(function*(){new Socket("wss://example.test/review-latest");yield 0;})();(function([x]){}).call(null,values);const Socket=globalThis.WebSocket;values.next();',
    present: true,
  },
  {
    file: "r59-9.js",
    source:
      'Function.prototype.call=()=>{};class C{[(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-latest");yield 0;})())](){}}const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r59-10.js",
    source:
      'class C{[(function([x]){}).call(null,(function*(){new Socket("wss://example.test/review-latest");yield 0;})())](){}}const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-16.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const bound=connect.bind(null);bound.call=()=>{};bound.call(null);const Socket=globalThis.WebSocket;bound();',
    present: true,
  },
  {
    file: "r58-17.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.call=()=>{};const bound=connect.bind(null);bound.call(null);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-14.js",
    source:
      'Function.prototype.call=()=>{};(()=>new Socket("wss://example.test/review-latest")).call(null);const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r58-15.js",
    source:
      'Function.prototype.bind=()=>()=>{};(()=>new Socket("wss://example.test/review-latest")).bind(null)();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r58-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.call=()=>{};connect.call(null);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-1.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.apply=()=>{};connect.apply(null,[]);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-2.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.bind=()=>()=>{};connect.bind(null)();const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-3.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const alias=connect;alias.call=()=>{};connect.call(null);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-4.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.apply=()=>{};connect.call(null);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-5.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.label=0;connect.call(null);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-6.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{connect.call(null)}catch{}connect.call=()=>{};const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-7.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");Function.prototype.call=()=>{};connect.call(null);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-8.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");Function.prototype.apply=()=>{};connect.apply(null,[]);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-9.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");Function.prototype.bind=()=>()=>{};connect.bind(null)();const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-10.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const bound=connect.bind(null);connect.bind=()=>()=>{};bound();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-11.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.call=()=>{};((run)=>run.call(null))(connect);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r58-12.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");try{((run)=>run.call(null))(connect)}catch{}connect.call=()=>{};const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r58-13.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const alias=connect;function change(value){value.call=()=>{}}change(alias);connect.call(null);const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r57-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.call(null);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-1.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.apply(null,[]);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-2.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const Socket=globalThis.WebSocket;connect.call(null);',
    present: true,
  },
  {
    file: "r57-3.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const Socket=globalThis.WebSocket;connect.apply(null,[]);',
    present: true,
  },
  {
    file: "r57-4.js",
    source:
      'const connect=(0,()=>new Socket("wss://example.test/review-latest"));const alias=connect;alias["call"](null);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-5.js",
    source:
      '((run)=>run.call(null))(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-6.js",
    source:
      '((run)=>run.apply(null,[]))(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-7.js",
    source:
      '(async(run)=>{await 0;run.call(null)})(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r57-8.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.bind(null);const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r57-9.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect.bind(null)();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-10.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const bound=connect.bind(null);bound();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-11.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const bound=connect.bind(null);const Socket=globalThis.WebSocket;bound();',
    present: true,
  },
  {
    file: "r57-12.js",
    source:
      '((run)=>run.bind(null)())(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r57-13.js",
    source:
      '((run)=>run.bind(null))(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r56-0.js",
    source:
      'const connect=(0,()=>new Socket("wss://example.test/review-latest"));connect();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r56-1.js",
    source:
      'const connect=(0,()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r56-2.js",
    source:
      'const connect=true?()=>new Socket("wss://example.test/review-latest"):()=>{};connect();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r56-3.js",
    source:
      'export {};const wrapped=(async()=>import("ws"))();wrapped.constructor={};wrapped.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r56-4.js",
    source:
      'export {};const wrapped=(async()=>import("ws"))();const alias=wrapped;wrapped.constructor={};wrapped.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r56-5.js",
    source:
      'export {};const wrapped=(async()=>import("ws"))();wrapped.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r56-6.js",
    source:
      'export {};const wrapped=(async()=>import("ws"))();const{WebSocket:Socket}=await wrapped;wrapped.constructor={};wrapped.then=resolve=>resolve({WebSocket:class{}});new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r56-7.js",
    source:
      'export {};const{WebSocket:Socket}=await(async()=>import("ws"))();Promise.prototype.then=resolve=>resolve({WebSocket:class{}});new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r56-8.js",
    source:
      'export {};Promise.prototype.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>import("ws"))();new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r56-9.js",
    source:
      'export {};const pending=import("ws");const wrapped=(async()=>pending)();pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r56-10.js",
    source:
      'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const wrapped=(async()=>pending)();const{WebSocket:Socket}=await wrapped;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r56-11.js",
    source:
      'export {};const pending=import("ws");const wrapped=(async()=>pending)();Promise.prototype.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await wrapped;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r56-12.js",
    source:
      '((run)=>run())(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r56-13.js",
    source:
      'const Socket=globalThis.WebSocket;((run)=>run())(()=>new Socket("wss://example.test/review-latest"));',
    present: true,
  },
  {
    file: "r56-14.js",
    source:
      '((run)=>run()).call(null,()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r56-15.js",
    source:
      '((run)=>run()).apply(null,[()=>new Socket("wss://example.test/review-latest")]);const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r56-16.js",
    source:
      '(async(run)=>{await 0;run()})(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r56-17.js",
    source:
      '(async(run)=>{if(false)await 0;run()})(()=>new Socket("wss://example.test/review-latest"));const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r55-0.js",
    source:
      'export {};const pending=import("ws");const{WebSocket:Socket}=await(async()=>pending)();pending.then=resolve=>resolve({WebSocket:class{}});new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r55-1.js",
    source:
      'export {};const pending=import("ws");const alias=pending;const{WebSocket:Socket}=await(async()=>alias)();pending.then=resolve=>resolve({WebSocket:class{}});new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r55-2.js",
    source:
      'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>pending)();new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r55-3.js",
    source:
      'export {};const pending=import("ws");const{WebSocket:Socket}=await(async()=>pending)();pending.__proto__={then(resolve){resolve({WebSocket:class{}})}};new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r55-4.js",
    source:
      'export {};const pending=import("ws");pending.__proto__={then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await(async()=>pending)();new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r55-5.ts",
    source:
      'function connect(){new ws.WebSocket("wss://example.test/review-latest")}import ws=require("ws");connect();',
    present: true,
  },
  {
    file: "r55-6.ts",
    source:
      'function connect(){new ws.WebSocket("wss://example.test/review-latest")}connect();import ws=require("ws");',
    present: false,
  },
  {
    file: "r55-7.ts",
    source:
      'function connect(){new ws.WebSocket("wss://example.test/review-latest")}function outer(){connect()}import ws=require("ws");outer();',
    present: true,
  },
  {
    file: "r55-8.ts",
    source:
      'function connect(){new ws.WebSocket("wss://example.test/review-latest")}function outer(){connect()}outer();import ws=require("ws");',
    present: false,
  },
  {
    file: "r55-9.ts",
    source:
      'function connect(){new ws.WebSocket("wss://example.test/review-latest")}import ws=require("ws");',
    present: true,
  },
  {
    file: "r55-10.js",
    source:
      'function mayThrow(){throw 0}(async()=>{try{await using r={[void mayThrow()](){},[Symbol.asyncDispose](){}}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r55-11.js",
    source:
      '(async()=>{try{await using r={[void 0](){},[Symbol.asyncDispose](){}}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r55-12.js",
    source:
      'function mayThrow(){throw 0}(async()=>{try{await using r={[void mayThrow()]:0,[Symbol.asyncDispose](){}}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r55-13.js",
    source:
      'function mayThrow(){throw 0}(async()=>{try{await using first=null;await using r={[void mayThrow()](){},[Symbol.asyncDispose](){}}}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r54-0.js",
    source:
      'export {};const pending=import("ws");const alias=pending;pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r54-1.js",
    source:
      'export {};const pending=import("ws");const alias=pending;const copied=alias;pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await copied;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r54-2.js",
    source:
      'export {};const pending=import("ws");const alias=pending;const writer=pending;writer.constructor={};writer.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r54-3.js",
    source:
      'export {};const pending=import("ws");const alias=pending;pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r54-4.js",
    source:
      'export {};const pending=import("ws");const alias=pending;function change(value){value.constructor={};value.then=resolve=>resolve({WebSocket:class{}})}change(pending);const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r54-5.js",
    source:
      'export {};const pending=import("ws");const alias=pending;pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r54-6.js",
    source:
      'export {};const pending=import("ws");const alias=pending;const other=import("ws");other.constructor={};other.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await alias;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r54-7.js",
    source:
      'export {};const pending=import("ws");const alias=pending;const{WebSocket:Socket}=await alias;pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r53-0.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set run(value){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-1.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set run(value){throw 0}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-2.js",
    source:
      "(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set ['run'](value){}};yield undefined;}finally{new Socket(\"wss://example.test/review-latest\")}})()})();const Socket=globalThis.WebSocket;",
    present: true,
  },
  {
    file: "r53-3.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run:1,set run(value){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-4.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get run(){throw 0},run:1,set run(value){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-5.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get run(){throw 0},set run(value){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r53-6.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {set run(value){},get run(){throw 0}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r53-7.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {__proto__:{get run(){throw 0}},set run(value){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-8.js",
    source:
      '(async()=>{const[{...rest},next=0]=(function*(){try{yield {set run(value){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r53-9.js",
    source:
      '(async()=>{const[{run=await 0}]=(function*(){try{yield {set run(value){throw 0}}}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-10.js",
    source:
      'const fail=false;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?1:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-11.js",
    source:
      'let fail=true;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?1:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-12.js",
    source:
      'const fail=false;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?(fail?1:2):(fail?3:4),await 0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r53-13.js",
    source:
      'const fail=true;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?null.value:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r53-14.js",
    source:
      'const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?1:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;const fail=false;',
    present: false,
  },
  {
    file: "r53-15.js",
    source:
      'const fail=false;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?1:0,0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-0.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(null.value){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r52-1.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(null){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r52-2.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(void 0){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r52-3.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(void(await 0)){}}catch{continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r52-4.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with({}){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-5.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(0){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-6.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with((function(){})){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-7.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with((class{})){}}catch{await 0;continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-8.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(null.value){await 0;continue;}}catch{}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-9.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(null){await 0;continue;}}catch{}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r52-10.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with({}){await 0;continue;}}catch{}break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r52-11.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{with(null.value){}}catch{continue;}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r51-0.js",
    source:
      'export {};const pending=import("ws");pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r51-1.js",
    source:
      'export {};const pending=import("ws");const alias=pending;alias.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r51-2.js",
    source:
      'export {};const pending=import("ws");Object.setPrototypeOf(pending,{constructor:{},then(resolve){resolve({WebSocket:class{}})}});const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r51-3.js",
    source:
      'export {};const pending=import("ws");const{WebSocket:Socket}=await pending;pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r51-4.js",
    source:
      'export {};const pending=import("ws");const other=import("ws");other.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r51-5.js",
    source:
      'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r51-6.js",
    source:
      'export {};const pending=import("ws");pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await(async()=>pending)();new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r51-7.js",
    source:
      'export {};const pending=import("ws");pending.__proto__={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await(async()=>await pending)();new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r51-8.js",
    source:
      'export {};const pending=import("ws");const{WebSocket:Socket}=await(async()=>pending)();new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r51-9.js",
    source:
      'export {};const pending=import("ws");pending.note={constructor:{},then(resolve){resolve({WebSocket:class{}})}};const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r51-10.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run(){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r51-11.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {async run(){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r51-12.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {*run(){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r51-13.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run(){throw 0}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r51-14.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {run(){},get run(){throw 0}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r51-15.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get run(){throw 0},run(){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r51-16.js",
    source:
      '(async()=>{const[{...rest},next=await 0]=(function*(){try{yield {get fail(){throw 0},run(){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r51-17.js",
    source:
      '(async()=>{const[{...rest},next=0]=(function*(){try{yield {run(){}};yield undefined;}finally{new Socket("wss://example.test/review-latest")}})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r50-23.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const invoke=()=>{connect();connect()};const twice=()=>{invoke();invoke()};const Socket=globalThis.WebSocket;twice();twice();',
    present: true,
  },
  {
    file: "r50-24.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const invoke=()=>{connect();connect()};const twice=()=>{invoke();invoke()};twice();const Socket=globalThis.WebSocket;twice();',
    present: false,
  },
  {
    file: "r50-0.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const Socket=globalThis.WebSocket;connect();connect();',
    present: true,
  },
  {
    file: "r50-1.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect();connect();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r50-2.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect();const Socket=globalThis.WebSocket;connect();',
    present: false,
  },
  {
    file: "r50-3.js",
    source:
      'const connect=()=>{const Socket=globalThis.WebSocket;new Socket("wss://example.test/review-latest")};connect();connect();',
    present: true,
  },
  {
    file: "r50-4.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const alias=connect;const Socket=globalThis.WebSocket;alias();connect();',
    present: true,
  },
  {
    file: "r50-5.js",
    source:
      'const connect=async()=>{await 0;new Socket("wss://example.test/review-latest")};connect();connect();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-6.js",
    source:
      '(async()=>{const connect=async()=>{await 0;new Socket("wss://example.test/review-latest")};await connect();await connect();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    file: "r50-7.js",
    source:
      'const connect=()=>{const Socket=globalThis.WebSocket;new Socket("wss://example.test/review-latest")};const invoke=()=>connect();invoke();invoke();',
    present: true,
  },
  {
    file: "r50-8.js",
    source:
      'const fail=true;const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(fail?null.value:0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r50-9.js",
    source:
      'const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(0,await 0)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-10.js",
    source:
      'const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{consume?.(await 0,null.value)}catch{}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-11.js",
    source:
      'const fail=true;const receiver={};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{receiver?.[(fail?null.value:0,await 0)]}catch{}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r50-12.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using first={[Symbol.asyncDispose](){throw 0}},second={[Symbol.asyncDispose](){return 0}};}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-13.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using first={[Symbol.asyncDispose](){return 0}},second={[Symbol.asyncDispose](){throw 0}};}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-14.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using first={[Symbol.asyncDispose](){throw 0}};await using second={[Symbol.asyncDispose](){return 0}};}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-15.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using first={[Symbol.asyncDispose](){throw 0}},second={[Symbol.asyncDispose](){return 0}},third=null.value;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r50-16.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using first={[Symbol.asyncDispose](){throw 0}},second=null.value,third={[Symbol.asyncDispose](){return 0}};}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r50-17.js",
    source:
      'const{missing:{x},WebSocket:Socket}={missing:null,WebSocket:globalThis.WebSocket};new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r50-18.js",
    source:
      'const{missing:{x},WebSocket:Socket}={missing:{},WebSocket:globalThis.WebSocket};new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r50-19.js",
    source:
      'const[ [x],Socket]=[null,globalThis.WebSocket];new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r50-20.js",
    source:
      'const{missing:x=(+1n),WebSocket:Socket}={missing:void 0,WebSocket:globalThis.WebSocket};new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r50-21.js",
    source:
      'const{[(+1n)]:x,WebSocket:Socket}={WebSocket:globalThis.WebSocket};new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r50-22.js",
    source:
      'const{missing:x=0,WebSocket:Socket}={missing:void 0,WebSocket:globalThis.WebSocket};new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r49-disposer-async-generator.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={async *[Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-disposer-0.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={[Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-disposer-1.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={*[Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-disposer-2.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={async [Symbol.asyncDispose](x=null.value){}};}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-disposer-3.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={[Symbol.asyncDispose](x=0){return 0}};break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-0.mjs",
    source:
      'export {};const pending=import("ws");pending.constructor={};pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r49-1.mjs",
    source:
      'export {};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r49-2.mjs",
    source:
      'export {};const pending=import("ws");const{WebSocket:Socket}=await pending;pending.constructor={};new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r49-3.mjs",
    source:
      'export {};Promise.prototype.constructor={};const pending=import("ws");pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await pending;new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r49-4.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){const{[await 0]:y}=null.value;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-5.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){const{[await 0]:y}={};break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-6.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){do{null.value;}while(await 0);}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-7.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){do{0;}while(await 0);break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-8.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{throw{__proto__:null}}catch({[await 0]:y}){}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-9.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{throw{__proto__:null}}catch({x}){}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-10.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){try{throw null}catch({[await 0]:y}){}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-11.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={[Symbol.asyncDispose](){throw 0}};}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-12.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={[Symbol.asyncDispose](){return 0}};break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-13.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={[Symbol.asyncDispose]:async()=>{throw 0}};}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-14.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0;}finally{new Socket("wss://example.test/review-latest")}})()){await using resource={[Symbol.dispose](){throw 0}};}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-15.js",
    source:
      'const ws=require("ws");mutate(ws);new ws.WebSocket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r49-16.js",
    source:
      'const ws=require("ws");const Socket=ws.WebSocket;mutate(ws);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r49-17.js",
    source:
      'const ws=require("ws");new ws.WebSocket("wss://example.test/review-latest");mutate(ws);',
    present: true,
  },
  {
    file: "r49-18.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){if(false)await 0;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-19.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){await 0;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-20.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");connect();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-21.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const Socket=globalThis.WebSocket;connect();',
    present: true,
  },
  {
    file: "r49-22.js",
    source:
      'const connect=()=>new Socket("wss://example.test/review-latest");const alias=connect;alias();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r49-23.js",
    source:
      'const connect=async()=>{await 0;new Socket("wss://example.test/review-latest")};connect();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r49-24.js",
    source:
      '(async()=>{const connect=async()=>{await 0;new Socket("wss://example.test/review-latest")};await connect();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    file: "r45-0.js",
    source:
      '(async()=>{try{throw{get x(){throw 0}}}catch({x}){await 0}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r45-1.js",
    source:
      '(async()=>{try{throw{x:1}}catch({x}){await 0}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r45-2.js",
    source:
      '(async()=>{try{throw{get x(){throw 0}}}catch({[await 0]:a,x}){await 0}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r45-4.js",
    source:
      'const fixed=0;(async()=>{let x;for([fixed,x=await 0]of[[0,void 0]]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r45-5.js",
    source:
      'let fixed=0;(async()=>{let x;for([fixed,x=await 0]of[[0,void 0]]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r45-6.js",
    source:
      'const fixed=0;(async()=>{let x;for({a:fixed,b:x=await 0}of[{__proto__:null,a:0}]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r45-9.js",
    source:
      'const target={x:0};(async()=>{let x;for([target.x,x=await 0]of[[0,void 0]]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r45-10.js",
    source:
      'const target={set x(value){throw 0}};(async()=>{let x;for([target.x,x=await 0]of[[0,void 0]]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r45-11.js",
    source:
      '(async()=>{for(const[fixed,x=await 0]of[[0,void 0]]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r45-12.js",
    source:
      'const fixed=0;(async()=>{let x;for([x=await 0,fixed]of[[void 0,0]]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r44-0.ts",
    source:
      'const box={__proto__:null};const Socket=(box[(-1 as number)]=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r44-2.ts",
    source:
      'new (({__proto__:null})[(void null.x as undefined)]=globalThis.WebSocket)("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r44-3.js",
    source:
      '(async()=>{await 0;(0,null).x;new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r44-5.js",
    source:
      '(async()=>{await 0;(0,{}).x;new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r44-8.js",
    source:
      '(async()=>{const[{x=await 0},next]=(function*(){yield{__proto__:null};new Socket("wss://example.test/review-latest");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r44-9.js",
    source:
      '(async()=>{const[{x=await 0},next]=(function*(){yield{__proto__:null,x:1};new Socket("wss://example.test/review-latest");yield 1})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r44-12.js",
    source:
      '(async()=>{try{throw{}}catch({[await 0]:x}){}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r44-13.js",
    source:
      '(async()=>{try{throw{}}catch({[await 0]:x}){new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r44-15.js",
    source:
      '(async()=>{try{throw null}catch({[await 0]:x}){}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r44-16.js",
    source:
      '(async()=>{let x;for({[await 0]:x} of[{}]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r44-19.js",
    source:
      '(async()=>{let x;for({[await 0]:x} of[null]){new Socket("wss://example.test/review-latest");break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r44-20.js",
    source:
      '(async r=>{{await using a=r;}new Socket("wss://example.test/review-latest")})(null);const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r43-0.js",
    source:
      'const resource=null;(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){await 0;await using r=resource;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r43-1.js",
    source:
      'const resource=null;(async()=>{for await(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){await using r=resource;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r43-2.js",
    source:
      'new (({__proto__:null})[void null.x]=globalThis.WebSocket)("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "r43-3.js",
    source:
      'new (({__proto__:null})[void(()=>{})]=globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "r43-5.js",
    source:
      '(async()=>{const[a=await 0,b]=(function*(){yield void(()=>{});new Socket("wss://example.test/review-latest");yield 1;})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r43-8.js",
    source:
      '(async()=>{await 0;(1)();new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r43-12.js",
    source:
      '(async()=>{await 0;(1)(new Socket("wss://example.test/review-latest"))})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "r43-14.js",
    source:
      '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){return undefined}});new Socket("wss://example.test/review-latest")})();',
    present: true,
  },
  {
    file: "r43-17.js",
    source:
      '(async()=>{const{WebSocket:Socket}=await import("ws",{get with(){return void null.x}});new Socket("wss://example.test/review-latest")})();',
    present: false,
  },
  {
    file: "r43-19.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{class C{accessor x}}catch{await 0;continue}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r43-20.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{class C{static accessor x=0}}catch{await 0;continue}break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "r43-21.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{class C{static accessor x=null.x}}catch{await 0;continue}break;}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "failed-optional-member-receiver.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){null.value?.[await 0]}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "missing-resource-disposer.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){await using r={__proto__:null}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "unmatched-switch-body.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){switch(0){case 1:await 0}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "failed-class-decorator.js",
    source:
      '(async()=>{await 0;@(null.value) class C{};new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "optional-receiver-prior-cleanup-wait.js",
    source:
      '(async()=>{for(const x of(function*(){try{yield 0}finally{new Socket("wss://example.test/review-latest")}})()){(await 0,null.value)?.[await 0]}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "own-async-resource-disposer.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){await using r={__proto__:null,[Symbol.asyncDispose](){}}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "switch-test-wait-after-default.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){switch(0){default:break;case (await 0,1):break}}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "legacy-static-before-decorator.js",
    source:
      '(async()=>{await 0;@(null.value) class C{static value=new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "optional-call-consumer-wait.js",
    source:
      'const consume=()=>{};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){consume?.(await 0)}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "optional-member-consumer-wait.js",
    source:
      'const receiver={};(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){receiver?.[await 0]}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "logical-assignment-consumer-wait.js",
    source:
      '(async()=>{let value=0;for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){value||=await 0}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "failed-literal-projection.js",
    source:
      'const{WebSocket:Socket}={WebSocket:globalThis.WebSocket,broken:null.value};new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "failed-iterator-spread.js",
    source:
      '(async()=>{await 0;[...null];new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "failed-async-resource-initializer.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){await using r=null.value}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "void-false-catch.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{if(void 0)throw 0}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "undefined-import-options.js",
    source:
      '(async()=>{const{WebSocket:Socket}=await import("ws",undefined);new Socket("wss://example.test/review-latest")})();',
    present: true,
  },
  {
    file: "alias-import-options.js",
    source:
      '(async()=>{const options={};const{WebSocket:Socket}=await import("ws",options);new Socket("wss://example.test/review-latest")})();',
    present: true,
  },
  {
    file: "array-import-options.js",
    source:
      '(async()=>{const{WebSocket:Socket}=await import("ws",[]);new Socket("wss://example.test/review-latest")})();',
    present: true,
  },
  {
    file: "nonliteral-continuing-await.js",
    source:
      '(async()=>{for(let i=0;i<1;new Socket("wss://example.test/review-latest"),i++){await(()=>{});continue}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "prior-wait-cannot-bypass-failed-async-iterator-acquisition.js",
    source:
      '(async()=>{await 0;for await(const x of null){}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "rest-target-receiver-wait-cannot-bypass-throwing-copied-getter.js",
    source:
      '(async()=>{({...({before:await 0,set run(v){new Socket("wss://example.test/review-latest")}}).run}={get x(){throw 0}})})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "own-data-update-preserves-writable-slot.js",
    source:
      'const box={x:0};box.x++;const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "own-data-compound-write-preserves-writable-slot.js",
    source:
      'const box={x:0};box.x+=1;const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "structured-setter-receiver-finishes-wait.js",
    source:
      '(async()=>{[({before:await 0,set run(v){new Socket("wss://example.test/review-latest")}}).run]=[0]})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "structured-setter-receiver-failure-blocks-write.js",
    source:
      '(async()=>{[({before:(await 0,null.x),set run(v){new Socket("wss://example.test/review-latest")}}).run]=[0]})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "void-function-selects-mandatory-nullish-wait.js",
    source:
      '(async()=>{(void(()=>{}))??(await 0);new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "null-import-options-reject-module-origin.js",
    source:
      "(async()=>{const{WebSocket:Socket}=await import('ws',null);new Socket(\"wss://example.test/review-latest\")})();",
    present: false,
  },
  {
    file: "null-import-attributes-reject-module-origin.js",
    source:
      "(async()=>{const{WebSocket:Socket}=await import('ws',{with:null});new Socket(\"wss://example.test/review-latest\")})();",
    present: false,
  },
  {
    file: "empty-import-attributes-preserve-module-origin.js",
    source:
      "(async()=>{const{WebSocket:Socket}=await import('ws',{with:{}});new Socket(\"wss://example.test/review-latest\")})();",
    present: true,
  },
  {
    file: "for-await-failed-iterable-cannot-invent-suspension.js",
    source:
      '(async()=>{for await(const x of null.value){}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "for-await-plain-object-cannot-invent-suspension.js",
    source:
      '(async()=>{for await(const x of {}){}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "for-await-empty-array-completes-asynchronous-step.js",
    source:
      '(async()=>{for await(const x of []){}new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "false-consumer-branch-cannot-defer-next-step.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){if(false)await 0}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "true-consumer-branch-defers-next-step.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){if(true)await 0}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "failed-class-key-blocks-later-key-wait.js",
    source:
      '(async()=>{class C{static [null.x];static [await 0];static x=new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "failed-static-value-discards-earlier-key-wait.js",
    source:
      '(async()=>{class C{[await 0](){}static a=null.x;static c=new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completed-class-key-retains-static-wait.js",
    source:
      '(async()=>{class C{static [await 0];static x=new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "own-data-hides-replacement-prototype-setter.js",
    source:
      'const box={x:0};box.__proto__={set x(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "deleted-own-data-exposes-replacement-prototype-setter.js",
    source:
      'const box={x:0};delete box.x;box.__proto__={set x(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "failed-later-yield-retains-earlier-consumer-wait-in-cleanup.js",
    source:
      '(async()=>{const[a=await 0,b]=(function*(){try{yield undefined;yield(null.x,undefined)}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "failed-first-yield-has-no-earlier-cleanup-wait.js",
    source:
      '(async()=>{const[a=await 0,b]=(function*(){try{yield(null.x,undefined)}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "array-rest-checks-added-getter-with-original-index-excluded.js",
    source:
      "let array,value;(async()=>{({0:value=(await 0,Object.defineProperty(array,'extra',{enumerable:true,get(){throw 0}})),...({set run(v){new Socket(\"wss://example.test/review-latest\")}}).run}=(array=[undefined]))})();const Socket=globalThis.WebSocket;",
    present: false,
  },
  {
    file: "empty-object-rest-checks-added-getter.js",
    source:
      "let object,key;(async()=>{({[(await 0,Object.defineProperty(object,'extra',{enumerable:true,get(){throw 0}}),'absent')]:key,...({set run(v){new Socket(\"wss://example.test/review-latest\")}}).run}=(object={}))})();const Socket=globalThis.WebSocket;",
    present: false,
  },
  {
    file: "failed-await-operand-cannot-defer-branch.js",
    source:
      '(async()=>{if(await null.value)new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "failed-nested-await-operand-cannot-defer-branch.js",
    source:
      '(async()=>{if(await(await 0,null.value))new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "failed-await-operand-retains-earlier-wait-in-finally.js",
    source:
      '(async()=>{try{await(await 0,null.value)}finally{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "safe-class-declaration-cannot-enter-catch.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{class C{}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "throwing-class-heritage-stops-carried-wait.js",
    source:
      '(async()=>{await 0;class C extends null.value{};new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "dormant-class-instance-field-preserves-carried-wait.js",
    source:
      '(async()=>{await 0;class C{x=null.value};new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "void-literal-selects-nullish-wait.js",
    source:
      '(async()=>{(void 0)??(await 0);new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "failed-import-options-cannot-supply-export.js",
    source:
      "(async()=>{const{WebSocket:Socket}=await import('ws',null.value);new Socket(\"wss://example.test/review-latest\")})();",
    present: false,
  },
  {
    file: "completed-import-options-preserve-export.js",
    source:
      "(async()=>{const{WebSocket:Socket}=await import('ws',{});new Socket(\"wss://example.test/review-latest\")})();",
    present: true,
  },
  {
    file: "plain-nested-object-cannot-consume-iterator.js",
    source:
      '(async()=>{const[[x],y=await 0]=(function*(){try{yield {};yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "prototype-setter-failure.js",
    source:
      'const box={};box.__proto__={set x(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "prototype-other-setter.js",
    source:
      'const box={};box.__proto__={set y(v){throw 0}};const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "rest-array-copy.js",
    source:
      '(async()=>{const[{...rest},y=await 0]=(function*(){try{yield [0];yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "receiver-failure.js",
    source:
      '(async()=>{(-null.value)?.[await 0];new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "prefix-failure.js",
    source:
      '(async()=>{(await 0,null.x,new Socket("wss://example.test/review-latest"))})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "prefix-completed.js",
    source:
      '(async()=>{(await 0,1,new Socket("wss://example.test/review-latest"))})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "do-false-catch.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{do{}while(false)}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "yield-argument-failure.js",
    source:
      '(async()=>{const[x=await 0,next]=(function*(){yield(null.x,undefined);new Socket("wss://example.test/review-latest")})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "static-block-prefix.js",
    source:
      'new(class{static{}},globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "indexing-frozen-capture.js",
    source:
      "'use strict';const box={};Object.freeze(box);const Socket=(box.x=globalThis.WebSocket);new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "indexing-plain-capture.js",
    source:
      'const box={};const Socket=(box.x=globalThis.WebSocket);new Socket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "getter-empty-completion.js",
    source:
      '(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){}};yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "optional-bigint-failure.js",
    source:
      '(async()=>{(+1n)?.[await 0];new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "false-loop-catch.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{while(false){throw 0}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "bitwise-prefix.js",
    source: 'new(~1,globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "inline-member-capture.js",
    source:
      'new((({__proto__:null}).x=globalThis.WebSocket))("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "rest-throw-before-setter.js",
    source:
      '(async()=>{let x;({a:x=await 0,...({set run(v){new Socket("wss://example.test/review-latest")}}).run}={a:undefined,get b(){throw 0}})})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "rest-complete-before-setter.js",
    source:
      '(async()=>{let x;({a:x=await 0,...({set run(v){new Socket("wss://example.test/review-latest")}}).run}={a:undefined,get b(){}})})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-member-write.js",
    source:
      'const box={};(async()=>{let y;[box.x,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-null-prototype-write.js",
    source:
      'let next;const box={__proto__:null};(async()=>{[box.x=await 0,next]=(function*(){yield undefined;new Socket("wss://example.test/review-latest")})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-parameter-write.js",
    source:
      '(async(x)=>{let y;[x,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-unbraced-update.js",
    source:
      '(async()=>{for(let i=0;i<1;new Socket("wss://example.test/review-latest"),i++)await 0})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-continue-update.js",
    source:
      '(async()=>{for(let i=0;i<1;new Socket("wss://example.test/review-latest"),i++){await 0;continue}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-switch-catch.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{switch(null.value){}}catch{await 0;continue}break}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-unreachable-switch.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){switch(0){case 1:await 0;continue;default:break}break}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completion-bigint-pattern.js",
    source:
      '(async()=>{const[[x],y=await 0]=(function*(){try{yield 1n;yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completion-getter-pattern.js",
    source:
      '(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){throw 0}};yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completion-inert-getter-pattern.js",
    source:
      '(async()=>{const[{x},y=await 0]=(function*(){try{yield {get x(){return 0}};yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-numeric-prefix.js",
    source: 'new(+1,globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "completion-post-default-test.js",
    source:
      '(async()=>{switch(1){default:;case await 0:new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-adoption-0.js",
    source:
      '(async()=>{const pending=(async()=>{await 0;new Socket("wss://example.test/review-latest")})();await((_unused)=>pending)(0);const Socket=globalThis.WebSocket})();',
    present: false,
  },
  {
    file: "completion-adoption-1.js",
    source:
      '(async()=>{const[[x],y=await 0]=(function*(){try{yield {__proto__:null};yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completion-adoption-2.js",
    source:
      'const fixed=0;(async()=>{let y;[fixed,y=await 0]=(function*(){try{yield 0;yield undefined}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completion-adoption-3.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest")})()){try{break}catch{await 0;continue}}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "completion-adoption-4.js",
    source:
      '(async()=>{for(let i=0;i<1;new Socket("wss://example.test/review-latest"),i++){if(skip)break;await 0}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-adoption-5.js",
    source:
      '(async()=>{try{await 0;throw 0}catch{new Socket("wss://example.test/review-latest")}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-adoption-6.js",
    source:
      '(async()=>{(+1)?.[await 0];new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-adoption-7.js",
    source:
      'new(class{},globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "completion-adoption-8.js",
    source:
      '(class{static run(){new Socket("wss://example.test/review-latest")}static #effect=(this.run=()=>{})}).run();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "completion-adoption-9.js",
    source:
      "export {};const pending=import('ws');pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>pending)();new Socket(\"wss://example.test/review-latest\");",
    present: false,
  },
  {
    file: "completion-adoption-10.js",
    source:
      "export {};const pending=import('ws');const{WebSocket:Socket}=await(async()=>pending)();new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "completion-adoption-11.js",
    source:
      "export {};const pending=import('ws');pending.then=resolve=>resolve({WebSocket:class{}});const{WebSocket:Socket}=await(async()=>await pending)();new Socket(\"wss://example.test/review-latest\");",
    present: true,
  },
  {
    file: "argument-review-0.js",
    source:
      '(async()=>{maybe?.(await 0,new Socket("wss://example.test/review-latest"));})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "argument-review-1.js",
    source:
      '(async()=>{const[a=await 0,b]=(function*(){yield undefined;return new Socket("wss://example.test/review-latest");})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "argument-review-2.js",
    source:
      '(async()=>{maybe?.(await 0);new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "argument-review-3.js",
    source:
      '(async()=>{const[a=await 0]=(function*(){yield undefined;return new Socket("wss://example.test/review-latest");})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "route-review-0.js",
    source:
      '(()=>{})?.(...(function*(){new Socket("wss://example.test/review-latest");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "route-review-1.js",
    source:
      'export {};const pending=(async()=>{await ready;new Socket("wss://example.test/review-latest");})();await(async()=>{if(skip)return;await pending;})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "route-review-2.js",
    source:
      '(async()=>{const[x=await 0]=(function*(){try{yield undefined;}finally{new Socket("wss://example.test/review-latest");}})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "route-review-3.js",
    source:
      '({set consume([x]){}}).consume=(function*(){new Socket("wss://example.test/review-latest");yield 0;})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "route-review-4.js",
    source:
      '(async()=>{const[x=(await 0,null.value),next]=(function*(){yield undefined;new Socket("wss://example.test/review-latest");})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "route-review-5.js",
    source:
      '(async()=>{for(const x of(function*(){yield 0;new Socket("wss://example.test/review-latest");})()){await 0;break;}})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "route-review-6.js",
    source:
      '(async()=>{const pending=(async()=>{await 0;new Socket("wss://example.test/review-latest");})();await((_unused)=>pending)();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    file: "route-review-7.js",
    source:
      '(async()=>{(-1)?.[await 0];new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "route-review-8.js",
    source: 'new({},globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "invocation-review-0.js",
    source:
      'new(class{constructor([x]){}})((function*(){new Socket("wss://example.test/review-latest");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "invocation-review-1.js",
    source:
      '(async()=>{try{throw 0;}catch{await 0;}new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "invocation-review-2.js",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-latest");})();await(()=>pending)?.();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    file: "invocation-review-3.js",
    source:
      '(async()=>{const [{[await 0]:x},next]=(function*(){yield null;new Socket("wss://example.test/review-latest");})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "iteration-review-0.js",
    source:
      'const holder={};(holder.run=()=>new Socket("wss://example.test/review-latest"))();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "iteration-review-1.js",
    source:
      'Array.prototype[Symbol.iterator]=function*(){yield 1;};(async()=>{const [[x=await 0],next]=(function*(){yield [undefined];new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "iteration-review-2.js",
    source:
      '(async()=>{({})?.[await ready];new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "iteration-review-3.js",
    source:
      '(async()=>{const [[x=await 0],next]=(function*(){yield [];new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "iteration-review-4.js",
    source:
      '(async()=>{let x;[...[x=await 0,({set run(v){new Socket("wss://example.test/review-latest");}}).run]]=[undefined,0];})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "iteration-review-5.js",
    source:
      '(function([x]){})((function*(){new Socket("wss://example.test/review-latest");yield 0;})());const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "phase-review-0.js",
    source:
      '((()=>0)(),()=>new Socket("wss://example.test/review-latest"))();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "phase-review-1.js",
    source:
      '(async()=>{const [{[await 0]:value},next]=(function*(){yield {};new Socket("wss://example.test/review-latest");yield 1;})();})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "phase-review-2.js",
    source:
      '({set run(value){new Socket("wss://example.test/review-latest");}}).run=0;const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "phase-review-3.js",
    source:
      '(async()=>{try{await using resource=null;}finally{new Socket("wss://example.test/review-latest");}})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "phase-review-4.js",
    source:
      'function marker(){};new(marker,globalThis.WebSocket)("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "phase-review-5.js",
    source:
      '(async()=>{try{await 0;}catch{}new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "phase-review-6.js",
    source:
      '(async()=>{do{await 0;break;}while(false);new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "phase-review-7.js",
    source:
      '(async()=>{exit:{await using r=null;break exit;}new Socket("wss://example.test/review-latest");})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "review-0.js",
    source:
      'const holder = 0; new (holder = globalThis.WebSocket)("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "review-1.js",
    source:
      '[...(function* () { new Socket("wss://example.test/review-latest"); yield 0; })()]; const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    file: "review-2.js",
    source:
      '(async () => { const pending = (async () => { await ready; new Socket("wss://example.test/review-latest"); })(); try { null.value; await pending; } catch {} const Socket = globalThis.WebSocket; })();',
    present: true,
  },
  {
    file: "review-3.js",
    source:
      '(async () => { with ({}) { await ready; } new Socket("wss://example.test/review-latest"); })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    file: "review-4.js",
    source:
      'new globalThis.globalThis.WebSocket("wss://example.test/review-latest");',
    present: true,
  },
  {
    file: "review-5.js",
    source:
      'const ws = require("ws"); const object = { [new ws.WebSocket("wss://example.test/review-latest")]: (ws.WebSocket = class {}) };',
    present: true,
  },
  {
    file: "review-6.js",
    source:
      '(async () => { for (const item of (function* () { yield 0; new Socket("wss://example.test/review-latest"); })()) { await using resource = null; } })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    file: "scope-review-0.js",
    source:
      '(async () => { { await using resource = null; } new Socket("wss://example.test/review-latest"); })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    file: "scope-review-1.js",
    source:
      'export {}; try { const pending = (async () => { await 0; new Socket("wss://example.test/review-latest"); })(); await pending; const Socket = globalThis.WebSocket; } catch {}',
    present: false,
  },
  {
    file: "scope-review-2.js",
    source:
      'let connect; (() => { (connect = () => new Socket("wss://example.test/review-latest"))(); })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    file: "scope-review-3.js",
    source:
      'for (let holder of [new (holder = globalThis.WebSocket)("wss://example.test/review-latest")]) {}',
    present: false,
  },
  {
    file: "scope-review-4.js",
    source:
      'const [ignored] = (function* () { new Socket("wss://example.test/review-latest"); yield 0; })(); const Socket = globalThis.WebSocket;',
    present: false,
  },
  {
    file: "scope-review-5.js",
    source:
      '(async () => { switch (kind) { case await ready: new Socket("wss://example.test/review-latest"); } })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    file: "scope-review-6.js",
    source:
      '(async () => { (async (_x) => { new Socket("wss://example.test/review-latest"); })?.(await ready); })(); const Socket = globalThis.WebSocket;',
    present: true,
  },
  {
    file: "consumption-review-0.js",
    source:
      '(async()=>{const [a,b=await 0,c]=(function*(){yield 0;new Socket("wss://example.test/review-latest");yield undefined;yield 2})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "consumption-review-1.js",
    source:
      '({get run(){new Socket("wss://example.test/review-latest")}}).run=0;const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "consumption-review-2.js",
    source:
      'new(null.value,globalThis.WebSocket)("wss://example.test/review-latest");',
    present: false,
  },
  {
    file: "consumption-review-3.js",
    source:
      '(async()=>{(()=>{})?.(await ready);new Socket("wss://example.test/review-latest")})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "consumption-review-4.js",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-latest")})();while(true){if(skip)break;await pending;break;}const Socket=globalThis.WebSocket;})();',
    present: true,
  },
  {
    file: "consumption-review-5.js",
    source:
      '(async()=>{const pending=(async()=>{await ready;new Socket("wss://example.test/review-latest")})();await(async()=>pending)();const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    file: "consumption-review-6.js",
    source:
      '(function*(){yield*(function*(){new Socket("wss://example.test/review-latest");yield 0})()})().next();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "returned-eager.js",
    source:
      '(()=>()=>new Socket("wss://example.test/review-latest"))()();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "returned-stored.js",
    source:
      'const run=(()=>()=>new Socket("wss://example.test/review-latest"))();const Socket=globalThis.WebSocket;run();',
    present: true,
  },
  {
    file: "nested-pattern-failure.js",
    source:
      '(async()=>{const [[x],y=await 0]=(function*(){try{yield null;yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: false,
  },
  {
    file: "nested-pattern-wait.js",
    source:
      '(async()=>{const [[x],y=await 0]=(function*(){try{yield [];yield undefined;}finally{new Socket("wss://example.test/review-latest")}})()})();const Socket=globalThis.WebSocket;',
    present: true,
  },
  {
    file: "do-test-wait.js",
    source:
      '(async()=>{const pending=(async()=>{await 0;new Socket("wss://example.test/review-latest")})();do{}while(await pending);const Socket=globalThis.WebSocket;})();',
    present: false,
  },
  {
    file: "do-test-bypassed.js",
    source:
      '(async()=>{const pending=(async()=>{await 0;new Socket("wss://example.test/review-latest")})();do{break;}while(await pending);const Socket=globalThis.WebSocket;})();',
    present: true,
  },
];

it("retains reviewed completion endpoints with filesystem source provenance", async () => {
  const root = await createTestTempDirectory("rea-reviewed-completion-");
  for (const { file, source } of completedWriteAndConsumerSources)
    await writeFile(join(root, file), source);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const observations = graph.nodes
      .filter((node) => node.kind === "endpoint")
      .flatMap((node) => node.observations);
    expect(observations).toHaveLength(
      completedWriteAndConsumerSources.filter(({ present }) => present).length,
    );
    for (const { file, present } of completedWriteAndConsumerSources) {
      const matching = observations.filter(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === file,
      );
      expect(matching).toHaveLength(present ? 1 : 0);
      if (present) {
        expect(matching[0]?.properties.value).toBe(
          "wss://example.test/review-latest",
        );
        expect(matching[0]?.evidence).toMatchObject({
          authority: "ast-static-analysis",
          state: "observed",
          confidence: "exact",
          location: {
            available: true,
            value: { kind: "source-range", source: file, start: { line: 1 } },
          },
        });
      }
    }
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("projects path data records as inferred route candidates", async () => {
  const root = await createTestTempDirectory("rea-js-route-property-");
  await writeFile(
    join(root, "app.js"),
    'const ops = [{ type: "set", path: "updatedAt", value: 1 }];\n' +
      'const routes = [{ path: "/settings", component: Settings }];',
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const route = (value: string) =>
      graph.nodes
        .find(
          ({ kind, observations }) =>
            kind === "endpoint" &&
            observations.some(({ properties }) => properties.value === value),
        )
        ?.observations.find(({ properties }) => properties.value === value);

    expect(route("updatedAt")?.properties).toMatchObject({
      endpoint_kind: "route",
      mechanism: "property:path",
      interpretation: "candidate",
    });
    expect(route("updatedAt")?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
      confidence: "low",
    });
    expect(route("updatedAt")?.evidence.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("no router fields")]),
    );
    expect(route("/settings")?.properties.interpretation).toBeUndefined();
    expect(route("/settings")?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
    });
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
