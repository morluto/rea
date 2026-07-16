import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/electronObservation.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { requiredRecord, stringValue } from "./CdpCaptureValues.js";
import type { ElectronScriptDraft } from "./CdpElectronScriptEvents.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";

interface ElectronScriptCaptureInput {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal?: AbortSignal;
  readonly request: InspectElectronPageInput;
  readonly roots: readonly string[];
  readonly scripts: readonly ElectronScriptDraft[];
  readonly executionContextFrames: ReadonlyMap<string, string>;
  readonly frameIds: ReadonlySet<string>;
  readonly completeness: CdpCaptureCompleteness;
}

/** Normalize root-confined script metadata and optionally approved source. */
export const captureElectronScripts = async (
  input: ElectronScriptCaptureInput,
): Promise<ElectronPageInspection["scripts"]> => {
  let total = 0;
  let sourceBytes = 0;
  const items: ElectronPageInspection["scripts"]["items"] = [];
  const seen = new Set<string>();
  for (const script of input.scripts) {
    const path = await authorizedElectronFile(script.rawUrl, input.roots);
    if (path === undefined) {
      input.completeness.exclude("scripts", "out_of_target_scope");
      continue;
    }
    const mappedFrame =
      script.executionContextKey === null
        ? undefined
        : input.executionContextFrames.get(script.executionContextKey);
    const identity = {
      frame_id:
        mappedFrame !== undefined && input.frameIds.has(mappedFrame)
          ? mappedFrame
          : null,
      file_path: path,
      cdp_hash: script.hash,
      length: script.length,
      is_module: script.isModule,
      language: script.language,
    };
    const scriptKey = `electron_script_${digest(identity)}`;
    if (seen.has(scriptKey)) continue;
    seen.add(scriptKey);
    total += 1;
    if (items.length >= input.request.limits.max_scripts) {
      input.completeness.drop("scripts");
      continue;
    }
    const capturedSource = await captureScriptSource(
      input,
      script,
      sourceBytes,
    );
    sourceBytes += capturedSource.bytes;
    items.push({
      script_key: scriptKey,
      ...identity,
      source: capturedSource.source,
    });
  }
  if (!input.request.include_script_sources)
    input.completeness.exclude("script_sources", "not_approved", total);
  return {
    total,
    items: items.sort((left, right) =>
      left.script_key.localeCompare(right.script_key),
    ),
  };
};

type ElectronScriptSource =
  ElectronPageInspection["scripts"]["items"][number]["source"];

const captureScriptSource = async (
  input: ElectronScriptCaptureInput,
  script: ElectronScriptDraft,
  sourceBytes: number,
): Promise<{
  readonly source: ElectronScriptSource;
  readonly bytes: number;
}> => {
  if (!input.request.include_script_sources)
    return {
      source: {
        included: false,
        reason: "source capture was not approved",
      },
      bytes: 0,
    };
  if (sourceLimitReached(input.request.limits, script.length, sourceBytes))
    return sourceLimitResult(input.completeness);
  const result = requiredRecord(
    await input.connection.send(
      "Debugger.getScriptSource",
      { scriptId: script.scriptId },
      input.sessionId,
      input.signal,
    ),
  );
  const text = stringValue(result.scriptSource) ?? "";
  const bytes = Buffer.byteLength(text);
  if (sourceLimitReached(input.request.limits, bytes, sourceBytes))
    return sourceLimitResult(input.completeness);
  return {
    source: {
      included: true,
      artifact: createWebTextArtifact(text, "text/javascript"),
    },
    bytes,
  };
};

const sourceLimitReached = (
  limits: InspectElectronPageInput["limits"],
  bytes: number,
  previousBytes: number,
): boolean =>
  bytes > limits.max_script_source_bytes ||
  previousBytes + bytes > limits.max_total_script_source_bytes;

const sourceLimitResult = (
  completeness: CdpCaptureCompleteness,
): { readonly source: ElectronScriptSource; readonly bytes: 0 } => {
  completeness.truncate("script_sources");
  return {
    source: { included: false, reason: "script source byte limit reached" },
    bytes: 0,
  };
};

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("Expected canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
