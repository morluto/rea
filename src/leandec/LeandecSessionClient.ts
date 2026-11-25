import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { withOwnedFileHandle } from "../filesystem/OwnedRegularFile.js";
import { classifyProviderFailure, type ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisExecution,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  cancelledBy,
  carriedReason,
  OwnerCancellation,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  analysisSearchPredicate,
  analysisSearchQuerySchema,
} from "../domain/analysisSearch.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  LeandecCallCancelled,
  LeandecMcpClient,
  LeandecRpcError,
  LeandecToolError,
} from "./LeandecMcpClient.js";
import {
  isLeandecOperation,
  leandecLimitations,
  LEANDEC_PROVIDER_IDENTITY,
} from "./LeandecProviderCapabilities.js";
import { AbortedWait, waitForAbortable } from "../process/AbortablePromise.js";
import { matchRegexValues } from "../process/RegexMatcher.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { ProgressReporter } from "../ports/ProgressReporter.js";
import type { RegexMatchingDeadline } from "../config/regexMatchingDeadline.js";
import type { RegexWorkerHeapRequest } from "../config/regexWorkerHeapRequest.js";
import type { AnalysisSearchQuery } from "../domain/analysisSearch.js";
import type { LeandecSettings } from "./LeandecSettings.js";

interface InventoryEntry {
  readonly address: string;
  readonly name: string;
  readonly qualified: string;
  readonly size: number;
}

interface StringEntry {
  readonly address: string;
  readonly value: string;
}

interface Inventory {
  readonly entries: readonly InventoryEntry[];
  readonly total: number;
}

/** One answer before Evidence composition. */
interface Answer {
  readonly result: JsonValue;
  readonly locations: readonly EvidenceLocation[];
  readonly limitations: readonly string[];
}

const HEX = /^(?:0x)?[0-9a-f]+$/iu;
const INTERIOR_ONLY =
  "This address is not a procedure entry; Leandec resolves entries and containing functions, not arbitrary symbols.";

/** Canonical Leandec address: lowercase hexadecimal without a 0x prefix. */
const canonicalAddress = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!HEX.test(trimmed)) return undefined;
  try {
    return BigInt(`0x${trimmed.replace(/^0x/iu, "")}`).toString(16);
  } catch {
    return undefined;
  }
};

// Leandec stores padded hex addresses; REA exposes normalized 0x addresses.
const addressPredicate = (address: string): string => {
  const canonical = canonicalAddress(address);
  if (canonical === undefined) throw new AnalysisInputError("address", { userMessage: "Expected hexadecimal address." });
  return "COALESCE(NULLIF(ltrim(lower(addr), '0'), ''), '0') = '" + canonical + "'";
};

const publicAddress = (value: unknown): string => {
  const address = canonicalAddress(value);
  if (address === undefined) throw new AnalysisOutputError("leandec", "Invalid Leandec address");
  return "0x" + address;
};

const invalidReply = (detail: string): never => {
  throw new AnalysisOutputError("leandec", `Malformed Leandec reply: ${detail}`);
};

const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : invalidReply("expected object");

const list = (value: JsonValue | undefined): readonly JsonValue[] =>
  Array.isArray(value) ? value : invalidReply("expected array");

const requiredText = (value: JsonValue | undefined): string =>
  typeof value === "string" ? value : invalidReply("expected string");

const requiredCount = (value: JsonValue | undefined): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : invalidReply("expected nonnegative integer");

const inventoryEntry = (row: JsonValue): InventoryEntry => {
  const cells = list(row);
  const address = requiredText(cells[0]);
  if (canonicalAddress(address) === undefined) invalidReply("invalid function address");
  const name = requiredText(cells[1]);
  const namespace = requiredText(cells[2]);
  return { address, name, qualified: namespace ? `${namespace}::${name}` : name, size: requiredCount(cells[3]) };
};

const waitShared = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  const result = await waitForAbortable(promise, signal);
  if (result instanceof AbortedWait) throw cancelledBy("leandec", result);
  return result;
};

const filterEntries = async <T>(entries: readonly T[], value: (entry: T) => string,
  query: AnalysisSearchQuery, operation: string, deadline: RegexMatchingDeadline, heapRequest: RegexWorkerHeapRequest, signal?: AbortSignal): Promise<readonly T[]> => {
  if (query.mode !== "regex") {
    const matches = analysisSearchPredicate(query);
    return entries.filter(entry => matches(value(entry)));
  }
  const matched = await matchRegexValues({ operation, pattern: query.pattern,
    caseSensitive: query.case_sensitive ?? false, values: entries.map(value), deadline, heapRequest, signal });
  if (!matched.ok) throw matched.error;
  const indices = new Set(matched.value);
  return entries.filter((_entry, index) => indices.has(index));
};

const coverage = (kind: string, retained: number, total: number): readonly string[] =>
  retained < total ? [`Leandec returned ${retained} of ${total} ${kind}; results are incomplete.`] : [];

const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Leandec-backed session for one parsed target. Every read goes through
 * Leandec's MCP server, which answers from its persistent SQLite cache and only
 * starts Ghidra when a requested function is not cached yet.
 */
export class LeandecSessionClient implements AnalysisClient {
  readonly #client: LeandecMcpClient;
  readonly #target: BinaryTarget;
  readonly #settings: LeandecSettings;
  readonly #profile: AnalysisProfileCommitment | undefined;
  #session: Promise<string> | undefined;
  #inventory: Promise<Inventory> | undefined;
  #strings:
    | Promise<{ items: readonly StringEntry[]; total: number }>
    | undefined;
  #closed = false;
  readonly #owner = new AbortController();
  #runtime: PrivateRuntimeRoot | undefined;
  readonly #failedHandles = new Set<OwnedFileHandle>();
  readonly #stagingRoots = new Set<PrivateRuntimeRoot>();
  readonly #progress = new Map<symbol, ProgressReporter>();
  #cleanupFailure: ProviderCleanupError | undefined;

  constructor(
    target: BinaryTarget,
    settings: LeandecSettings,
    profile: AnalysisProfileCommitment | undefined,
    private readonly regexDeadline: RegexMatchingDeadline,
    private readonly regexHeap: RegexWorkerHeapRequest,
  ) {
    this.#target = target;
    this.#settings = settings;
    this.#profile = profile;
    this.#client = new LeandecMcpClient({
      python: settings.python,
      server: settings.server,
      environment: settings.environment,
      cwd: settings.cwd,
      defaultTimeoutMs: settings.defaultTimeoutMs,
    });
  }

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions = {},
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closed)
      return err(
        this.#unavailable(operation, "This Leandec session is already closed."),
      );
    if (options.signal?.aborted === true)
      return err(
        cancelledBy(operation, options.signal),
      );
    if (operation !== "health" && !isLeandecOperation(operation))
      return err(
        this.#unavailable(
          operation,
          "Leandec answers procedure, string, reference and byte queries; this operation needs another provider.",
        ),
      );
    try {
      const answer = await this.#answer(operation, parameters, options);
      return ok(
        createAnalysisExecution(answer.result, this.#identity(), {
          subject: {
            path: this.#target.path,
            sha256: this.#target.sha256,
            format: this.#target.format,
            ...(this.#target.architecture === undefined
              ? {}
              : { architecture: this.#target.architecture }),
          },
          limitations:
            operation === "health"
              ? answer.limitations
              : [...leandecLimitations(operation, this.regexDeadline, this.regexHeap), ...answer.limitations],
          ...(this.#profile === undefined
            ? {}
            : { analysisProfile: this.#profile }),
          locations: [
            { kind: "artifact-path", path: this.#target.path },
            ...answer.locations,
          ],
        }),
      );
    } catch (cause: unknown) {
      return err(classifyProviderFailure(cause, this.#failureDialect(operation, options)));
    }
  }

  async close(): Promise<Result<null, AnalysisError>> {
    this.#closed = true;
    this.#owner.abort(OwnerCancellation.ownerClosed);
    try {
      await this.#client.close();
      await Promise.allSettled([this.#session, this.#inventory, this.#strings]);
      for (const owner of this.#failedHandles) {
        await owner.close();
        this.#failedHandles.delete(owner);
      }
      for (const staging of this.#stagingRoots) {
        await staging.close();
        this.#stagingRoots.delete(staging);
      }
      await this.#runtime?.close();
      this.#runtime = undefined;
      this.#cleanupFailure?.markCleanupIncomplete(false);
      return ok(null);
    } catch (cause: unknown) {
      this.#cleanupFailure ??= new ProviderCleanupError("leandec", ["Leandec MCP process and owned input resources"], { reason: cause instanceof Error ? cause.message : String(cause) }, { cause });
      return err(this.#cleanupFailure);
    }
  }

  reuseReadiness(): "ready" | "blocked" | "unknown" {
    return this.#closed ? "blocked" : "unknown";
  }

  #identity() {
    return {
      id: LEANDEC_PROVIDER_IDENTITY.id,
      name: LEANDEC_PROVIDER_IDENTITY.name,
      version: this.#profile?.provider.version ?? null,
    };
  }

  async #answer(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    if (operation === "health") return this.#health(options);
    const document = parameters.document;
    if (document !== undefined && document !== this.#target.path)
      throw new AnalysisInputError(operation, {
        userMessage:
          "A Leandec session analyzes one target; omit document or pass the selected target path.",
      });
    if (!isLeandecOperation(operation))
      throw this.#unavailable(operation, "Unsupported Leandec operation.");
    const key = await this.#ensureSession(options);
    switch (operation) {
      case "list_documents":
        return { result: [this.#target.path], locations: [], limitations: [] };
      case "list_procedures":
        return this.#listProcedures(key, options);
      case "search_procedures":
        return this.#searchProcedures(operation, parameters, options);
      case "list_strings":
        return this.#listStrings(parameters, options);
      case "search_strings":
        return this.#searchStrings(operation, parameters, options);
      case "procedure_address":
        return this.#procedureAddress(operation, parameters, options);
      case "address_name":
        return this.#addressName(parameters, options);
      case "procedure_pseudo_code":
        return this.#pseudocode(operation, parameters, key, options);
      case "procedure_assembly":
        return this.#assembly(operation, parameters, key, options);
      case "procedure_callers":
      case "procedure_callees":
        return this.#relationships(operation, parameters, key, options);
      case "xrefs":
        return this.#xrefs(parameters, key, options);
      case "read_bytes":
        return this.#readBytes(operation, parameters, key, options);
    }
  }

  async #health(options: ExecutionOptions): Promise<Answer> {
    const key = await this.#ensureSession(options);
    const overview = record(
      await this.#call("overview", { target: key }, options),
    );
    return {
      result: {
        ready: true,
        leandec: {
          key,
          server_version: this.#settings.serverVersion,
          functions: overview.functions ?? null,
          strings: overview.strings ?? null,
          db: overview.db ?? null,
        },
      },
      locations: [],
      limitations: [],
    };
  }

  async #listProcedures(
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const inventory = await this.#inventoryOf(key, options);
    return {
      result: inventory.entries.map((entry) => ({
        address: publicAddress(entry.address),
        value: entry.qualified,
      })),
      locations: [],
      limitations:
        inventory.total > inventory.entries.length
          ? [
              `Leandec's inventory was capped at ${String(this.#settings.inventoryLimit)} of ${String(inventory.total)} functions; raise LEANDEC_INVENTORY_LIMIT for a complete list.`,
            ]
          : [],
    };
  }

  async #searchProcedures(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const query = this.#searchQuery(operation, parameters);
    const inventory = await this.#inventoryOf(
      await this.#ensureSession(options),
      options,
    );
    return {
      result: (await filterEntries(inventory.entries, entry => entry.qualified, query, operation, this.regexDeadline, this.regexHeap, options.signal))
        .map((entry) => ({ address: publicAddress(entry.address), value: entry.qualified })),
      locations: [],
      limitations: coverage("functions", inventory.entries.length, inventory.total),
    };
  }

  async #listStrings(
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const strings = await this.#stringsOf(options);
    const wanted = parameters.address === undefined ? undefined : canonicalAddress(parameters.address);
    if (parameters.address !== undefined && wanted === undefined)
      throw new AnalysisInputError("list_strings", { userMessage: "Invalid string address." });
    const selected =
      wanted === undefined
        ? strings.items
        : strings.items.filter((entry) => entry.address === wanted);
    return {
      result: selected.map(({ address, value }) => ({ address: publicAddress(address), value })),
      locations: [],
      limitations:
        strings.total > strings.items.length
          ? [
              `Leandec returned ${String(strings.items.length)} of ${String(strings.total)} strings; raise LEANDEC_STRING_LIMIT for a complete list.`,
            ]
          : [],
    };
  }

  async #searchStrings(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const query = this.#searchQuery(operation, parameters);
    const strings = await this.#stringsOf(options);
    return {
      result: (await filterEntries(strings.items, entry => entry.value, query, operation, this.regexDeadline, this.regexHeap, options.signal))
        .map(({ address, value }) => ({ address: publicAddress(address), value })),
      locations: [],
      limitations: coverage("strings", strings.items.length, strings.total),
    };
  }

  async #procedureAddress(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    return {
      result: publicAddress(entry.address),
      locations: [{ kind: "address", address: publicAddress(entry.address) }],
      limitations: [],
    };
  }

  async #addressName(
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const key = await this.#ensureSession(options);
    const address =
      canonicalAddress(parameters.address) ??
      (await this.#resolve("address_name", parameters.address, options))
        .address;
    const functions = record(await this.#call("sql", {
      target: key,
      query: "SELECT name FROM functions WHERE kind != 'external' AND " + addressPredicate(address),
      limit: 2,
    }, options));
    const matches = list(functions.rows);
    if (matches.length > 1) invalidReply("multiple names for the same address");
    if (matches[0] !== undefined)
      return { result: requiredText(list(matches[0])[0]), locations: [{ kind: "address", address: publicAddress(address) }], limitations: [] };
    const labels = record(
      await this.#call(
        "sql",
        {
          target: key,
          query: "SELECT name FROM labels WHERE " + addressPredicate(address) + " AND name != '' LIMIT 1",
        },
        options,
      ),
    );
    const labelRows = list(labels.rows);
    const label = labelRows.length === 0 ? undefined : requiredText(list(labelRows[0])[0]);
    return {
      result: label ?? null,
      locations: [{ kind: "address", address: publicAddress(address) }],
      limitations: label === undefined ? [INTERIOR_ONLY] : [],
    };
  }

  async #pseudocode(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    const payload = record(
      await this.#call(
        "decompile",
        { target: key, selector: entry.address },
        options,
      ),
    );
    const code = requiredText(payload.pseudocode);
    return {
      result: code === undefined || code.length === 0 ? null : code,
      locations: [{ kind: "address", address: publicAddress(entry.address) }],
      limitations:
        payload.cached === true
          ? []
          : ["This pseudocode was decompiled on demand."],
    };
  }

  async #assembly(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    const payload = record(
      await this.#call(
        "disassemble",
        { target: key, selector: entry.address },
        options,
      ),
    );
    return {
      result: requiredText(payload.assembly),
      locations: [{ kind: "address", address: publicAddress(entry.address) }],
      limitations: [],
    };
  }

  async #relationships(
    operation: "procedure_callers" | "procedure_callees",
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const entry = await this.#resolve(operation, parameters.procedure, options);
    const payload = record(
      await this.#call(
        "xrefs",
        { target: key, selector: entry.address },
        options,
      ),
    );
    const field = operation === "procedure_callers" ? "callers" : "callees";
    return {
      result: list(payload[field])
        .map((item) => publicAddress(record(item).address)),
      locations: [{ kind: "address", address: publicAddress(entry.address) }],
      limitations:
        payload.cached === true
          ? []
          : [
              "Reference indexing for this function did not complete; this list may be incomplete.",
            ],
    };
  }

  async #xrefs(
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const address =
      canonicalAddress(parameters.address) ??
      (await this.#resolve("xrefs", parameters.address, options)).address;
    let references = record(
      await this.#call(
        "instruction_xrefs",
        { target: key, address, direction: "in", limit: 10_000 },
        options,
      ),
    );
    if (references.complete !== true) {
      const owner = text(references.function);
      if (owner !== undefined) {
        await this.#call("xrefs", { target: key, selector: owner }, options);
        references = record(
          await this.#call(
            "instruction_xrefs",
            { target: key, address, direction: "in", limit: 10_000 },
            options,
          ),
        );
      }
    }
    const sources = [
      ...new Set(
        list(references.references)
          .map((item) => publicAddress(record(item).src)),
      ),
    ];
    return {
      result: sources,
      locations: [{ kind: "address", address: publicAddress(address) }],
      limitations: [
        ...(references.complete === true
          ? []
          : ["The containing function's reference index is not complete."]),
        ...(references.truncated === true
          ? ["More incoming references exist than the 10000-row cap."]
          : []),
      ],
    };
  }

  async #readBytes(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    key: string,
    options: ExecutionOptions,
  ): Promise<Answer> {
    const address = canonicalAddress(parameters.address);
    if (address === undefined)
      throw new AnalysisInputError(operation, {
        userMessage: "read_bytes requires a hexadecimal address.",
      });
    const length = Number(parameters.length ?? 256);
    if (!Number.isInteger(length) || length < 1)
      throw new AnalysisInputError(operation, {
        userMessage: "read_bytes requires a positive integer length.",
      });
    await this.#call("sections", { target: key }, options);
    const payload = record(
      await this.#call("read_bytes", { target: key, address, length }, options),
    );
    const bytes = hexFromDump(requiredText(payload.dump));
    if (bytes.length / 2 !== requiredCount(payload.length) || bytes.length / 2 > length || canonicalAddress(payload.address) !== address)
      invalidReply("inconsistent byte dump");
    return {
      result: {
        address: publicAddress(address),
        requested_bytes: length,
        returned_bytes: bytes.length / 2,
        bytes_hex: bytes,
        complete: bytes.length / 2 === length,
      },
      locations: [{ kind: "address", address: publicAddress(address) }],
      limitations: [],
    };
  }

  #searchQuery(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ) {
    const parsed = analysisSearchQuerySchema.safeParse(parameters);
    if (!parsed.success)
      throw new AnalysisInputError(operation, { cause: parsed.error });
    return parsed.data;
  }

  async #resolve(
    operation: string,
    raw: JsonValue | undefined,
    options: ExecutionOptions,
  ): Promise<InventoryEntry> {
    const key = await this.#ensureSession(options);
    if (typeof raw !== "string" || raw.trim().length === 0)
      throw new AnalysisInputError(operation, { userMessage: "procedure is required." });
    const wanted = raw.trim();
    // Exact names take precedence over unprefixed hexadecimal addresses.
    if (!/^0x[0-9a-f]+$/iu.test(wanted)) {
      const literal = wanted.replaceAll("'", "''");
      const reply = record(await this.#call("sql", {
        target: key, limit: 2,
        query: "SELECT addr, name, COALESCE(ns, ''), size FROM functions WHERE kind != 'external' AND (name = '" +
          literal + "' OR (CASE WHEN COALESCE(ns, '') = '' THEN name ELSE ns || '::' || name END) = '" + literal + "')",
      }, options));
      const matches = list(reply.rows).map(inventoryEntry);
      if (matches.length > 1)
        throw new AnalysisInputError(operation, { userMessage: `${wanted} is ambiguous; select a procedure by address.` });
      if (matches[0] !== undefined) return matches[0];
    }
    const address = canonicalAddress(wanted);
    if (address === undefined)
      throw new AnalysisInputError(operation, { userMessage: `No exact procedure named ${wanted}.` });
    const direct = record(await this.#call("sql", { target: key, limit: 2,
      query: "SELECT addr, name, COALESCE(ns, ''), size FROM functions WHERE kind != 'external' AND " + addressPredicate(address),
    }, options));
    const rows = list(direct.rows);
    if (rows.length > 1) invalidReply("multiple entries for the same address");
    if (rows[0] !== undefined) return inventoryEntry(rows[0]);
    const resolved = record(await this.#call("resolve", { target: key, selector: "0x" + address }, options));
    const entryAddress = requiredText(resolved.address);
    const canonicalEntry = canonicalAddress(entryAddress) ?? invalidReply("invalid resolved address");
    if (canonicalEntry !== address && canonicalAddress(resolved.inside_address) !== address)
      throw new AnalysisInputError(operation, { userMessage: INTERIOR_ONLY });
    const name = requiredText(resolved.name);
    return { address: entryAddress, name, qualified: name, size: requiredCount(resolved.size) };
  }

  async #ensureSession(options: ExecutionOptions): Promise<string> {
    const token = Symbol("leandec waiter");
    if (options.progress !== undefined) this.#progress.set(token, options.progress);
    try {
      this.#session ??= this.#open({ signal: this.#owner.signal, progress: { report: async update => {
        await Promise.allSettled([...this.#progress.values()].map(reporter => reporter.report(update)));
      } } }).catch((cause: unknown) => {
        this.#session = undefined;
        throw cause;
      });
      return await waitShared(this.#session, options.signal);
    } finally {
      this.#progress.delete(token);
    }
  }

  async #open(options: ExecutionOptions): Promise<string> {
    await this.#client.initialize(options.signal);
    // Verify the complete admitted file and hash the selected slice independently.
    // A private copy is retained until all owned work and process cleanup finish.
    const input = await this.#verifiedInput(options);
    const cached = await this.#findByDigest(input.digest, options);
    if (cached !== undefined) return cached;
    if (!this.#settings.autoAnalyze)
      throw this.#unavailable("open_binary", "No matching Leandec target is cached. Import the verified target or enable LEANDEC_AUTO_ANALYZE.");
    const durablePath = await this.#persistInput(input.path, input.digest, options);
    await this.#importTarget(durablePath, options);
    const imported = await this.#findByDigest(input.digest, options);
    if (imported === undefined)
      throw new AnalysisOutputError("open_binary", "Leandec import did not produce the verified slice");
    return imported;
  }

  async #verifiedInput(options: ExecutionOptions): Promise<{ path: string; digest: string }> {
    this.#runtime ??= await PrivateRuntimeRoot.create({ prefix: "rea-leandec-" });
    const path = join(this.#runtime.path, "input");
    const owner = new OwnedFileHandle(await open(path, "w", 0o600));
    const source = createHash("sha256");
    const selected = createHash("sha256");
    const slice = this.#target.format === "mach-o-universal" ? this.#target.universalSlice : undefined;
    let offset = 0;
    let copied = 0;
    await withOwnedFileHandle(path, owner, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      retainFailedClose: failed => { this.#failedHandles.add(failed); },
    }, async file => {
      for await (const chunk of createReadStream(this.#target.path, { highWaterMark: 64 * 1024, signal: options.signal })) {
        options.signal?.throwIfAborted();
        const bytes = Buffer.from(chunk);
        source.update(bytes);
        const start = slice === undefined ? offset : Math.max(offset, slice.offset);
        const end = slice === undefined ? offset + bytes.length : Math.min(offset + bytes.length, slice.offset + slice.size);
        if (end > start) {
          const admitted = bytes.subarray(start - offset, end - offset);
          selected.update(admitted);
          let written = 0;
          while (written < admitted.length) {
            const result = await file.write(admitted, written, admitted.length - written);
            if (result.bytesWritten === 0) throw new Error("Leandec private input write stalled");
            written += result.bytesWritten;
          }
          copied += admitted.length;
        }
        offset += bytes.length;
      }
    });
    if (source.digest("hex") !== this.#target.sha256 || copied === 0 || (slice !== undefined && copied !== slice.size))
      throw new AnalysisInputError("open_binary", { userMessage: "Target bytes changed or the selected slice is incomplete; reopen the target." });
    return { path, digest: selected.digest("hex") };
  }

  async #hashInput(path: string, options: ExecutionOptions): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal: options.signal })) {
      options.signal?.throwIfAborted();
      hash.update(chunk);
    }
    return hash.digest("hex");
  }

  // Leandec retains its imported slice path for subsequent byte reads.
  // Publish a verified content-addressed file in its explicitly selected cache.
  async #persistInput(path: string, digest: string, options: ExecutionOptions): Promise<string> {
    const environment = this.#settings.environment;
    const state = resolve(this.#settings.cwd, environment.LEANDEC_HOME ??
      join(environment.HOME ?? homedir(), "Library", "Caches", "leandec"));
    const directory = join(state, "rea-inputs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()))
      throw new AnalysisOutputError("open_binary", "Leandec input cache is not a private owner-controlled directory");
    const destination = join(directory, digest);
    const staging = await PrivateRuntimeRoot.create({ parent: directory, prefix: "rea-stage-" });
    this.#stagingRoots.add(staging);
    try {
      const temporary = join(staging.path, "input");
      await copyFile(path, temporary);
      if (await this.#hashInput(temporary, options) !== digest)
        throw new AnalysisOutputError("open_binary", "Leandec staged input digest differs");
      try { await link(temporary, destination); }
      catch (cause: unknown) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      }
      const stored = await lstat(destination);
      if (!stored.isFile() || (stored.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stored.uid !== process.getuid()) ||
        await this.#hashInput(destination, options) !== digest)
        throw new AnalysisOutputError("open_binary", "Leandec durable input does not match verified bytes");
      return destination;
    } finally {
      await staging.close();
      this.#stagingRoots.delete(staging);
    }
  }

  #architectureMatches(value: JsonValue | undefined): boolean {
    const normalize = (arch: unknown): unknown =>
      arch === "aarch64" ? "arm64" : arch === "amd64" ? "x86_64" : arch;
    return normalize(value) === this.#target.architecture;
  }

  async #findByDigest(digest: string, options: ExecutionOptions): Promise<string | undefined> {
    const response = await this.#call("targets", {}, options);
    const targets = typeof response === "string" && response.startsWith("no targets yet:") ? [] : list(response);
    const match = targets.map(record).find(item => item.slice_sha256 === digest && this.#architectureMatches(item.arch));
    if (match === undefined) return undefined;
    const key = requiredText(match.key);
    const overview = record(await this.#call("overview", { target: key }, options));
    if (overview.key !== key || overview.slice_sha256 !== digest || !this.#architectureMatches(overview.arch))
      throw new AnalysisOutputError("open_binary", "Leandec cache identity does not match the selected bytes and architecture");
    requiredCount(overview.functions);
    const slice = requiredText(overview.slice);
    if (await this.#hashInput(slice, options) !== digest)
      throw new AnalysisOutputError("open_binary", "Leandec cached slice bytes do not match the verified digest");
    return key;
  }

  async #importTarget(path: string, options: ExecutionOptions): Promise<void> {
    const job = record(
      await this.#call(
        "analyze",
        {
          path,
          arch: this.#target.architecture ?? "native",
        },
        options,
        this.#settings.importTimeoutMs,
      ),
    );
    const id = text(job.id);
    if (id === undefined)
      throw new ProviderAdapterError("leandec", "analyze", {
        userMessage: "Leandec did not return a background job identifier.",
      });
    const deadline = Date.now() + this.#settings.importTimeoutMs;
    for (;;) {
      if (options.signal?.aborted === true)
        throw cancelledBy("analyze", options.signal);
      if (Date.now() > deadline)
        throw new AnalysisTimeoutError(
          "analyze",
          this.#settings.importTimeoutMs,
          {
            userMessage: `Leandec import of ${this.#target.path} is still running; poll it from Pi with the job tool.`,
          },
        );
      const jobs = list(await this.#call("job", { id, lines: 6 }, options));
      const current = record(jobs[0]);
      if (current.running !== true) {
        const tail = text(current.log_tail) ?? "";
        if (current.exit_code === 0) return;
        if (current.exit_code === undefined && /done in .*->/u.test(tail))
          return;
        throw new ProviderAdapterError("leandec", "analyze", {
          userMessage: `Leandec import failed (exit ${String(current.exit_code ?? "unknown")}): ${tail}`,
        });
      }
      await options.progress?.report({
        phase: "analyze",
        completed: 0,
        total: null,
        message: `Leandec is importing ${this.#target.path}`,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
      });
    }
  }

  async #inventoryOf(
    key: string,
    options: ExecutionOptions,
  ): Promise<Inventory> {
    this.#inventory ??= this.#loadInventory(key, { signal: this.#owner.signal }).catch((cause: unknown) => {
      this.#inventory = undefined;
      throw cause;
    });
    return waitShared(this.#inventory, options.signal);
  }

  async #loadInventory(
    key: string,
    options: ExecutionOptions,
  ): Promise<Inventory> {
    const payload = record(
      await this.#call(
        "sql",
        {
          target: key,
          limit: this.#settings.inventoryLimit,
          query:
            "SELECT addr, name, COALESCE(ns, ''), size FROM functions " +
            "WHERE kind != 'external' ORDER BY size ASC",
        },
        options,
      ),
    );
    const entries = list(payload.rows).map(inventoryEntry);
    const count = record(await this.#call("sql", {
      target: key, limit: 1,
      query: "SELECT COUNT(*) FROM functions WHERE kind != 'external'",
    }, options));
    const total = requiredCount(list(list(count.rows)[0])[0]);
    if (total < entries.length) invalidReply("function count is smaller than returned inventory");
    return { entries, total };
  }

  async #stringsOf(
    options: ExecutionOptions,
  ): Promise<{ items: readonly StringEntry[]; total: number }> {
    this.#strings ??= this.#loadStrings({ signal: this.#owner.signal }).catch((cause: unknown) => {
      this.#strings = undefined;
      throw cause;
    });
    return waitShared(this.#strings, options.signal);
  }

  async #loadStrings(
    options: ExecutionOptions,
  ): Promise<{ items: readonly StringEntry[]; total: number }> {
    const key = await this.#ensureSession(options);
    const payload = record(
      await this.#call(
        "strings",
        { target: key, limit: this.#settings.stringLimit },
        options,
      ),
    );
    const items = list(payload.items).map((item) => {
      const value = record(item);
      const address = canonicalAddress(requiredText(value.address)) ?? invalidReply("invalid string address");
      return { address, value: requiredText(value.value) };
    });
    const total = requiredCount(payload.total_strings);
    if (total < items.length) invalidReply("string count is smaller than returned inventory");
    return { items, total };
  }

  async #call(
    tool: string,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
    timeoutMs: number = this.#settings.defaultTimeoutMs,
  ): Promise<JsonValue> {
    return this.#client.call(tool, argumentsValue, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs,
    });
  }

  #failureDialect(operation: string, options: ExecutionOptions): ProviderFailureDialect {
    return {
      providerId: "leandec",
      operation,
      file: { path: this.#target.path, description: "selected binary" },
      recognise: (cause, details) => {
        if (cause instanceof LeandecCallCancelled)
          return cause.reason === "timeout"
            ? new AnalysisTimeoutError(operation, this.#settings.defaultTimeoutMs, { ...details, userMessage: cause.message })
            : cancelledBy(operation, options.signal ?? carriedReason(cause), details);
        if (cause instanceof LeandecToolError)
          return /no function|no procedure|required|hexadecimal|invalid|unknown target|not a procedure/iu.test(cause.message)
            ? new AnalysisInputError(operation, { ...details, userMessage: cause.message })
            : new ProviderAdapterError("leandec", operation, { ...details, userMessage: cause.message });
        if (cause instanceof LeandecRpcError)
          return new ProviderAdapterError("leandec", operation, {
            ...details, userMessage: cause.message,
            capturedOutput: { stdout: "", stderr: cause.capturedOutput, truncated: false },
          });
        return undefined;
      },
      unclassified: (_cause, details) => new ProviderAdapterError("leandec", operation, details),
    };
  }

  #unavailable(
    operation: string,
    reason: string,
  ): AnalysisCapabilityUnavailableError {
    return new AnalysisCapabilityUnavailableError(
      LEANDEC_PROVIDER_IDENTITY.id,
      operation,
      reason,
      { userMessage: reason, retryable: true },
    );
  }
}

/** Extract lowercase hexadecimal bytes from Leandec's hexdump text. */
const hexFromDump = (dump: string): string => {
  const parts: string[] = [];
  for (const line of dump.split("\n")) {
    const payload = line.replace(/^[0-9a-f]+\s+/iu, "").split("|")[0] ?? "";
    for (const token of payload.replace("*", " ").trim().split(/\s+/u)) {
      if (/^[0-9a-f]{2}$/u.test(token)) parts.push(token);
    }
  }
  return parts.join("");
};
