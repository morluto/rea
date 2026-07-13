import type { BinaryTarget } from "../domain/binaryTarget.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
  EvidenceLimitError,
  AnalysisCancelledError,
  NoBinaryOpenError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Evidence } from "../domain/evidence.js";
import { createEvidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import type {
  AnalysisClient,
  AnalysisExecution,
  AnalysisClientFactory,
  AnalysisOperationPort,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import { EvidenceLedger } from "./EvidenceLedger.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import { UnknownRegistryError } from "../domain/errors.js";
import type { AnalysisOperation } from "./AnalysisProvider.js";
import { enhancedToolNameSchema } from "../contracts/enhancedInputs.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/toolContracts.js";

const REGISTRY_PROVIDER: ProviderIdentity = {
  id: "rea-unknown-registry",
  name: "REA residual unknown registry",
  version: "1",
};
const OFFICIAL_OPERATIONS: ReadonlySet<string> = new Set(
  OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name),
);

/** Target lifecycle used by CLI and MCP without exposing a concrete provider. */
export interface BinarySessionPort extends AnalysisOperationPort {
  open(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
    },
  ): Promise<Result<BinaryTarget, AnalysisError>>;
  close(): Promise<Result<null, AnalysisError>>;
  status(): JsonValue;
  activeTarget(): BinaryTarget | undefined;
  recordEvidence(
    evidence: Evidence,
  ): Result<"added" | "duplicate", EvidenceIntegrityError | EvidenceLimitError>;
  hasEvidence(evidenceId: string): boolean;
  evidenceById(evidenceId: string): Evidence | undefined;
  exportEvidenceBundle(): EvidenceBundle;
  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError | EvidenceLimitError>;
  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError>;
  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError>;
  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError>;
  listUnknowns(filters?: {
    readonly status?: UnknownStatus;
    readonly severity?: ResidualUnknown["severity"];
    readonly domain?: string;
  }): ResidualUnknown[];
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  >;
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity;
}

/**
 * Owns the single active target shared by CLI and MCP adapters.
 *
 * Target transitions are serialized because each client dispatches Hopper API
 * work on its dedicated Python thread, and switching targets tears that bridge
 * down. A failed switch recreates the previous target instead of retaining a
 * client whose bridge was already shut down.
 */
export class BinarySession implements BinarySessionPort {
  #active:
    | { readonly target: BinaryTarget; readonly client: AnalysisClient }
    | undefined;
  #transition: Promise<void> = Promise.resolve();
  readonly #calls = new Set<Promise<unknown>>();
  readonly #createClient: AnalysisClientFactory;
  readonly #providerIdentity: ProviderIdentity;
  readonly #capabilities: ReadonlyMap<string, CapabilityDescriptor> | undefined;
  readonly #evidence = new EvidenceLedger({
    maxRecords: 10_000,
    maxBytes: 64 * 1024 * 1024,
  });

  constructor(readonly provider: AnalysisProvider | AnalysisClientFactory) {
    this.#createClient =
      typeof provider === "function"
        ? provider
        : (target) => provider.createClient(target);
    this.#providerIdentity =
      typeof provider === "function"
        ? { id: "unidentified", name: "Unidentified provider", version: null }
        : provider.identity();
    this.#capabilities =
      typeof provider === "function"
        ? undefined
        : new Map(
            provider
              .capabilities()
              .map((descriptor) => [descriptor.operation, descriptor]),
          );
  }

  /** Identify the provider producing evidence for this session. */
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity {
    if (operation !== undefined) {
      const exact = this.#capabilities?.get(operation)?.provider;
      if (exact !== undefined) return exact;
      if (enhancedToolNameSchema.safeParse(operation).success) {
        const providers = new Map<string, ProviderIdentity>();
        for (const descriptor of this.#capabilities?.values() ?? [])
          if (
            descriptor.available &&
            OFFICIAL_OPERATIONS.has(descriptor.operation)
          )
            providers.set(descriptor.provider.id, descriptor.provider);
        if (providers.size === 1) {
          const provider = providers.values().next().value;
          if (provider !== undefined) return provider;
        }
      }
    }
    return this.#providerIdentity;
  }

  /** Add one successful public observation to the session ledger. */
  recordEvidence(
    evidence: Evidence,
  ): Result<
    "added" | "duplicate",
    EvidenceIntegrityError | EvidenceLimitError
  > {
    return this.#evidence.record(evidence);
  }

  /** Check that comparison input Evidence is already session-owned. */
  hasEvidence(evidenceId: string): boolean {
    return this.#evidence.has(evidenceId);
  }

  /** Read one detached session-owned Evidence record by semantic ID. */
  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#evidence.get(evidenceId);
  }

  /** Return a deterministic snapshot without clearing session evidence. */
  exportEvidenceBundle(): EvidenceBundle {
    return this.#evidence.export();
  }

  /** Atomically merge a validated evidence bundle into this session. */
  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError | EvidenceLimitError> {
    return this.#evidence.import(bundle);
  }

  /** Create an approved residual unknown and immutable mutation evidence. */
  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const evidence = unknownMutationEvidence(this.#active?.target, input);
    return this.#evidence.recordUnknown(input, evidence);
  }

  /** Atomically record derived Evidence and its approved residual unknown. */
  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    return this.#evidence.recordWithUnknown(
      evidence,
      input,
      unknownMutationEvidence(undefined, input),
    );
  }

  /** Update one unknown using compare-and-swap revision semantics. */
  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const evidence = createEvidence(this.#active?.target, REGISTRY_PROVIDER, {
      predicateType: "rea.residual-unknown-mutation/v1",
      operation: "update_unknown",
      parameters: {
        unknown_id: input.unknown_id,
        expected_revision: input.expected_revision,
      },
      result: { action: "update", status: input.status },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: unknownEvidenceLinks(input),
      limitations: [
        "Registry mutation evidence records analyst intent, not proof of the answer.",
      ],
    });
    return this.#evidence.updateUnknown(input, evidence);
  }

  /** Query stable current residual-unknown heads. */
  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#evidence.listUnknowns(filters);
  }

  /** Check whether current head is a bundle-valid resolved state. */
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#evidence.verifyUnknownResolution(unknownId);
  }

  /**
   * Open or switch targets after draining calls against the current target.
   * Returns the switch failure even if best-effort restoration also fails.
   */
  open(
    path: string,
    options: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
    } = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    return this.#serialize(async () => {
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      const parsed = await parseBinaryTarget(
        path,
        process.cwd(),
        process.arch,
        options.targetKind,
      );
      if (!parsed.ok) return parsed;
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      if (this.#active?.target.path === parsed.value.path)
        return ok(parsed.value);
      await this.#drainCalls();
      const previous = this.#active;
      this.#active = undefined;
      await previous?.client.close();
      const client = this.#createClient(parsed.value);
      const started = await client.execute("health", {}, options);
      if (!started.ok) {
        await client.close();
        await this.#restore(previous);
        return started;
      }
      if (isAborted(options.signal)) {
        await client.close();
        await this.#restore(previous);
        return err(new AnalysisCancelledError("open_binary"));
      }
      this.#active = { target: parsed.value, client };
      return ok(parsed.value);
    });
  }

  /** Close the active target, if any. */
  close(): Promise<Result<null, AnalysisError>> {
    return this.#serialize(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await this.#drainCalls();
      await previous?.client.close();
      this.#evidence.clear();
      return ok(null);
    });
  }

  /** Describe the active binary session. */
  status(): JsonValue {
    const target = this.#active?.target;
    const provider = {
      id: this.#providerIdentity.id,
      name: this.#providerIdentity.name,
      version: this.#providerIdentity.version,
    };
    const providers = new Map<string, ProviderIdentity>();
    if (this.#capabilities === undefined) providers.set(provider.id, provider);
    else
      for (const descriptor of this.#capabilities.values())
        providers.set(descriptor.provider.id, descriptor.provider);
    const providerList = [...providers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, name, version }) => ({ id, name, version }));
    const capabilities =
      this.#capabilities === undefined
        ? []
        : [...this.#capabilities.values()]
            .sort((left, right) =>
              left.operation.localeCompare(right.operation),
            )
            .map((descriptor) => ({
              operation: descriptor.operation,
              available: descriptor.available,
              reason: descriptor.reason,
              input_contract_version: descriptor.inputContractVersion,
              output_contract_version: descriptor.outputContractVersion,
              pagination: descriptor.pagination,
              exhaustive: descriptor.exhaustive,
              effects: {
                mutates_artifact: descriptor.effects.mutatesArtifact,
                launches_process: descriptor.effects.launchesProcess,
                may_show_ui: descriptor.effects.mayShowUi,
                may_access_network: descriptor.effects.mayAccessNetwork,
                may_write_filesystem: descriptor.effects.mayWriteFilesystem,
                changes_permissions: descriptor.effects.changesPermissions,
                requires_root: descriptor.effects.requiresRoot,
              },
              limits: {
                max_results: descriptor.limits.maxResults,
                max_payload_bytes: descriptor.limits.maxPayloadBytes,
                timeout_ms: descriptor.limits.timeoutMs,
              },
              limitations: [...descriptor.limitations],
            }));
    return target === undefined
      ? { open: false, provider, providers: providerList, capabilities }
      : {
          open: true,
          provider,
          providers: providerList,
          capabilities,
          path: target.path,
          sha256: target.sha256,
          format: target.format,
          kind: target.kind,
          architecture: target.architecture ?? null,
        };
  }

  /** Return the immutable artifact identity captured before Hopper launched. */
  activeTarget(): BinaryTarget | undefined {
    return this.#active?.target;
  }

  /**
   * Invoke a Hopper tool against the active target.
   * Calls may overlap, but a pending target transition prevents new calls from
   * entering until the transition has settled.
   */
  async execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const transitioned = await this.#waitForTransition(name, options?.signal);
    if (!transitioned.ok) return transitioned;
    const capability = this.#capabilities?.get(name);
    if (this.#capabilities !== undefined && capability?.available !== true)
      return err(
        new AnalysisCapabilityUnavailableError(
          this.#providerIdentity.id,
          name,
          capability?.reason ?? "operation is not declared by this provider",
        ),
      );
    const active = this.#active;
    if (active === undefined) return err(new NoBinaryOpenError());
    const call = active.client.execute(name, arguments_, options);
    this.#calls.add(call);
    try {
      return await call;
    } finally {
      this.#calls.delete(call);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transition.then(operation, operation);
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #drainCalls(): Promise<void> {
    await Promise.allSettled(this.#calls);
  }

  async #restore(
    previous:
      | { readonly target: BinaryTarget; readonly client: AnalysisClient }
      | undefined,
  ): Promise<void> {
    if (previous === undefined) return;
    const client = this.#createClient(previous.target);
    const started = await client.execute("health", {});
    if (started.ok) this.#active = { target: previous.target, client };
    else await client.close();
  }

  async #waitForTransition(
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<undefined, AnalysisCancelledError>> {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    if (signal === undefined) {
      await this.#transition;
      return ok(undefined);
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve(err(new AnalysisCancelledError(operation)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#transition.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(
            signal.aborted
              ? err(new AnalysisCancelledError(operation))
              : ok(undefined),
          );
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(
            signal.aborted
              ? err(new AnalysisCancelledError(operation))
              : ok(undefined),
          );
        },
      );
    });
  }
}

const unknownMutationEvidence = (
  target: BinaryTarget | undefined,
  input: RecordUnknownInput,
): Evidence =>
  createEvidence(target, REGISTRY_PROVIDER, {
    predicateType: "rea.residual-unknown-mutation/v1",
    operation: "record_unknown",
    parameters: {
      domain: input.domain,
      severity: input.severity,
    },
    result: {
      action: "record",
      question: input.question,
      required_authority: input.required_authority,
      required_confidence: input.required_confidence,
    },
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: unknownEvidenceLinks(input),
    limitations: [
      "Registry mutation evidence records analyst intent, not proof of the answer.",
    ],
  });

const unknownEvidenceLinks = (
  input: RecordUnknownInput | UpdateUnknownInput,
): string[] =>
  [
    ...input.supporting_evidence_ids,
    ...input.contradicting_evidence_ids,
    ...("resolution" in input && input.resolution !== null
      ? input.resolution.evidence_ids
      : []),
  ].filter((id, index, values) => values.indexOf(id) === index);

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
