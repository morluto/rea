import { describe, expect, it } from "vitest";

import { safeResponseMetadata } from "./CdpSafeMetadata.js";

const origin = "https://app.example.test";

describe("safe CDP response metadata", () => {
  it("drops credential headers and preserves complete local link URLs", () => {
    const captured = safeResponseMetadata(
      "request-1",
      `${origin}/api`,
      {
        mimeType: "application/json",
        headers: {
          Authorization: "Bearer credential-secret",
          Cookie: "session=cookie-secret",
          "Set-Cookie": "session=response-secret",
          Link: `</agent?token=link-secret>; rel="mcp service-desc"; title="a,b", <https://private.example.test/x>; rel="mcp"`,
          "Content-Security-Policy":
            "default-src 'self'; script-src 'nonce-nonce-secret' 'sha256-hash-secret' https://private.example.test",
          "Permissions-Policy":
            "camera=(), geolocation=(self), invalid secret=()",
          "X-Model-Context": "agent-header-secret",
        },
      },
      new Set([origin]),
    );

    expect(captured.response).toMatchObject({
      url: `${origin}/api`,
      csp: {
        nonce_count: 1,
        hash_count: 1,
        directives: expect.arrayContaining([
          expect.objectContaining({
            name: "script-src",
            sources: expect.arrayContaining([
              { kind: "external_origin", value: null },
            ]),
          }),
        ]),
      },
      links: [
        {
          href: `${origin}/agent?token=link-secret`,
          destination_scope: "approved",
          rel: ["mcp", "service-desc"],
          as: null,
          type: null,
          crossorigin: null,
        },
        expect.objectContaining({
          href: "https://private.example.test/x",
          destination_scope: "outside_policy",
        }),
      ],
      policies: { permissions_policy_features: ["camera", "geolocation"] },
    });
    expect(captured.agentHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mechanism: "link_rel" }),
        expect.objectContaining({
          mechanism: "response_header",
          declaration: "x-model-context",
        }),
      ]),
    );
    const serialized = JSON.stringify(captured);
    for (const secret of [
      "credential-secret",
      "cookie-secret",
      "response-secret",
      "nonce-secret",
      "hash-secret",
      "agent-header-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("link-secret");
    expect(serialized).toContain("private.example.test/x");
  });

  it("reports well-known agent resources as untrusted observations", () => {
    const captured = safeResponseMetadata(
      "request-2",
      `${origin}/.well-known/mcp?token=secret`,
      { headers: {} },
      new Set([origin]),
    );

    expect(captured.agentHints).toEqual([
      {
        mechanism: "well_known_resource",
        declaration: "/.well-known/mcp",
        url: `${origin}/.well-known/mcp?token=secret`,
        trust: "page-declared-untrusted",
      },
    ]);
  });

  it("retains every parsed header, CSP directive, link, relation, and policy feature", () => {
    const csp = Array.from(
      { length: 105 },
      (_, index) => `x-${String(index)} 'self'`,
    ).join("; ");
    const links = Array.from(
      { length: 105 },
      (_, index) => `</${String(index)}>; rel="mcp service-desc"`,
    ).join(", ");
    const permissions = Array.from(
      { length: 205 },
      (_, index) => `feature-${String(index)}=()`,
    ).join(", ");
    const headers = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `x-extra-${String(index)}`,
        "ok",
      ]),
    );
    const captured = safeResponseMetadata(
      "request-1",
      `${origin}/api`,
      {
        mimeType: "application/json",
        headers: {
          ...headers,
          "Content-Security-Policy": csp,
          Link: links,
          "Permissions-Policy": permissions,
          "X-Model-Context": "present-after-many-headers",
        },
      },
      new Set([origin]),
    );

    expect(captured.response.csp.directives).toHaveLength(105);
    expect(captured.response.links).toHaveLength(105);
    expect(captured.response.policies.permissions_policy_features).toHaveLength(
      205,
    );
    expect(captured.agentHints).toContainEqual(
      expect.objectContaining({ declaration: "x-model-context" }),
    );
  });
});

describe("safe CDP response metadata CSP sources", () => {
  it("classifies scheme-less CSP host sources by their own host, not the page origin", () => {
    const captured = safeResponseMetadata(
      "request-csp",
      `${origin}/api`,
      {
        headers: {
          "Content-Security-Policy":
            "script-src cdn.example.test *.trusted.test * 'self' https://api.other.test",
        },
      },
      new Set([origin]),
    );

    expect(captured.response.csp.directives).toEqual([
      {
        name: "script-src",
        sources: [
          { kind: "external_origin", value: null },
          { kind: "external_origin", value: null },
          { kind: "external_origin", value: null },
          { kind: "keyword", value: "'self'" },
          { kind: "external_origin", value: null },
        ],
      },
    ]);
  });

  it("inherits the protected resource scheme for a scheme-less host source", () => {
    const captured = safeResponseMetadata(
      "request-csp-scheme",
      `${origin}/api`,
      {
        headers: {
          "Content-Security-Policy":
            "script-src cdn.example.test app.example.test",
        },
      },
      new Set([origin, "https://cdn.example.test"]),
    );

    expect(captured.response.csp.directives[0]?.sources).toEqual([
      { kind: "approved_origin", value: "https://cdn.example.test" },
      { kind: "approved_origin", value: origin },
    ]);
  });
});

describe("Link header value delimiters", () => {
  const captureLinks = (link: string) =>
    safeResponseMetadata(
      "owned",
      "https://owned.test/page",
      {
        headers: { Link: link },
      },
      new Set(["https://owned.test"]),
    ).response.links;

  it("preserves commas in URI references and separates later links", () => {
    const links = captureLinks(
      '</assets/red,blue.js>; rel="preload"; as=script, </ordinary.js>; rel="modulepreload"',
    );
    expect(links.map(({ href }) => href)).toEqual([
      "https://owned.test/assets/red,blue.js",
      "https://owned.test/ordinary.js",
    ]);
    expect(links[0]?.as).toBe("script");
  });

  it("preserves semicolons and commas inside quoted parameter values", () => {
    const links = captureLinks(
      '</plugin.js>; rel="preload"; type="text/javascript; charset=utf-8"; title="a,b", </ordinary.js>; rel="modulepreload"',
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.type).toBe("text/javascript; charset=utf-8");
    expect(links[1]?.href).toBe("https://owned.test/ordinary.js");
  });

  it("counts quoted-pair escapes rather than treating every preceding slash as an escape", () => {
    const links = captureLinks(
      String.raw`</one.js>; title="ends with \\"; rel="preload", </two.js>; rel="modulepreload"`,
    );
    expect(links.map(({ href }) => href)).toEqual([
      "https://owned.test/one.js",
      "https://owned.test/two.js",
    ]);
    expect(links[0]?.rel).toEqual(["preload"]);
  });

  it("keeps a quoted escaped quote from exposing a delimiter", () => {
    const links = captureLinks(
      String.raw`</one.js>; title="quoted \" comma, value"; rel="preload", </two.js>; rel="modulepreload"`,
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.rel).toEqual(["preload"]);
  });

  it("retains the existing outside-policy classification", () => {
    const links = captureLinks(
      '<https://elsewhere.test/red,blue.js>; rel="preload", </ordinary.js>; rel="modulepreload"',
    );
    expect(links[0]?.destination_scope).toBe("outside_policy");
    expect(links[1]?.destination_scope).toBe("approved");
  });
});
describe("safe CDP response metadata referrer policy", () => {
  it.each<[string | undefined, string | null]>([
    [
      "no-referrer, strict-origin-when-cross-origin",
      "strict-origin-when-cross-origin",
    ],
    ["origin, future-policy", "origin"],
    ["future-policy, no-referrer", "no-referrer"],
    ["unsafe-url, NO-REFERRER", "no-referrer"],
    ["origin,, no-referrer", "no-referrer"],
    ["future-policy", null],
    ['unsafe-url, "no-referrer"', null],
    ["no-referrer; report-to=x, origin", null],
    ["", null],
    [undefined, null],
    ...[
      "no-referrer",
      "no-referrer-when-downgrade",
      "same-origin",
      "origin",
      "strict-origin",
      "origin-when-cross-origin",
      "strict-origin-when-cross-origin",
      "unsafe-url",
    ].map((policy): [string, string] => [policy, policy]),
  ])("normalizes declared Referrer-Policy %s", (raw, expected) => {
    const captured = safeResponseMetadata(
      "request-referrer",
      `${origin}/api`,
      {
        headers: {
          "Referrer-Policy": raw,
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      },
      new Set([origin]),
    );
    expect(captured.response.policies.referrer_policy).toBe(expected);
    expect(captured.response.policies.coop).toBe("same-origin");
  });
});
