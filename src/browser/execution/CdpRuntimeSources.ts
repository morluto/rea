import { z } from "zod";
import { webTextFacts } from "../../domain/webContentArtifact.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { sanitizeBrowserUrl } from "../../domain/browserObservation.js";
import { supportsJavaScriptSource } from "../../domain/browserScriptLanguage.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import type {
  WebRuntimeSource,
  webRuntimeLocationSchema,
} from "../../domain/webRuntime.js";
import type { CdpReceivedEvent } from "../CdpConnection.js";
import type { CdpRuntimeSession } from "./CdpRuntimeSession.js";
import {
  runtimeContextSchema,
  runtimeScriptParsedSchema,
  cdpContextFrameClaim,
  selectCdpScriptFrame,
} from "../CdpScriptContextFacts.js";
import { RuntimeRetention } from "./CdpRuntimeRetention.js";
import { errorMessage } from "../../kernel/errorMessage.js";

/** Source ownership is proven by execution context/frame metadata, independently of URL aliases. */
export class CdpRuntimeSources {
  readonly scripts = new Map<
    string,
    z.infer<typeof runtimeScriptParsedSchema>
  >();
  readonly #contexts = new Map<
    number,
    z.infer<typeof runtimeContextSchema>["context"]
  >();
  readonly #changed = new Set<string>();
  readonly #changedContexts = new Set<number>();
  readonly #sources = new Map<string, WebRuntimeSource>();
  readonly #metadata: RuntimeRetention;
  readonly #sourceText: RuntimeRetention;
  #failure: AnalysisError | undefined;
  constructor(readonly session: CdpRuntimeSession) {
    this.#metadata = new RuntimeRetention(session.operation, "metadata");
    this.#sourceText = new RuntimeRetention(session.operation, "sources");
  }

  /** Subscribe before enabling Debugger; existing uncollected scripts are replayed by the producer. */
  ingest(event: CdpReceivedEvent, retainNewMetadata = true): void {
    if (this.#failure !== undefined) return;
    const registered = event.registered;
    try {
      if (registered?.method === "Runtime.executionContextCreated") {
        const bytes = registered.payload.declarationBytes;
        if (!bytes.ok) throw bytes.error;
        this.#metadata.charge(bytes.value);
        const declaration = registered.payload.runtime;
        if (!declaration.success) throw declaration.error;
        const context = declaration.data.context;
        const previous = this.#contexts.get(context.id);
        if (
          previous !== undefined &&
          JSON.stringify(previous) !== JSON.stringify(context)
        ) {
          this.#changedContexts.add(context.id);
          for (const item of this.#sources.values())
            if (item.execution_context_id === context.id) this.revalidate(item);
        }
        if (retainNewMetadata) this.#contexts.set(context.id, context);
      } else if (registered?.method === "Debugger.scriptParsed") {
        const bytes = registered.payload.declarationBytes;
        if (!bytes.ok) throw bytes.error;
        this.#metadata.charge(bytes.value);
        const declaration = registered.payload.runtime;
        if (!declaration.success) throw declaration.error;
        const script = declaration.data;
        const previous = this.scripts.get(script.scriptId);
        if (
          previous !== undefined &&
          JSON.stringify(previous) !== JSON.stringify(script)
        ) {
          this.#changed.add(script.scriptId);
          const retained = this.#sources.get(script.scriptId);
          if (retained !== undefined) this.revalidate(retained);
        }
        if (retainNewMetadata) this.scripts.set(script.scriptId, script);
      }
    } catch (cause: unknown) {
      this.#failure =
        cause instanceof AnalysisError
          ? cause
          : new AnalysisOutputError(
              this.session.operation,
              errorMessage(cause),
            );
    }
  }

  /** Producer parse/resource failures are surfaced outside the transport event callback. */
  check(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  /** Frozen inventories still monitor known identities through asynchronous source reads. */
  verifyKnownIdentity(event: CdpReceivedEvent): void {
    const registered = event.registered;
    if (registered?.method === "Debugger.scriptParsed") {
      const { scriptId } = registered.payload.facts;
      if (scriptId !== undefined && this.scripts.has(scriptId))
        this.ingest(event, false);
    } else if (registered?.method === "Runtime.executionContextCreated") {
      const { id } = registered.payload.facts;
      if (id !== undefined && this.#contexts.has(id)) this.ingest(event, false);
    }
  }

  /** Only proven default worlds of the selected main frame establish website source ownership. */
  belongsToDocument(scriptId: string): boolean {
    const script = this.scripts.get(scriptId);
    if (
      script === undefined ||
      this.#changed.has(scriptId) ||
      this.#changedContexts.has(script.executionContextId)
    )
      return false;
    const scriptContext = script.executionContextAuxData;
    const context = this.#contexts.get(script.executionContextId)?.auxData;
    const worlds = [scriptContext, context];
    if (
      worlds.some(
        (world) =>
          world?.isDefault === false ||
          (world?.type !== undefined && world.type !== "default"),
      ) ||
      !worlds.some(
        (world) => world?.isDefault === true || world?.type === "default",
      )
    )
      return false;
    const frame = selectCdpScriptFrame(
      cdpContextFrameClaim(scriptContext),
      cdpContextFrameClaim(context),
    );
    return (
      !frame.invalid &&
      !frame.conflicting &&
      frame.frameId === this.session.target.frame_id
    );
  }

  /** Retain complete script text and compute a digest distinct from the producer hash. */
  async read(scriptIds: Iterable<string>): Promise<WebRuntimeSource[]> {
    this.check();
    for (const scriptId of new Set(scriptIds)) {
      if (this.#sources.has(scriptId)) continue;
      const script = this.scripts.get(scriptId);
      const owned = this.belongsToDocument(scriptId);
      const context =
        script === undefined
          ? undefined
          : this.#contexts.get(script.executionContextId);
      const item: WebRuntimeSource = {
        script_id: scriptId,
        url: this.sourceUrl(scriptId, script?.url ?? ""),
        execution_context_id: script?.executionContextId ?? null,
        reported_execution_context:
          context === undefined ? null : jsonObjectSchema.parse(context),
        reported_script_context_aux_data:
          script?.executionContextAuxData === undefined
            ? null
            : jsonObjectSchema.parse(script.executionContextAuxData),
        frame_id: owned ? this.session.target.frame_id : null,
        producer_hash: script?.hash ?? null,
        source_map_url: script?.sourceMapURL ?? null,
        has_source_url: script?.hasSourceURL ?? null,
        language: script?.scriptLanguage ?? null,
        resource_start:
          script !== undefined
            ? {
                line_number: script.startLine,
                column_number: script.startColumn,
              }
            : null,
        source: {
          state: "excluded",
          reason: this.#changed.has(scriptId)
            ? "The script changed identity during observation; source attribution is unknown."
            : "Selected main-document default-world ownership was not established.",
        },
      };
      if (owned && supportsJavaScriptSource(script?.scriptLanguage))
        item.source = await this.capture(scriptId);
      else if (owned)
        item.source = {
          state: "excluded",
          reason: `Debugger reported language ${script?.scriptLanguage}; it is outside this JavaScript source operation.`,
        };
      this.revalidate(item);
      this.#sources.set(scriptId, item);
    }
    this.check();
    return [...this.#sources.values()];
  }

  /** Resolve an exact producer script ID; URL equality is never an identity fallback. */
  location(
    scriptId: string,
    url: string | null,
    line: number,
    column: number | null,
    functionName: string | null = null,
  ): z.infer<typeof webRuntimeLocationSchema> {
    return {
      script_id: scriptId,
      url: url === null ? null : this.sourceUrl(scriptId, url),
      line_number: line,
      column_number: column,
      function_name: functionName,
      source_association: this.belongsToDocument(scriptId)
        ? "script_id"
        : "unknown",
    };
  }

  /** Declared script names are inert evidence; known resource URLs omit transport userinfo. */
  sourceUrl(scriptId: string, url: string): string {
    return !this.#changed.has(scriptId) &&
      this.scripts.get(scriptId)?.hasSourceURL === false
      ? sanitizeBrowserUrl(url).url
      : url;
  }

  private revalidate(item: WebRuntimeSource): void {
    if (item.frame_id === null || this.belongsToDocument(item.script_id))
      return;
    const previous =
      item.source.state === "unavailable"
        ? ` Previous source read failure: ${item.source.reason}`
        : "";
    item.frame_id = null;
    item.source = {
      state: "excluded",
      reason: `The script or context changed identity during source collection; attribution is unknown.${previous}`,
    };
  }

  private async capture(scriptId: string): Promise<WebRuntimeSource["source"]> {
    let text: string;
    try {
      ({ scriptSource: text } = await this.session.command(
        "Debugger.getScriptSource",
        { scriptId },
      ));
    } catch (cause: unknown) {
      if (
        this.session.options.signal?.aborted ||
        !(cause instanceof AnalysisError)
      )
        throw cause;
      // A failed or malformed reply limits only this script. The reason is the
      // boundary's own failure text, which names a malformed reply's pointer.
      return {
        state: "unavailable",
        reason: cause.userMessage ?? cause.message,
      };
    }
    this.#sourceText.charge(Buffer.byteLength(text));
    const facts = webTextFacts(text);
    return {
      state: "captured",
      text,
      sha256: facts.sha256,
      utf8_bytes: facts.utf8Bytes,
      utf16_units: facts.utf16Units,
    };
  }
}
