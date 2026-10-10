import type {
  WebModuleArtifactPort,
  WebModuleArtifacts,
} from "../../application/WebModulePorts.js";
import type { WebScriptArtifactPort } from "../../application/WebScriptArtifactPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok } from "../../domain/result.js";
import type { WebModuleTraceInput } from "../../domain/webModuleTrace.js";
import { LocalWebScriptArtifacts } from "../assets/LocalWebScriptArtifacts.js";
import {
  readWebArtifactJson,
  webArtifactReadError,
} from "../assets/WebArtifactReads.js";

/** Add an explicitly selected import map to a verified captured-script source. */
export class LocalWebModuleArtifacts implements WebModuleArtifactPort {
  constructor(
    readonly scripts: WebScriptArtifactPort = new LocalWebScriptArtifacts(
      "trace_web_module_imports",
    ),
  ) {}

  /** Read selected source and optional map without website requests. */
  async load(input: WebModuleTraceInput, options?: ExecutionOptions) {
    const loaded = await this.scripts.load(input, options);
    if (!loaded.ok) return loaded;
    if (input.import_map === undefined)
      return ok({ ...loaded.value, importMap: null });
    const selected = input.import_map;
    try {
      const data = await readWebArtifactJson(
        selected.path,
        4 * 1024 * 1024,
        options?.signal,
      );
      const importMap: WebModuleArtifacts["importMap"] = {
        file: {
          path: selected.path,
          sha256: data.sha256,
          bytes: data.bytes.length,
        },
        baseUrl: selected.base_url,
        value: jsonObjectSchema.parse(data.value),
      };
      return ok({ ...loaded.value, importMap });
    } catch (cause: unknown) {
      return err(
        webArtifactReadError(
          cause,
          {
            operation: "trace_web_module_imports",
            field: ["import_map", "path"],
            targetPath: selected.path,
            callerSelected: true,
          },
          options?.signal,
        ),
      );
    }
  }
}
