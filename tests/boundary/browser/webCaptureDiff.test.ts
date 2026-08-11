import { afterEach, describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  compareWebCaptures,
  compareWebCapturesInputSchema,
  webCaptureDiffSchema,
} from "../../../src/domain/webCaptureDiff.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];
const expectInvalidDiff = (input: unknown): void => {
  expect(webCaptureDiffSchema.safeParse(input).success).toBe(false);
};

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

describe("web capture diff", () => {
  it("reports stable observed changes while preserving unknown dimensions", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const after = structuredClone(captured.value);
    after.scripts.items = [];
    const request = after.network.requests[0];
    if (request !== undefined) request.status = 204;

    const result = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: after },
      }),
    );

    expect(result.overall_status).toBe("changed");
    expect(result.dimensions.scripts).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [expect.objectContaining({ change: "removed" })],
    });
    expect(result.dimensions.network).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "modified" })],
    });
    expect(result.dimensions.webmcp).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
    expectInvalidDiff({ ...result, overall_status: "unchanged" });
    expectInvalidDiff({
      ...result,
      dimensions: {
        ...result.dimensions,
        webmcp: { ...result.dimensions.webmcp, reason: null },
      },
    });
    expectInvalidDiff({
      ...result,
      dimensions: {
        ...result.dimensions,
        scripts: { ...result.dimensions.scripts, total_changes: 2 },
      },
    });
    const {
      accessibility: _accessibility,
      storage: _storage,
      ...legacy
    } = result.dimensions;
    const parsedLegacy = webCaptureDiffSchema.parse({
      ...result,
      dimensions: legacy,
    });
    expect(parsedLegacy.dimensions.accessibility.status).toBe("unknown");
    expect(parsedLegacy.dimensions.storage.status).toBe("unknown");
  });

  it("does not claim unchanged when a relevant section is incomplete", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const incomplete = structuredClone(captured.value);
    incomplete.completeness.truncated_sections.push("dom");

    const result = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: incomplete },
        after: { inspection: captured.value },
      }),
    );

    expect(result.dimensions.dom_structure.status).toBe("unknown");
    expect(result.dimensions.dom_structure.reason).toContain("incomplete");
  });

  it("ignores transient request IDs and capture-approval state", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const after = structuredClone(captured.value);
    const request = after.network.requests[0];
    if (request !== undefined) request.request_id = "different-cdp-request-id";
    const response = after.metadata.responses[0];
    if (response !== undefined)
      response.request_id = "different-cdp-request-id";
    const script = after.scripts.items[0];
    if (script !== undefined && !script.source.included)
      script.source.reason = "different approval explanation";
    markSectionsComplete(captured.value, ["scripts", "metadata"]);
    markSectionsComplete(after, ["scripts", "metadata"]);

    const result = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: after },
      }),
    );

    expect(result.dimensions.scripts.status).toBe("unchanged");
    expect(result.dimensions.metadata.status).toBe("unchanged");
    expect(result.dimensions.network.status).toBe("unknown");
    expect(result.dimensions.network.total_changes).toBe(0);
  });
});

describe("web capture diff semantics and fingerprints", () => {
  it("detects accessibility semantics and storage inventory changes", async () => {
    const browser = await startFakeCdpBrowser({ extraCollections: true });
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_accessibility_text: true,
        include_storage_keys: true,
        include_storage_fingerprints: true,
      }),
    );
    if (!captured.ok) throw captured.error;
    const compareAfter = (after: typeof captured.value) =>
      compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: captured.value },
          after: { inspection: after },
        }),
      );
    const roleChanged = structuredClone(captured.value);
    const namedNode = roleChanged.accessibility.nodes[0];
    if (namedNode === undefined)
      throw new Error("Expected accessibility nodes");
    namedNode.role = "menuitem";

    const nameChanged = structuredClone(captured.value);
    const renamedNode = nameChanged.accessibility.nodes[0];
    if (renamedNode === undefined)
      throw new Error("Expected accessibility nodes");
    renamedNode.name = "Send report";

    const stateChanged = structuredClone(captured.value);
    const stateNode = stateChanged.accessibility.nodes[0];
    const disabledState = stateNode?.states.find(
      ({ name }) => name === "disabled",
    );
    if (disabledState === undefined)
      throw new Error("Expected an accessibility state");
    disabledState.value = true;

    const hierarchyChanged = structuredClone(captured.value);
    const childNode = hierarchyChanged.accessibility.nodes[1];
    if (childNode === undefined)
      throw new Error("Expected an accessibility child");
    childNode.parent_id = null;

    const storageChanged = structuredClone(captured.value);
    storageChanged.storage.local_storage_keys.push("new-key");

    for (const after of [
      roleChanged,
      nameChanged,
      stateChanged,
      hierarchyChanged,
    ])
      expect(compareAfter(after).dimensions.accessibility).toMatchObject({
        status: "changed",
        changes: [
          {
            identity: "accessibility_tree",
            change: "modified",
          },
        ],
      });
    expect(compareAfter(storageChanged).dimensions.storage).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "added" })],
    });
  });
});

describe("web capture diff completeness", () => {
  it("uses complete redacted fingerprints but keeps incomplete evidence unknown", async () => {
    const browser = await startFakeCdpBrowser({ extraCollections: true });
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_accessibility_text: true,
        include_storage_keys: true,
        include_storage_fingerprints: true,
      }),
    );
    if (!captured.ok) throw captured.error;
    const identical = structuredClone(captured.value);
    const identity = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: identical },
      }),
    );
    expect(identity.dimensions.accessibility.status).toBe("unchanged");
    expect(identity.dimensions.storage).toMatchObject({
      status: "unchanged",
      total_changes: 0,
    });

    const changedFingerprint = structuredClone(captured.value);
    const fingerprint = changedFingerprint.storage.content_fingerprints.find(
      ({ complete, value_sha256: valueSha256 }) =>
        complete && valueSha256 !== null,
    );
    if (fingerprint === undefined || fingerprint.value_sha256 === null)
      throw new Error("Expected a complete content fingerprint");
    fingerprint.value_sha256 = "f".repeat(64);
    const storageChanged = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: changedFingerprint },
      }),
    );
    expect(storageChanged.dimensions.storage).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [expect.objectContaining({ change: "modified" })],
    });

    const incompleteStorage = structuredClone(captured.value);
    incompleteStorage.storage.fingerprints_complete = false;
    const storageUnknown = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: incompleteStorage },
      }),
    );
    expect(storageUnknown.dimensions.storage).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });

    const evidenceQualityChanged = structuredClone(captured.value);
    evidenceQualityChanged.storage.fingerprints_complete = false;
    const incompleteFingerprint =
      evidenceQualityChanged.storage.content_fingerprints[0];
    if (incompleteFingerprint === undefined)
      throw new Error("Expected a content fingerprint");
    incompleteFingerprint.complete = false;
    const evidenceOnly = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: evidenceQualityChanged },
      }),
    );
    expect(evidenceOnly.dimensions.storage).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });

    const withoutText = structuredClone(captured.value);
    withoutText.accessibility.text_capture.status = "not_approved";
    withoutText.accessibility.text_capture.excluded_fields = 1;
    for (const node of withoutText.accessibility.nodes) {
      node.name = null;
      node.description = null;
    }
    const missingText = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: withoutText },
      }),
    );
    expect(missingText.dimensions.accessibility).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });

    const truncated = structuredClone(captured.value);
    truncated.accessibility.total_nodes += 1;
    truncated.completeness.truncated_sections.push("accessibility");
    const incompleteTree = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: truncated },
        after: { inspection: structuredClone(truncated) },
      }),
    );
    expect(incompleteTree.dimensions.accessibility).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
  });
});

const markSectionsComplete = (
  inspection: {
    completeness: {
      policy_filtered_sections: string[];
      attach_limited_sections: string[];
      truncated_sections: string[];
      unavailable_sections: string[];
    };
  },
  sections: readonly string[],
): void => {
  const completed = new Set(sections);
  for (const key of [
    "policy_filtered_sections",
    "attach_limited_sections",
    "truncated_sections",
    "unavailable_sections",
  ] as const)
    inspection.completeness[key] = inspection.completeness[key].filter(
      (section) => !completed.has(section),
    );
};
