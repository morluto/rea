import type { WebSourceLocationArtifactPort } from "../../application/WebSourceLocationPorts.js";
import type { WebScriptArtifactPort } from "../../application/WebScriptArtifactPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  WEB_SOURCE_MAP_LIMITS,
  type WebSourceLocationInput,
} from "../../domain/webSourceLocation.js";
import { err, ok } from "../../domain/result.js";
import { LocalWebScriptArtifacts } from "./LocalWebScriptArtifacts.js";
import { decodeWebArtifact, webArtifactReadError } from "./WebArtifactReads.js";

/** Read one verified capture source and the caller-selected map, without fetching. */
export class LocalWebSourceLocationArtifacts implements WebSourceLocationArtifactPort {
  constructor(
    readonly scripts: WebScriptArtifactPort = new LocalWebScriptArtifacts(
      "trace_web_source_location",
    ),
  ) {}

  /** Preserve actual map identity separately from the selected deployment URL. */
  async load(input: WebSourceLocationInput, options?: ExecutionOptions) {
    const loaded = await this.scripts.load(input, options);
    if (!loaded.ok) return loaded;
    try {
      const data = await readStableArtifact(
        input.source_map.path,
        WEB_SOURCE_MAP_LIMITS.mapBytes,
        options?.signal,
      );
      return ok({
        ...loaded.value,
        sourceMap: {
          file: {
            path: input.source_map.path,
            sha256: data.sha256,
            bytes: data.bytes.length,
          },
          url: input.source_map.url,
          text: decodeWebArtifact(data.bytes),
        },
      });
    } catch (cause: unknown) {
      return err(
        webArtifactReadError(
          cause,
          {
            operation: "trace_web_source_location",
            field: ["source_map", "path"],
            targetPath: input.source_map.path,
            callerSelected: true,
          },
          options?.signal,
        ),
      );
    }
  }
}
