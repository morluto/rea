import type { WebSourceLocationArtifactPort } from "../../application/WebSourceLocationPorts.js";
import type { WebScriptArtifactPort } from "../../application/WebScriptArtifactPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
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
  readonly scripts: WebScriptArtifactPort;
  readonly #resources: ArtifactResourceScope;

  constructor(
    scripts?: WebScriptArtifactPort,
    resources = scripts instanceof LocalWebScriptArtifacts
      ? scripts.resources
      : new ArtifactResourceScope(),
  ) {
    this.#resources = resources;
    this.scripts =
      scripts ??
      new LocalWebScriptArtifacts("trace_web_source_location", resources);
  }

  async close(): Promise<void> {
    const closeScript =
      this.scripts instanceof LocalWebScriptArtifacts &&
      this.scripts.resources === this.#resources
        ? undefined
        : this.scripts.close?.bind(this.scripts);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.#resources.close()),
      ...(closeScript === undefined
        ? []
        : [Promise.resolve().then(closeScript)]),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Web source-location artifact cleanup failed",
      );
  }

  /** Preserve actual map identity separately from the selected deployment URL. */
  async load(input: WebSourceLocationInput, options?: ExecutionOptions) {
    try {
      return await this.#resources.run(() => this.#load(input, options));
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

  async #load(input: WebSourceLocationInput, options?: ExecutionOptions) {
    const loaded = await this.scripts.load(input, options);
    if (!loaded.ok) return loaded;
    try {
      const data = await readStableArtifact(
        input.source_map.path,
        WEB_SOURCE_MAP_LIMITS.mapBytes,
        options?.signal,
        undefined,
        this.#resources,
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
