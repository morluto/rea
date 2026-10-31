import type { WebPageInspection } from "../../domain/browserObservationSchemas.js";
import type { CapturedWebScript } from "../../domain/webScriptExport.js";
import { supportsJavaScriptSource } from "../../domain/browserScriptLanguage.js";

/** Project verified Debugger sources without fetching resource URLs. */
export const pageScripts = (
  capture: Pick<WebPageInspection, "scripts"> &
    Partial<Pick<WebPageInspection, "workers">>,
): CapturedWebScript[] => [
  ...capture.scripts.items.map((script): CapturedWebScript => ({
    source: {
      kind: "page-script",
      script_key: script.script_key,
      frame_id: script.frame_id,
      is_module: script.is_module,
      language: script.language,
      source_map_url: script.source_map_url,
    },
    url: script.url,
    content: scriptContent(script),
  })),
  ...(capture.workers ?? []).flatMap((worker) =>
    (worker.observation?.scripts ?? []).map((script): CapturedWebScript => ({
      source: {
        kind: "worker-script",
        target_id: worker.target_id,
        script_id: script.script_id,
        execution_context_id: script.execution_context_id,
        page_target_id: worker.observation?.page_target_id ?? null,
        ownership: worker.observation?.ownership ?? "unknown",
        is_module: script.is_module,
        language: script.language,
        source_map_url: script.source_map_url,
      },
      url: script.url,
      content: scriptContent(script),
    })),
  ),
];

const scriptContent = (
  script: Pick<
    WebPageInspection["scripts"]["items"][number],
    "source" | "language"
  >,
): CapturedWebScript["content"] =>
  !script.source.included
    ? {
        state: "unavailable",
        reason: "source-not-included",
        message: script.source.reason || "Debugger source was not included.",
      }
    : !supportsJavaScriptSource(script.language)
      ? {
          state: "unavailable",
          reason: "unsupported-language",
          message: `Debugger reported language ${script.language}; JavaScript export was not inferred.`,
        }
      : {
          state: "captured",
          bytes: Buffer.from(script.source.artifact.text, "utf8"),
          sha256: script.source.artifact.sha256,
          media_type: script.source.artifact.media_type,
          redacted: null,
          representation: "debugger-source-utf8",
        };
