import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { captureCssVariables } from "./CdpCaptureCssVariables.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpConnection } from "./CdpConnection.js";

const makeMockConnection = (
  replies: Record<string, unknown | Error>,
  sentCommands?: string[],
): CdpConnection =>
  ({
    send(method: string): Promise<unknown> {
      sentCommands?.push(method);
      const reply = replies[method];
      if (reply instanceof Error) {
        return Promise.reject(reply);
      }
      if (reply !== undefined) {
        return Promise.resolve(reply);
      }
      return Promise.reject(new Error(`Unexpected CDP command: ${method}`));
    },
  }) as unknown as CdpConnection;

it("returns not_approved when include_css_variables is false", async () => {
  const connection = makeMockConnection({});
  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: false,
      }),
    },
    limitations,
  );

  expect(result).toEqual({
    status: "not_approved",
    origin_scope: "same_origin",
    total: 0,
    retained_count: 0,
    items: [],
  });
  expect(limitations).toEqual([]);
});

it("extracts, validates, and sorts root CSS variables deterministically", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "color", value: "red" }, // non-custom property (must be excluded)
        { name: "--zebra", value: "#000" },
        { name: "--alpha", value: "16px" },
        { name: "__proto__", value: "polluted" }, // security injection (must be excluded)
        { name: "--middle-val", value: "calc(100% - 20px)" },
        { name: "--bad-val", value: "evil\x00data" }, // control character (must be excluded)
      ],
    },
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: "session_123",
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result).toEqual({
    status: "truncated",
    origin_scope: "same_origin",
    total: 4,
    retained_count: 3,
    items: [
      { name: "--alpha", value: "16px", redacted: false },
      { name: "--middle-val", value: "calc(100% - 20px)", redacted: false },
      { name: "--zebra", value: "#000", redacted: false },
    ],
  });
  expect(
    limitations.some(
      (lim) =>
        lim.includes("1 root CSS custom property was rejected") &&
        lim.includes("--bad-val"),
    ),
  ).toBe(true);
});

it("marks status as truncated when variables exceed 250 items", async () => {
  const oversizedVariables = Array.from({ length: 260 }, (_, i) => ({
    name: `--var-${String(i).padStart(3, "0")}`,
    value: `${String(i)}px`,
  }));

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: oversizedVariables,
    },
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("truncated");
  expect(result.total).toBe(260);
  expect(result.retained_count).toBe(250);
  expect(result.items).toHaveLength(250);
  expect(result.items[0]?.name).toBe("--var-000");
});

it("handles unsupported CDP CSS methods gracefully", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: { nodeId: 1 },
    },
    "CSS.enable": new CdpCommandRejection(
      "inspect_web_page",
      "CSS.enable",
      -32601,
      "Method not found",
    ),
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result).toEqual({
    status: "unavailable",
    origin_scope: "same_origin",
    total: 0,
    retained_count: 0,
    items: [],
  });
  expect(limitations).toContain(
    "CSS.enable was unavailable from this browser target.",
  );
});

it("disables CSS domain in finally block to prevent CDP event leaks", async () => {
  const sentCommands: string[] = [];
  const connection = makeMockConnection(
    {
      "DOM.getDocument": {
        root: {
          nodeId: 1,
          children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
        },
      },
      "CSS.enable": {},
      "CSS.getComputedStyleForNode": {
        computedStyle: [{ name: "--test-var", value: "10px" }],
      },
      "CSS.disable": {},
    },
    sentCommands,
  );

  const limitations: string[] = [];
  await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(sentCommands).toContain("CSS.disable");
});

it("handles detached node error (-32000) during in-flight navigation gracefully", async () => {
  const sentCommands: string[] = [];
  const connection = makeMockConnection(
    {
      "DOM.getDocument": {
        root: {
          nodeId: 1,
          children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
        },
      },
      "CSS.enable": {},
      "CSS.getComputedStyleForNode": new CdpCommandRejection(
        "inspect_web_page",
        "CSS.getComputedStyleForNode",
        -32000,
        "Could not find node with given id",
      ),
      "CSS.disable": {},
    },
    sentCommands,
  );

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("unavailable");
  expect(sentCommands).toContain("CSS.disable");
  expect(
    limitations.some(
      (lim) =>
        lim.includes("CSS.getComputedStyleForNode failed (CDP error -32000)") &&
        lim.includes("Could not find node with given id"),
    ),
  ).toBe(true);
});

it("preserves observed count and records rejection limitation when tokens fail schema validation", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--valid-token", value: "#333333" },
        { name: "--oversized-token", value: "x".repeat(600) },
        { name: "not-a-css-var", value: "ignored" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.total).toBe(2);
  expect(result.retained_count).toBe(1);
  expect(result.items).toEqual([
    { name: "--valid-token", value: "#333333", redacted: false },
  ]);
  expect(
    limitations.some(
      (lim) =>
        lim.includes("1 root CSS custom property was rejected") &&
        lim.includes("--oversized-token"),
    ),
  ).toBe(true);
});

it("truncates excessively long rejected names and bounds preview list in limitations", async () => {
  const longName = `--${"a".repeat(150)}`;
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: longName, value: "x".repeat(600) },
        { name: "--bad-1", value: "x".repeat(600) },
        { name: "--bad-2", value: "x".repeat(600) },
        { name: "--bad-3", value: "x".repeat(600) },
        { name: "--bad-4", value: "x".repeat(600) },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.total).toBe(5);
  expect(result.retained_count).toBe(0);
  expect(limitations).toHaveLength(1);
  const limitationMsg = limitations[0] ?? "";
  expect(limitationMsg).toContain(
    "5 root CSS custom properties were rejected:",
  );
  expect(limitationMsg).toContain("…");
  expect(limitationMsg).toContain("and 2 more");
  expect(limitationMsg.includes(longName)).toBe(false);
});

it("records informational limitation when CSS variables are truncated", async () => {
  const oversizedVariables = Array.from({ length: 260 }, (_, i) => ({
    name: `--var-${String(i).padStart(3, "0")}`,
    value: `${String(i)}px`,
  }));

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: oversizedVariables,
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(
    limitations.some((lim) => lim.includes("truncated to 250 items")),
  ).toBe(true);
});

it("redacts URL transport credentials from CSS url() values", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        {
          name: "--bg-asset",
          value:
            "URL(  'https://alice:secret123@example.test/assets/bg.png'  )",
        },
        {
          name: "--local-asset",
          value: 'url( "/assets/bg.png" )',
        },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.items).toHaveLength(2);
  const bgItem = result.items.find((item) => item.name === "--bg-asset");
  expect(bgItem?.value).not.toContain("secret123");
  expect(bgItem?.value).toBe("URL(  'https://example.test/assets/bg.png'  )");

  const localItem = result.items.find((item) => item.name === "--local-asset");
  expect(localItem?.value).toBe('url( "/assets/bg.png" )');
});

it("treats missing or non-array computedStyle as unavailable with limitation", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: "not-an-array",
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("unavailable");
  expect(
    limitations.some((lim) =>
      lim.includes(
        "CSS.getComputedStyleForNode response omitted valid computedStyle",
      ),
    ),
  ).toBe(true);
});

it("safely bounds scan time and quickly rejects multiline or massive CSS variable values without freezing", async () => {
  // Craft a large multiline payload that would cause quadratic backtracking if unconstrained
  const largeValue = Array.from(
    { length: 1000 },
    (_, i) => `url("http://example.com/asset-${i}.png")`,
  ).join("\n");
  expect(largeValue.length).toBeGreaterThan(30000);

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--huge-token", value: largeValue },
        { name: "--normal-token", value: "#ff0000" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const start = performance.now();
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );
  const elapsedMs = performance.now() - start;

  expect(elapsedMs).toBeLessThan(100);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.name).toBe("--normal-token");
  expect(result.total).toBe(2);
  expect(
    limitations.some((lim) =>
      lim.includes("1 root CSS custom property was rejected"),
    ),
  ).toBe(true);
});

it("sanitizes control codes and bidi characters from rejected variable preview names", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        // Name containing newlines, ESC, and BiDi override code points
        {
          name: "--malicious\n\x1b[31m\u202Ereversed",
          value: "too long ".repeat(100),
        },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.items).toHaveLength(0);
  expect(limitations.length).toBeGreaterThan(0);
  const rejectionLim = limitations.find((lim) => lim.includes("rejected:"));
  expect(rejectionLim).toBeDefined();
  expect(rejectionLim).not.toContain("\n");
  expect(rejectionLim).not.toContain("\x1b");
  expect(rejectionLim).not.toContain("\u202E");
});

it("accepts valid Unicode and non-ASCII custom property names", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--顏色", value: "#ffffff" },
        { name: "--カラー-メイン", value: "#000000" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.items).toHaveLength(2);
  expect(result.items.some((item) => item.name === "--顏色")).toBe(true);
  expect(result.items.some((item) => item.name === "--カラー-メイン")).toBe(
    true,
  );
});

it("marks malformed computedStyle entries incomplete and excludes invalid_protocol_value", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        // Entry missing string value
        { name: "--brand" },
        // Non-record entry
        "malformed-entry",
        // Valid custom property
        { name: "--valid-token", value: "#333333" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const exclusions: {
    section: string;
    reason: string;
    count: number | null;
  }[] = [];
  const mockEvents = {
    completeness: {
      exclude: (
        section: "css_variables",
        reason: "invalid_protocol_value",
        count: number | null,
      ) => {
        exclusions.push({ section, reason, count });
      },
    },
  };

  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
      events: mockEvents,
    },
    limitations,
  );

  // Partial valid items retained, but section marked truncated/incomplete
  expect(result.status).toBe("truncated");
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.name).toBe("--valid-token");
  expect(exclusions).toEqual([
    { section: "css_variables", reason: "invalid_protocol_value", count: 2 },
  ]);
  expect(
    limitations.some((lim) =>
      lim.includes("contained 2 malformed property entries"),
    ),
  ).toBe(true);
});

it("marks section truncated when observed custom properties are rejected by schema or length bound", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--valid", value: "10px" },
        // Oversized value (>512 chars) rejected by schema
        { name: "--too-long", value: "x".repeat(600) },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  // Even though total (2) <= 250, because 1 item was rejected, status is truncated!
  expect(result.total).toBe(2);
  expect(result.retained_count).toBe(1);
  expect(result.status).toBe("truncated");
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.name).toBe("--valid");
  expect(
    limitations.some((lim) =>
      lim.includes("1 root CSS custom property was rejected"),
    ),
  ).toBe(true);
});

it("redacts credentials from quoted and unquoted CSS URLs including opposite quotes", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        {
          name: "--with-single-quote",
          value: 'url("https://alice:secret@example.com/a\'b")',
        },
        {
          name: "--with-double-quote",
          value: "url('https://alice:secret@example.com/a\"b')",
        },
        {
          name: "--unquoted",
          value: "url(https://alice:secret@example.com/path)",
        },
        {
          name: "--scheme-relative",
          value: 'url("//alice:secret@example.com/a.png")',
        },
        {
          name: "--escaped-double-quote",
          value: 'url("https://alice:secret@example.com/a\\"b")',
        },
        {
          name: "--escaped-single-quote",
          value: "url('https://alice:secret@example.com/a\\'b')",
        },
        {
          name: "--escaped-paren",
          value: "url(https://alice:secret@example.com/a\\)b)",
        },
        {
          name: "--escaped-function-name",
          value: "u\\72l(https://alice:secret@example.com/a)",
        },
        {
          name: "--escaped-payload-at",
          value: 'url("https://alice:secret\\40 example.com/a\\"b")',
        },
        {
          name: "--image-set-urls",
          value:
            "image-set(\"https://alice:secret@example.com/a.png\" 1x, 'https://bob:pw@example.com/b.png' 2x)",
        },
        {
          name: "--webkit-image-set-url",
          value:
            '-webkit-image-set("https://alice:secret@example.com/c.png" 1x)',
        },
        {
          name: "--nested-image-set-url",
          value:
            'image-set(url("https://alice:secret@example.com/nested.png") 1x)',
        },
        {
          name: "--escaped-backslash-netpath",
          value: 'url("\\\\\\\\alice:secret@example.com/a")',
        },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("included");
  expect(result.items).toEqual([
    {
      name: "--escaped-backslash-netpath",
      redacted: true,
      value: 'url("//example.com/a")',
    },
    {
      name: "--escaped-double-quote",
      redacted: true,
      value: 'url("https://example.com/a\\"b")',
    },
    {
      name: "--escaped-function-name",
      redacted: true,
      value: "u\\72l(https://example.com/a)",
    },
    {
      name: "--escaped-paren",
      redacted: true,
      value: "url(https://example.com/a\\)b)",
    },
    {
      name: "--escaped-payload-at",
      redacted: true,
      value: 'url("https://example.com/a\\"b")',
    },
    {
      name: "--escaped-single-quote",
      redacted: true,
      value: "url('https://example.com/a\\'b')",
    },
    {
      name: "--image-set-urls",
      redacted: true,
      value:
        "image-set(\"https://example.com/a.png\" 1x, 'https://example.com/b.png' 2x)",
    },
    {
      name: "--nested-image-set-url",
      redacted: true,
      value: 'image-set(url("https://example.com/nested.png") 1x)',
    },
    {
      name: "--scheme-relative",
      redacted: true,
      value: 'url("//example.com/a.png")',
    },
    {
      name: "--unquoted",
      redacted: true,
      value: "url(https://example.com/path)",
    },
    {
      name: "--webkit-image-set-url",
      redacted: true,
      value: '-webkit-image-set("https://example.com/c.png" 1x)',
    },
    {
      name: "--with-double-quote",
      redacted: true,
      value: "url('https://example.com/a\"b')",
    },
    {
      name: "--with-single-quote",
      redacted: true,
      value: 'url("https://example.com/a\'b")',
    },
  ]);
  expect(
    limitations.some((lim) =>
      lim.includes(
        "13 root CSS custom property values had transport credentials redacted",
      ),
    ),
  ).toBe(true);
});

it("scans large non-ASCII CSS values in linear time without stalling", async () => {
  const nonAsciiPrefix = "あ".repeat(60_000);
  const value = `${nonAsciiPrefix} url("https://alice:secret@example.com/a")`;
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [{ name: "--long-non-ascii", value }],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const startMs = Date.now();
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
        max_css_variable_value_length: 65_536,
      }),
    },
    limitations,
  );
  const elapsedMs = Date.now() - startMs;

  expect(elapsedMs).toBeLessThan(200);
  expect(result.status).toBe("included");
  expect(result.items[0]?.redacted).toBe(true);
  expect(result.items[0]?.value).not.toContain("secret");
});

it("allows callers to raise max_css_variables and max_css_variable_value_length", async () => {
  const manyVariables = Array.from({ length: 260 }, (_, i) => ({
    name: `--var-${String(i).padStart(3, "0")}`,
    value: i === 0 ? "x".repeat(600) : `${String(i)}px`,
  }));
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: manyVariables,
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
        max_css_variables: 300,
        max_css_variable_value_length: 1024,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("included");
  expect(result.total).toBe(260);
  expect(result.retained_count).toBe(260);
  expect(result.items).toHaveLength(260);
  expect(result.items[0]?.value).toHaveLength(600);
});

it("excludes invalid_protocol_value and records limitation when DOM root or nodeId is malformed", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: "non-numeric",
        children: [{ nodeId: -1, nodeType: 1 }],
      },
    },
  });

  const limitations: string[] = [];
  const exclusions: {
    section: string;
    reason: string;
    count: number | null;
  }[] = [];
  const mockEvents = {
    completeness: {
      exclude: (
        section: "css_variables",
        reason: "invalid_protocol_value",
        count: number | null,
      ) => {
        exclusions.push({ section, reason, count });
      },
    },
  };

  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
      events: mockEvents,
    },
    limitations,
  );

  expect(result.status).toBe("unavailable");
  expect(exclusions).toEqual([
    { section: "css_variables", reason: "invalid_protocol_value", count: 1 },
  ]);
  expect(
    limitations.some((lim) =>
      lim.includes(
        "DOM.getDocument response root node omitted valid numeric nodeId",
      ),
    ),
  ).toBe(true);
});

it("reapplies max_css_variable_value_length after URL redaction expands length", async () => {
  const nonAsciiPath = "é".repeat(120);
  const rawUrlValue = `url("https://alice:secret\\9 @example.test/${nonAsciiPath}")`;
  expect(rawUrlValue.length).toBeLessThanOrEqual(200);

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--expanded-url", value: rawUrlValue },
        { name: "--short-var", value: "#fff" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
        max_css_variable_value_length: 200,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("truncated");
  expect(result.items).toEqual([
    { name: "--short-var", value: "#fff", redacted: false },
  ]);
  expect(
    limitations.some(
      (lim) =>
        lim.includes("after URL redaction") ||
        lim.includes("sanitized value length"),
    ),
  ).toBe(true);
});

it("admits valid Unicode symbol code points such as emoji in custom property names", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--🎨", value: "#ff00aa" },
        { name: "--★-accent", value: "gold" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("included");
  expect(result.items).toEqual([
    { name: "--★-accent", value: "gold", redacted: false },
    { name: "--🎨", value: "#ff00aa", redacted: false },
  ]);
});

it("enforces combined CSS variable capture budget at input validation and retains large allowed captures without a hidden cap", async () => {
  expect(() =>
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target_1",
      include_css_variables: true,
      max_css_variables: 500,
      max_css_variable_value_length: 65_536,
    }),
  ).toThrow(/UTF-16 unit capture budget/);

  const bigValue = "x".repeat(65_000);
  const computedStyle = Array.from({ length: 80 }, (_, index) => ({
    name: `--big-${String(index).padStart(3, "0")}`,
    value: bigValue,
  }));

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": { computedStyle },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
        max_css_variables: 100,
        max_css_variable_value_length: 65_536,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("included");
  expect(result.total).toBe(80);
  expect(result.retained_count).toBe(80);
});

it("redacts credentials from standalone URL custom properties and admits custom property names longer than 128 chars", async () => {
  const longName = `--${"token-".repeat(25)}end`;
  expect(longName.length).toBeGreaterThan(128);

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        {
          name: "--asset-quoted",
          value: '"https://alice:secret@example.test/a.png"',
        },
        {
          name: "--asset-unquoted",
          value: "https://bob:pw@example.test/b.png",
        },
        {
          name: "--asset-escaped",
          value: '"https://carol:pw\\40 example.test/c.png"',
        },
        { name: longName, value: "#123456" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("included");
  const byName = new Map(result.items.map((item) => [item.name, item]));
  expect(byName.get("--asset-quoted")).toEqual({
    name: "--asset-quoted",
    value: '"https://example.test/a.png"',
    redacted: true,
  });
  expect(byName.get("--asset-unquoted")).toEqual({
    name: "--asset-unquoted",
    value: "https://example.test/b.png",
    redacted: true,
  });
  expect(byName.get("--asset-escaped")).toEqual({
    name: "--asset-escaped",
    value: '"https://example.test/c.png"',
    redacted: true,
  });
  expect(byName.get(longName)).toEqual({
    name: longName,
    value: "#123456",
    redacted: false,
  });
});
