import { Client } from "@modelcontextprotocol/client";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";
import { analyzeJadxRequest, type JadxToolPort } from "./JadxAnalysis.js";
import { JadxMcpTransport, type JadxLauncher } from "./JadxMcpTransport.js";
import {
  jadxLoadSchema,
  jadxInputFailureSchema,
  jadxRuntimeSchema,
  parseJadxEnvelope,
  parseJadxJson,
} from "./JadxProtocol.js";
import {
  JADX_BRIDGE_IDENTITY,
  JADX_RELEASE,
  JADX_PROVIDER_IDENTITY,
  JADX_LIMITATIONS,
} from "./JadxRelease.js";

/** One owned engine connection; its wire protocol stays inside the Android adapter. */
export class JadxSession {
  readonly transport: JadxMcpTransport;
  readonly #client = new Client({ name: "rea-android-adapter", version: "1" });
  #loaded: ReturnType<typeof jadxLoadSchema.parse> | undefined;
  #connected = false;

  constructor(
    options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    launcher?: JadxLauncher,
  ) {
    this.transport = new JadxMcpTransport(options, launcher);
  }

  /** Analyze one admitted immutable APK, checking producer identity and selectors. */
  async execute(context: {
    readonly request: AndroidRequest;
    readonly target: BinaryTarget;
    readonly snapshot: string;
    readonly jarHash: string;
    readonly bridgeHash: string;
    readonly signal: AbortSignal;
  }): Promise<AnalysisExecution> {
    const { request, target, snapshot, jarHash, signal } = context;
    const abort = () => {
      void this.transport.close().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      this.transport.beginOperation();
      const raw: JsonValue[] = [];
      if (!this.#connected) {
        await this.#client.connect(this.transport, { timeout: 30_000 });
        this.#connected = true;
      }
      const server = this.#client.getServerVersion();
      if (
        server?.name !== JADX_BRIDGE_IDENTITY.name ||
        server.version !== JADX_BRIDGE_IDENTITY.version
      )
        throw new AnalysisCapabilityUnavailableError(
          "jadx",
          request.operation,
          `Expected ${JADX_BRIDGE_IDENTITY.name} ${JADX_BRIDGE_IDENTITY.version}; server reported ${server?.name ?? "unknown"} ${server?.version ?? "unknown"}.`,
        );
      const tools = this.#tools(request, target, signal, raw);
      const runtime = jadxRuntimeSchema.parse(
        await tools.json("rea_jvm_status", {}),
      );
      if (runtime.engine_reported_version !== JADX_RELEASE.version)
        throw new AnalysisCapabilityUnavailableError(
          "jadx",
          request.operation,
          `Expected engine ${JADX_RELEASE.version}; JAR reported ${runtime.engine_reported_version}.`,
        );
      const loaded =
        this.#loaded ??
        jadxLoadSchema.parse(
          await tools.json("load_apk", {
            path: snapshot,
            threads: 1,
            resources: "full",
          }),
        );
      if (loaded.apk_path !== snapshot)
        throw new AnalysisOutputError(
          request.operation,
          "JADX loaded a different APK path than the admitted snapshot",
        );
      this.#loaded = loaded;
      const engine = {
        name: "jadx-headless-mcp",
        version: runtime.engine_reported_version,
        artifact_sha256: jarHash,
        source_revision:
          jarHash === JADX_RELEASE.sha256 ? JADX_RELEASE.revision : null,
        worker_count: 1,
        heap_limit_mib:
          Math.floor(runtime.max_heap_bytes / (1024 * 1024)) || null,
      } as const;
      const result = await analyzeJadxRequest(tools, request, loaded, engine);
      return createAnalysisExecution(result, JADX_PROVIDER_IDENTITY, {
        rawResult: {
          server,
          bridge_sha256: context.bridgeHash,
          jar_sha256: jarHash,
          loaded,
          calls: raw,
        },
        subject: target,
        limitations: JADX_LIMITATIONS,
        locations:
          request.operation === "inspect_android_package"
            ? [{ kind: "artifact-path", path: "AndroidManifest.xml" }]
            : [],
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** Whether the selected Java runtime established the REA bridge protocol. */
  initialized(): boolean {
    return this.#connected;
  }

  /** Join owned cleanup even if SDK connection teardown itself fails. */
  async close(): Promise<void> {
    try {
      await this.#client.close();
    } finally {
      await this.transport.close();
    }
  }

  #tools(
    request: AndroidRequest,
    target: BinaryTarget,
    signal: AbortSignal,
    raw: JsonValue[],
  ): JadxToolPort {
    const call = async (
      name: string,
      input: Readonly<Record<string, JsonValue>>,
    ): Promise<string> => {
      signal.throwIfAborted();
      const response = await this.#client.callTool(
        { name, arguments: input },
        { timeout: 120_000, signal },
      );
      const envelope = parseJadxEnvelope(response, request.operation);
      raw.push({
        operation: name,
        input,
        response: jsonValueSchema.parse(response),
      });
      if (envelope.failed) {
        if (envelope.text.startsWith("{")) {
          const failure = jadxInputFailureSchema.safeParse(
            parseJadxJson(envelope.text, request.operation),
          );
          if (failure.success)
            throw new AnalysisInputError(request.operation, undefined, [
              {
                path: [failure.data.field],
                reason: "invalid_value",
                message: failure.data.message,
              },
            ]);
        }
        throw new ProviderAdapterError("jadx", request.operation, {
          diagnostics: {
            upstream_operation: name,
            reason: envelope.text,
            target_path: target.path,
            target_sha256: target.sha256,
          },
        });
      }
      return envelope.text;
    };
    return {
      text: call,
      json: async (name, input) =>
        parseJadxJson(await call(name, input), request.operation),
    };
  }
}
