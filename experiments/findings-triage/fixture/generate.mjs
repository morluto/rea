import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const bundlePath = fileURLToPath(new URL("bundle.ndjson", import.meta.url));
// Analyze a temporary copy so the checkout path never enters Evidence subjects.
const work = await mkdtemp(join(tmpdir(), "findings-triage-"));
const app = join(work, "app");
const client = new Client({ name: "findings-triage-fixture", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "scripts/rea.mjs"), "mcp"],
  cwd: work,
  env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
});

const call = async (name, args) => {
  const reply = await client.callTool({ name, arguments: args });
  if (reply.isError)
    throw new Error(`${name} failed: ${JSON.stringify(reply.content)}`);
  return reply.structuredContent;
};

const recordUnknown = (analysisId, question, details) =>
  call("record_unknown", {
    question,
    required_environment: null,
    relationships: [],
    supporting_evidence_ids: [analysisId],
    ...details,
  });

try {
  await cp(fileURLToPath(new URL("app", import.meta.url)), app, {
    recursive: true,
  });
  await client.connect(transport);
  const analysis = await call("analyze_javascript_application", {
    input_path: app,
    format: "directory",
  });
  const id = analysis.evidence_id;
  await recordUnknown(
    id,
    "Which page scripts call window.notes.save, and can the path argument come from page input?",
    {
      severity: "high",
      domain: "electron-ipc",
      required_authority: "controlled-replay",
      required_confidence: "observed",
      recommended_probes: [
        {
          operation: "capture_electron_scenario",
          rationale:
            "The inline script in index.html was not analyzed; replay the save action and record the notes:save arguments.",
        },
      ],
    },
  );
  await recordUnknown(
    id,
    "Does the window with webSecurity disabled load content from outside the application directory?",
    {
      severity: "medium",
      domain: "electron-configuration",
      required_authority: "controlled-replay",
      required_confidence: "observed",
      recommended_probes: [
        {
          operation: "capture_electron_scenario",
          rationale: "Record every resource the window loads during use.",
        },
      ],
    },
  );
  const bridge = {
    severity: "medium",
    required_authority: "shipped-artifact",
    required_confidence: "derived",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
    supporting_evidence_ids: [id],
  };
  const recorded = await recordUnknown(
    id,
    "Does preload.js expose ipcRenderer or another Electron object directly to the page?",
    { ...bridge, domain: "electron-preload" },
  );
  await call("update_unknown", {
    ...bridge,
    unknown_id: recorded.result.unknown_id,
    expected_revision: 1,
    status: "resolved",
    contradicting_evidence_ids: [],
    resolution: {
      disposition: "verified",
      rationale:
        "The only recovered contextBridge exposure is the object literal notes with members load and save and no unknown members.",
      evidence_ids: [id],
    },
  });
  await call("export_evidence_bundle", { path: bundlePath, overwrite: true });
} finally {
  try {
    await client.close();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
