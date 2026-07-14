import { describe, expect, it } from "vitest";

import { safeResponseMetadata } from "../src/browser/CdpSafeMetadata.js";

const origin = "https://app.example.test";

describe("safe CDP response metadata", () => {
  it("retains only allowlisted header structure and redacted approved links", () => {
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
          href: `${origin}/agent?token=%5BREDACTED%5D`,
          destination_scope: "approved",
          rel: ["mcp", "service-desc"],
          as: null,
          type: null,
          crossorigin: null,
        },
        expect.objectContaining({
          href: null,
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
      "link-secret",
      "nonce-secret",
      "hash-secret",
      "agent-header-secret",
      "private.example.test",
    ])
      expect(serialized).not.toContain(secret);
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
        url: `${origin}/.well-known/mcp?token=%5BREDACTED%5D`,
        trust: "page-declared-untrusted",
      },
    ]);
  });
});
