import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

const endpoints = (source: string) =>
  analyzeJavaScriptStaticSource(source).endpoints.map((endpoint) => ({
    kind: endpoint.kind,
    value: endpoint.value,
    mechanism: endpoint.mechanism,
    resolution: endpoint.resolution,
  }));

it.each(["window.Request", "globalThis.Request", "self.Request"])(
  "resolves an inline literal URL from the built-in %s constructor",
  (constructor) => {
    expect(
      endpoints(`fetch(new ${constructor}("/api/chat", { method: "POST" }));`),
    ).toEqual([
      {
        kind: "network",
        value: "/api/chat",
        mechanism: "call:fetch",
        resolution: undefined,
      },
    ]);
  },
);

it.each(["globalThis.fetch", "self.fetch", "fetch?."])(
  "resolves an inline Request URL passed to %s",
  (callee) => {
    expect(endpoints(`${callee}(new Request(\`/api/chat\`));`)).toEqual([
      {
        kind: "network",
        value: "/api/chat",
        mechanism: `call:${callee.replace("?.", "")}`,
        resolution: undefined,
      },
    ]);
  },
);

it.each([
  [
    "const Request = custom;",
    'fetch(new Request("/api/chat"));',
    'new Request("/api/chat")',
  ],
  [
    "Request = custom;",
    'fetch(new Request("/api/chat"));',
    'new Request("/api/chat")',
  ],
  [
    "globalThis.Request = custom;",
    'fetch(new Request("/api/chat"));',
    'new Request("/api/chat")',
  ],
  [
    "const window = custom;",
    'fetch(new window.Request("/api/chat"));',
    'new window.Request("/api/chat")',
  ],
  ["", "fetch(new Request(target));", "new Request(target)"],
  ["", "fetch(new Request(...urls));", "new Request(...urls)"],
])(
  "retains an unproven Request target: %s %s",
  (prefix, source, expression) => {
    expect(endpoints(prefix + source)).toEqual([
      expect.objectContaining({ value: expression, resolution: "partial" }),
    ]);
  },
);

it("resolves unchanged lexical strings and object properties", () => {
  expect(
    endpoints(`
        const target = "/items";
        const config = { url: "/accounts" };
        fetch(target);
        fetch("/direct");
        fetch(config.url);
      `),
  ).toEqual([
    {
      kind: "network",
      value: "/items",
      mechanism: "call:fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "/direct",
      mechanism: "call:fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "/accounts",
      mechanism: "call:fetch",
      resolution: undefined,
    },
  ]);
});

it("resolves unchanged URL objects and aliases using URL serialization", () => {
  expect(
    endpoints(`
        const socket = new URL("HTTPS://EXAMPLE.COM:443");
        const alias = socket;
        const relative = new URL("/items", "https://api.example.test/base");
        fetch(alias);
        fetch(relative);
      `),
  ).toEqual([
    {
      kind: "network",
      value: "https://example.com/",
      mechanism: "call:fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "https://api.example.test/items",
      mechanism: "call:fetch",
      resolution: undefined,
    },
  ]);
});

it("keeps an interpolated request expression verbatim", () => {
  expect(
    endpoints("fetch(`https://${hosts['a@b']}/items/${id}`);"),
  ).toContainEqual({
    kind: "network",
    value: "`https://${hosts['a@b']}/items/${id}`",
    mechanism: "call:fetch",
    resolution: "partial",
  });
});

it("keeps writes to a config property partial instead of resolving its initializer", () => {
  expect(
    endpoints(`
        const config = { url: "https://old.example.test" };
        config.url = "https://new.example.test";
        fetch(config.url);
      `),
  ).toContainEqual({
    kind: "network",
    value: "config.url",
    mechanism: "call:fetch",
    resolution: "partial",
  });
});

it("keeps a reassigned endpoint binding partial", () => {
  expect(
    endpoints(`
        let endpoint = "https://old.example.test";
        endpoint = "https://new.example.test";
        fetch(endpoint);
      `),
  ).toContainEqual({
    kind: "network",
    value: "endpoint",
    mechanism: "call:fetch",
    resolution: "partial",
  });
});

it("does not resolve an endpoint from a declaration after the request", () => {
  expect(
    endpoints(`
        fetch(endpoint);
        const endpoint = "https://api.example.test/items";
      `),
  ).toEqual([
    {
      kind: "network",
      value: "endpoint",
      mechanism: "call:fetch",
      resolution: "partial",
    },
  ]);
});

it("keeps URLSearchParams mutations partial", () => {
  expect(
    endpoints(`
        const socket = new URL("wss://old.example.test/socket");
        socket.searchParams.set("token", token);
        new WebSocket(socket);
      `),
  ).toContainEqual({
    kind: "network",
    value: "socket",
    mechanism: "call:WebSocket",
    resolution: "partial",
  });
});

it("resolves a URL object against a literal base", () => {
  expect(
    endpoints(`
        const socket = new URL("/socket", "wss://api.example.test");
        new WebSocket(socket);
      `),
  ).toEqual([
    {
      kind: "network",
      value: "wss://api.example.test/socket",
      mechanism: "call:WebSocket",
      resolution: undefined,
    },
  ]);
});

it("resolves an unchanged URL object's toString target", () => {
  expect(
    endpoints(`
        const socket = new URL("wss://api.example.test/socket");
        new WebSocket(socket.toString());
      `),
  ).toEqual([
    {
      kind: "network",
      value: "wss://api.example.test/socket",
      mechanism: "call:WebSocket",
      resolution: undefined,
    },
  ]);
});

// Coercing a URL object reads its conversion methods through URL.prototype
// and its prototype chain; an explicit toString() call reads one of them.
it.each([
  ["URL.prototype escapes", "configure(URL.prototype);", "socket.toString()"],
  [
    "Object.prototype escapes",
    "configure(Object.prototype);",
    "socket.toString()",
  ],
  [
    "URL.prototype's prototype link changes",
    "URL.prototype.__proto__ = proxy;",
    "socket",
  ],
])("keeps a URL object target partial after %s", (_, effect, target) => {
  expect(
    endpoints(`
        ${effect}
        const socket = new URL("wss://api.example.test/socket");
        new WebSocket(${target});
      `),
  ).toEqual([
    {
      kind: "network",
      value: target,
      mechanism: "call:WebSocket",
      resolution: "partial",
    },
  ]);
});

it("keeps a URL object partial when its base is unresolved", () => {
  expect(
    endpoints(`
        const socket = new URL("/socket", apiOrigin);
        new WebSocket(socket);
      `),
  ).toContainEqual({
    kind: "network",
    value: "socket",
    mechanism: "call:WebSocket",
    resolution: "partial",
  });
});

it("keeps URL aliases partial after a member mutation", () => {
  expect(
    endpoints(`
        const socket = new URL("wss://old.example.test/socket");
        const alias = socket;
        alias.hostname = "new.example.test";
        fetch(socket);
      `),
  ).toContainEqual({
    kind: "network",
    value: "socket",
    mechanism: "call:fetch",
    resolution: "partial",
  });
});

it("keeps an escaped URL object partial", () => {
  expect(
    endpoints(`
        const socket = new URL("wss://old.example.test/socket");
        configure(socket);
        new WebSocket(socket);
      `),
  ).toContainEqual({
    kind: "network",
    value: "socket",
    mechanism: "call:WebSocket",
    resolution: "partial",
  });
});

it("retains dynamic targets on known global fetch receivers", () => {
  expect(
    endpoints(`
        window.fetch(endpoint);
        globalThis.fetch(endpoint);
        self.fetch(endpoint);
      `),
  ).toEqual([
    {
      kind: "network",
      value: "endpoint",
      mechanism: "call:window.fetch",
      resolution: "partial",
    },
    {
      kind: "network",
      value: "endpoint",
      mechanism: "call:globalThis.fetch",
      resolution: "partial",
    },
    {
      kind: "network",
      value: "endpoint",
      mechanism: "call:self.fetch",
      resolution: "partial",
    },
  ]);
});

it("does not treat a locally bound fetch function as a network API", () => {
  expect(
    endpoints(`
        function fetch(key) { return records[key]; }
        fetch(key);
      `),
  ).toEqual([]);
});

it("keeps exact literal targets exact", () => {
  expect(endpoints('fetch("https://api.example.test/items");')).toEqual([
    {
      kind: "network",
      value: "https://api.example.test/items",
      mechanism: "call:fetch",
      resolution: undefined,
    },
  ]);
});

it("resolves inline Request constructor targets with literal URLs", () => {
  expect(
    endpoints(`
        fetch(new Request("/api/chat", { method: "POST" }));
        window.fetch(new Request("/api/window"));
      `),
  ).toEqual([
    {
      kind: "network",
      value: "/api/chat",
      mechanism: "call:fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "/api/window",
      mechanism: "call:window.fetch",
      resolution: undefined,
    },
  ]);
});

it("keeps Request calls without new partial", () => {
  expect(endpoints('fetch(Request("/api/stream"));')).toEqual([
    {
      kind: "network",
      value: 'Request("/api/stream")',
      mechanism: "call:fetch",
      resolution: "partial",
    },
  ]);
});

it("resolves unchanged Request objects and aliases", () => {
  expect(
    endpoints(`
        const req = new Request("/api/chat", { method: "POST" });
        const alias = req;
        fetch(alias);
      `),
  ).toEqual([
    {
      kind: "network",
      value: "/api/chat",
      mechanism: "call:fetch",
      resolution: undefined,
    },
  ]);
});

it("keeps Request objects partial when called with toString", () => {
  expect(
    endpoints(`
        const req = new Request("/api/chat");
        fetch(req.toString());
      `),
  ).toEqual([
    {
      kind: "network",
      value: "req.toString()",
      mechanism: "call:fetch",
      resolution: "partial",
    },
  ]);
});

it("keeps Request targets partial on non-fetch network APIs", () => {
  expect(
    endpoints(`
        const socketReq = new Request("wss://host/socket");
        new WebSocket(new Request("wss://host/direct"));
        new WebSocket(socketReq);
        navigator.sendBeacon(new Request("https://api.example.test/beacon"));
      `),
  ).toEqual([
    {
      kind: "network",
      value: 'new Request("wss://host/direct")',
      mechanism: "call:WebSocket",
      resolution: "partial",
    },
    {
      kind: "network",
      value: "socketReq",
      mechanism: "call:WebSocket",
      resolution: "partial",
    },
    {
      kind: "network",
      value: 'new Request("https://api.example.test/beacon")',
      mechanism: "call:navigator.sendBeacon",
      resolution: "partial",
    },
  ]);
});

it("keeps Request objects partial when Request is locally shadowed", () => {
  expect(
    endpoints(`
        function test(Request) {
          fetch(new Request("/api/shadowed"));
        }
      `),
  ).toContainEqual({
    kind: "network",
    value: 'new Request("/api/shadowed")',
    mechanism: "call:fetch",
    resolution: "partial",
  });
});

it("reads Electron net targets with the argument forms each API accepts", () => {
  expect(
    endpoints(`
        import { net } from "electron";
        const exact = "https://api.example.test/string";
        const address = new URL("https://api.example.test/url");
        const input = new Request("https://api.example.test/request");
        net.fetch(exact);
        net.fetch(address);
        net.fetch(input);
        net.fetch(new Request("https://api.example.test/inline"));
        net.request(exact);
        net.request(address);
        net.request({ method: "POST", url: "https://api.example.test/options" });
        net.fetch(runtimeUrl);
        net.fetch.call(net, "https://api.example.test/forwarded");
      `),
  ).toEqual([
    {
      kind: "network",
      value: "https://api.example.test/string",
      mechanism: "call:net.fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "https://api.example.test/url",
      mechanism: "call:net.fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "https://api.example.test/request",
      mechanism: "call:net.fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "https://api.example.test/inline",
      mechanism: "call:net.fetch",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "https://api.example.test/string",
      mechanism: "call:net.request",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "address",
      mechanism: "call:net.request",
      resolution: "partial",
    },
    {
      kind: "network",
      value: '{ method: "POST", url: "https://api.example.test/options" }',
      mechanism: "call:net.request",
      resolution: "partial",
    },
    {
      kind: "network",
      value: "runtimeUrl",
      mechanism: "call:net.fetch",
      resolution: "partial",
    },
  ]);
});

it("resolves net.request from the string an unchanged URL object returns", () => {
  expect(
    endpoints(`
        import { net } from "electron";
        const address = new URL("https://api.example.test/ping");
        const moved = new URL("https://api.example.test/old");
        moved.pathname = "/new";
        net.request(address.toString());
        net.request(address);
        net.request(moved.toString());
      `),
  ).toEqual([
    {
      kind: "network",
      value: "https://api.example.test/ping",
      mechanism: "call:net.request",
      resolution: undefined,
    },
    {
      kind: "network",
      value: "address",
      mechanism: "call:net.request",
      resolution: "partial",
    },
    {
      kind: "network",
      value: "moved.toString()",
      mechanism: "call:net.request",
      resolution: "partial",
    },
  ]);
});

// A partial value echoes source text, so URL userinfo written in its literals
// is a transport credential and goes the way exact endpoint values already do.
it.each([
  [
    'fetch({ url: "https://user:secret@api.example.test/v1" });',
    '{ url: "https://api.example.test/v1" }',
  ],
  [
    'fetch("https://user:secret@api.example.test/" + path);',
    '"https://api.example.test/" + path',
  ],
  [
    "fetch(`https://user:secret@api.example.test/${path}`);",
    "`https://api.example.test/${path}`",
  ],
  [
    "new WebSocket('wss://user:secret@api.example.test/' + path);",
    "'wss://api.example.test/' + path",
  ],
  [
    // The host is dynamic, so the literal is only the start of a URL.
    "fetch(`https://user:secret@${host}/v1`);",
    "`https://${host}/v1`",
  ],
  [
    // The escape moves every offset, so the literal is written again.
    'fetch("https://user:secret\\u0040api.example.test/" + path);',
    '"https://api.example.test/" + path',
  ],
  [
    'import { net } from "electron"; net.request({ method: "POST", url: "https://user:secret@api.example.test/v1" });',
    '{ method: "POST", url: "https://api.example.test/v1" }',
  ],
  [
    'import { net } from "electron"; net.fetch("https://user:secret@api.example.test/" + path);',
    '"https://api.example.test/" + path',
  ],
  [
    // The userinfo starts in one literal and ends in the next.
    'import { net } from "electron"; net.fetch("https://user:" + "secret@" + host);',
    '"https://" + "" + host',
  ],
  [
    'fetch("https://user:" + "sec" + "ret@api.example.test/" + path);',
    '"https://" + "" + "api.example.test/" + path',
  ],
  [
    'fetch(`https://user:${"secret@"}${host}/v1`);',
    '`https://${""}${host}/v1`',
  ],
])(
  "removes URL userinfo from a partial endpoint expression: %s",
  (source, value) => {
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.endpoints.map((endpoint) => endpoint.value)).toEqual([
      value,
    ]);
    expect(analysis.endpoints[0]?.resolution).toBe("partial");
    expect(JSON.stringify(analysis)).not.toContain("secret");
  },
);

it.each([
  'fetch("https://api.example.test" + "/to/" + "user:secret@x" + path);',
  // The dynamic piece may hold the host and a path, as in
  // "api.example.test/users/", so the address after it is path text.
  'fetch("https://" + hostAndPath + "person@example.test" + suffix);',
])("keeps literals after a URL authority that may be closed: %s", (source) => {
  expect(endpoints(source)).toEqual([
    {
      kind: "network",
      value: source.slice("fetch(".length, -");".length),
      mechanism: "call:fetch",
      resolution: "partial",
    },
  ]);
});

it("keeps partial expression text that only resembles URL credentials", () => {
  const source =
    'fetch({ url: "https://api.example.test/@scope/pkg", mail: "user:secret@api.example.test", next: "https://api.example.test/?to=a@b" });';
  expect(endpoints(source)).toEqual([
    {
      kind: "network",
      value: source.slice("fetch(".length, -");".length),
      mechanism: "call:fetch",
      resolution: "partial",
    },
  ]);
});
