import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { vsixPackageSummaryViewResultSchema } from "./analysisViewResult.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";

const report = {
  artifact: {
    path: "/artifacts/demo.vsix",
    sha256: "a".repeat(64),
    bytes: 100,
  },
  vsix_identity: {
    id: "demo.hello",
    version: "1.2.3",
    publisher: "demo",
    target_platform: null,
    display_name: "Hello Demo",
    description: null,
  },
  package_identity: {
    name: "hello",
    publisher: "demo",
    version: "1.2.3",
  },
  identity_disagreements: [],
  engine: {
    vsixmanifest: "^1.74.0",
    package_json: "^1.74.0",
    disagreement: false,
  },
  target_platform: null,
  entry_points: {
    main: { path: "extension/out/extension.js", present: true },
    browser: null,
  },
  activation_events: [
    { event: "onCommand:demo.hello", eager: false },
    { event: "*", eager: true },
  ],
  contributes: {
    keys: [{ name: "commands", count: 1 }],
    commands: [{ command: "demo.hello", title: "Say Hello" }],
    commands_total: 1,
    commands_omitted: 0,
  },
  extension_dependencies: {
    vsixmanifest: [],
    package_json: [],
    disagreement: false,
  },
  extension_pack: {
    vsixmanifest: [],
    package_json: [],
    disagreement: false,
  },
  extension_kind: [],
  capabilities: {
    untrusted_workspaces: null,
    virtual_workspaces: null,
  },
  enabled_api_proposals: [],
  assets: [],
  signatures: { p7s: false, manifest: false },
  contents: [
    {
      name: "extension.vsixmanifest",
      path: "extension.vsixmanifest",
      uncompressed_size: 12,
      compressed_size: 12,
      encrypted: false,
      kind: "vsixmanifest",
      traverses: false,
    },
  ],
  member_kind_counts: {
    vsixmanifest: 1,
    package_json: 0,
    content_types: 0,
    opc: 0,
    signature: 0,
    javascript: 0,
    native_addon: 0,
    wasm: 0,
    executable: 0,
    shell_script: 0,
    nested_archive: 0,
    unknown: 0,
  },
  interesting_members: [],
  duplicate_paths: [],
  vsixmanifest: { path: "extension.vsixmanifest", bytes: 12 },
  package_json: { path: "extension/package.json", bytes: 20 },
  coverage: { status: "complete", entries: 1, examined_manifest_bytes: 32 },
  limitations: ["Package condition"],
};

const parent = (): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "file",
    },
    { id: "rea-vsix-package", name: "REA VS Code vsix reader", version: "1" },
    {
      operation: "inspect_vsix_package",
      parameters: {},
      result: report,
      limitations: ["Parent condition"],
    },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: report,
    subject: evidence.subject,
    limitations: evidence.limitations,
  };
};

it("summarizes VS Code extension Evidence with identity and counts", () => {
  const result = projectAnalysisView(
    parent(),
    analysisViewRequestSchema.parse({ kind: "summary" }),
  );
  if (!result.ok) throw result.error;
  const view = vsixPackageSummaryViewResultSchema.parse(result.value);
  expect(view.summary).toMatchObject({
    vsix_identity: { id: "demo.hello", version: "1.2.3" },
    activation_event_count: 2,
    eager_activation_event_count: 1,
    content_count: 1,
    limitation_count: 1,
  });
  expect(view.limitations).toEqual(
    expect.arrayContaining(["Parent condition", "Package condition"]),
  );
});
