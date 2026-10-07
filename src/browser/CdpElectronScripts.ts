import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/javascript/electronObservation.js";
import { canonicalDigest } from "../domain/comparisonSemantics.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { requiredRecord, cdpStringValue } from "./CdpCaptureValues.js";
import type { ElectronScriptDraft } from "./CdpElectronScriptEvents.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";

interface ElectronScriptCaptureInput {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal?: AbortSignal;
  readonly request: InspectElectronPageInput;
  readonly scripts: readonly ElectronScriptDraft[];
  readonly executionContextFrames: ReadonlyMap<string, string>;
  readonly frameIds: ReadonlySet<string>;
  readonly completeness: CdpCaptureCompleteness;
}

/** Normalize local script metadata and optionally approved source. */
export const captureElectronScripts = async (
  input: ElectronScriptCaptureInput,
): Promise<ElectronPageInspection["scripts"]> => {
  let total = 0;
  const items: ElectronPageInspection["scripts"]["items"] = [];
  const seen = new Set<string>();
  for (const script of input.scripts) {
    const path = await authorizedElectronFile(script.rawUrl);
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
    const scriptKey = `electron_script_${canonicalDigest(identity, "CDP capture")}`;
    if (seen.has(scriptKey)) continue;
    seen.add(scriptKey);
    total += 1;
    const capturedSource = await captureScriptSource(input, script);
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
): Promise<{
  readonly source: ElectronScriptSource;
}> => {
  if (!input.request.include_script_sources)
    return {
      source: {
        included: false,
        reason: "source capture was not selected",
      },
    };
  const result = requiredRecord(
    await input.connection.send(
      "Debugger.getScriptSource",
      { scriptId: script.scriptId },
      input.sessionId,
      input.signal,
    ),
  );
  const text = cdpStringValue(result.scriptSource) ?? "";
  return {
    source: {
      included: true,
      artifact: createWebTextArtifact(text, "text/javascript"),
    },
  };
};
