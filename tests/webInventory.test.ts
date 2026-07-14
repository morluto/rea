import { describe, expect, it } from "vitest";

import {
  reconcileCapturedWebScript,
  reconcileWebScript,
  stableWebResources,
  stableWebScriptKey,
} from "../src/domain/webInventory.js";
import {
  createWebTextArtifact,
  webTextArtifactSchema,
} from "../src/domain/webContentArtifact.js";

describe("web content artifacts", () => {
  it("binds UTF-8 content, size, digest, and URI", () => {
    const artifact = createWebTextArtifact(
      "const marker = '😀';",
      "text/javascript",
    );
    expect(webTextArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.bytes).toBe(Buffer.byteLength(artifact.text));
    expect(artifact.uri).toBe(`rea://web-content/sha256/${artifact.sha256}`);
  });

  it("rejects altered content that reuses an artifact digest", () => {
    const artifact = createWebTextArtifact("original", "text/javascript");
    expect(
      webTextArtifactSchema.safeParse({ ...artifact, text: "altered!" })
        .success,
    ).toBe(false);
  });
});

describe("stable web inventory", () => {
  const script = {
    url: "https://app.example.test/assets/app.js",
    cdp_hash: "stable-cdp-hash",
    length: 1_024,
    is_module: true,
    language: "JavaScript",
    source_map_url: "https://app.example.test/assets/app.js.map",
  };

  it("excludes transient CDP and target identity from script keys", () => {
    expect(stableWebScriptKey(script)).toBe(stableWebScriptKey({ ...script }));
    expect(stableWebScriptKey({ ...script, length: 1_025 })).not.toBe(
      stableWebScriptKey(script),
    );
  });

  it("sorts resources deterministically and reconciles only exact URLs", () => {
    const inputs = [
      {
        url: "https://app.example.test/assets/vendor.js",
        origin: "https://app.example.test",
        type: "Script",
        mime_type: "text/javascript",
        content_size: 200,
      },
      {
        url: script.url,
        origin: "https://app.example.test",
        type: "Script",
        mime_type: "text/javascript",
        content_size: 1_024,
      },
    ];
    const forward = stableWebResources(inputs);
    const reverse = stableWebResources([...inputs].reverse());

    expect(reverse).toEqual(forward);
    expect(reconcileWebScript(script, forward)).toEqual({
      status: "exact",
      resource_key: forward.find(({ url }) => url === script.url)?.resource_key,
    });
    expect(
      reconcileWebScript({ ...script, url: `${script.url}?v=2` }, forward),
    ).toEqual({ status: "unmatched", reason: "no_exact_sanitized_url" });
  });

  it("reports duplicate resource observations as ambiguous", () => {
    const duplicate = {
      url: script.url,
      origin: "https://app.example.test",
      type: "Script",
      mime_type: "text/javascript",
      content_size: 1_024,
    };
    const resources = stableWebResources([
      duplicate,
      { ...duplicate, content_size: 2_048 },
    ]);

    expect(reconcileWebScript(script, resources)).toEqual({
      status: "ambiguous",
      candidate_resource_keys: resources
        .map(({ resource_key }) => resource_key)
        .sort(),
    });
  });

  it("deduplicates identical resource observations by stable identity", () => {
    const duplicate = {
      url: script.url,
      origin: "https://app.example.test",
      type: "Script",
      mime_type: "text/javascript",
      content_size: 1_024,
    };

    expect(stableWebResources([duplicate, duplicate])).toEqual(
      stableWebResources([duplicate]),
    );
  });

  it("reconciles raw URLs independently of stable inventory sort order", () => {
    const app = {
      url: script.url,
      origin: "https://app.example.test",
      type: "Script",
      mime_type: "text/javascript",
      content_size: 1_024,
      rawUrl: `${script.url}?token=secret`,
    };
    const vendor = {
      url: "https://app.example.test/assets/vendor.js",
      origin: "https://app.example.test",
      type: "Script",
      mime_type: "text/javascript",
      content_size: 2_048,
      rawUrl: "https://app.example.test/assets/vendor.js?v=1",
    };

    for (const rawResources of [
      [app, vendor],
      [vendor, app],
    ]) {
      const resources = stableWebResources(
        rawResources.map(({ rawUrl: _rawUrl, ...resource }) => resource),
      );
      expect(
        reconcileCapturedWebScript(
          { ...script, rawUrl: app.rawUrl },
          rawResources,
          resources,
        ),
      ).toEqual({
        status: "exact",
        resource_key: resources.find(({ url }) => url === script.url)
          ?.resource_key,
      });
    }
  });
});
