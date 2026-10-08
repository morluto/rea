import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { LocalWebScriptArtifacts } from "./LocalWebScriptArtifacts.js";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const manifestFor = (
  outputDirectory: string,
  entry: { relative_path: string; bytes: Buffer },
) => ({
  capture_path: join(outputDirectory, "capture.json"),
  capture_sha256: sha256(Buffer.from("capture")),
  capture_kind: "page-inspection",
  source_evidence_id: null,
  capture_completeness: {
    status: "complete_within_window",
    conditions: ["complete_within_window"],
    policy_filtered_sections: [],
    attach_limited_sections: [],
    truncated_sections: [],
    unavailable_sections: [],
    excluded: [],
    dropped_events: {
      scripts: 0,
      network_requests: 0,
      console_events: 0,
      websocket_connections: 0,
      websocket_frames: 0,
      webmcp_tools: 0,
      timeline_events: 0,
      total: 0,
    },
  },
  output_directory: outputDirectory,
  analysis_input: null,
  scripts: [
    {
      source: {
        kind: "page-script",
        script_key: "script-0",
        frame_id: null,
        is_module: true,
        language: null,
        source_map_url: null,
      },
      url: "https://example.test/app.js",
      content: {
        state: "exported",
        relative_path: entry.relative_path,
        layout: "url-path",
        layout_reason: null,
        sha256: sha256(entry.bytes),
        bytes: entry.bytes.byteLength,
        media_type: "text/javascript",
        redacted: null,
        representation: "debugger-source-utf8",
      },
    },
  ],
  limitations: [],
});

const exportTree = async (entry: { relative_path: string; bytes: Buffer }) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-web-scripts-"));
  await mkdir(join(directory, "files"), { recursive: true });
  const sourcePath = join(
    directory,
    "files",
    ...entry.relative_path.split("/"),
  );
  await mkdir(join(sourcePath, ".."), { recursive: true });
  await writeFile(sourcePath, entry.bytes);
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifestFor(directory, entry)));
  return { directory, manifestPath, sourcePath };
};

describe("LocalWebScriptArtifacts manifest path spellings", () => {
  const source = Buffer.from("export const value = 1;\n", "utf8");

  it.each([
    ["absolute", (manifestPath: string) => manifestPath],
    [
      "forward-slash",
      (manifestPath: string) => manifestPath.split(sep).join("/"),
    ],
    [
      "cwd-relative",
      (manifestPath: string) => relative(process.cwd(), manifestPath),
    ],
    [
      "dot-slash relative",
      (manifestPath: string) => `./${relative(process.cwd(), manifestPath)}`,
    ],
  ])(
    "loads the selected source through a %s manifest_path",
    async (_, spelling) => {
      const { manifestPath } = await exportTree({
        relative_path: "app.js",
        bytes: source,
      });
      const result = await new LocalWebScriptArtifacts(
        "trace_web_module_imports",
      ).load({ manifest_path: spelling(manifestPath), script_index: 0 });
      expect(result).toMatchObject({
        ok: true,
        value: { source: source.toString("utf8") },
      });
      if (result.ok)
        expect(result.value.manifestFile.path).toBe(spelling(manifestPath));
    },
  );

  it("still rejects a source escaping the manifest directory", async () => {
    const { manifestPath } = await exportTree({
      relative_path: "../outside/app.js",
      bytes: source,
    });
    const result = await new LocalWebScriptArtifacts(
      "trace_web_module_imports",
    ).load({ manifest_path: manifestPath, script_index: 0 });
    expect(result.ok).toBe(false);
  });
});
