import { describe, expect, it } from "vitest";

import { safeResponseMetadata } from "../../../src/browser/CdpSafeMetadata.js";

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
