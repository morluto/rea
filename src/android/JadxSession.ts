import { Client } from "@modelcontextprotocol/client";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { AndroidRequest } from "../domain/android/androidAnalysis.js";
import {
  AnalysisCapabilityUnavailableError,
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
  parseJadxEnvelope,
  parseJadxJson,
} from "./JadxProtocol.js";
import {
  JADX_HEAP_LIMIT_MIB,
  JADX_RELEASE,
  JADX_PROVIDER_IDENTITY,
  JADX_LIMITATIONS,
} from "./JadxRelease.js";

/** One owned engine connection; its wire protocol stays inside the Android adapter. */
export class JadxSession {
  readonly transport: JadxMcpTransport;
  readonly #client = new Client({ name: "rea-android-adapter", version: "1" });
  readonly #raw: JsonValue[] = [];

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
    readonly signal: AbortSignal;
  }): Promise<AnalysisExecution> {
    const { request, target, snapshot, jarHash, signal } = context;
    const abort = () => {
      void this.transport.close().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await this.#client.connect(this.transport, { timeout: 30_000 });
      const server = this.#client.getServerVersion();
      if (
        server?.name !== "jadx-headless-mcp" ||
        server.version !== JADX_RELEASE.version
      )
        throw new AnalysisCapabilityUnavailableError(
          "jadx",
          request.operation,
          `Expected jadx-headless-mcp ${JADX_RELEASE.version}; server reported ${server?.name ?? "unknown"} ${server?.version ?? "unknown"}.`,
        );
      const tools = this.#tools(request, target, signal);
      const loaded = jadxLoadSchema.parse(
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
      const engine = {
        name: "jadx-headless-mcp",
        version: JADX_RELEASE.version,
        artifact_sha256: jarHash,
        source_revision:
          jarHash === JADX_RELEASE.sha256 ? JADX_RELEASE.revision : null,
        worker_count: 1,
        heap_limit_mib: JADX_HEAP_LIMIT_MIB,
      } as const;
      const result = await analyzeJadxRequest(tools, request, loaded, engine);
      return createAnalysisExecution(result, JADX_PROVIDER_IDENTITY, {
        rawResult: { server, jar_sha256: jarHash, calls: this.#raw },
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
      this.#raw.push({
        operation: name,
        input,
        response: jsonValueSchema.parse(response),
      });
      if (envelope.failed)
        throw new ProviderAdapterError("jadx", request.operation, {
          diagnostics: {
            upstream_operation: name,
            reason: envelope.text,
            target_path: target.path,
            target_sha256: target.sha256,
          },
        });
      return envelope.text;
    };
    return {
      text: call,
      json: async (name, input) =>
        parseJadxJson(await call(name, input), request.operation),
    };
  }
}
