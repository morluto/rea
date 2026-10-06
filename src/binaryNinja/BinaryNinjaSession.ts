import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type {
  AnalysisClient,
  AnalysisOperation,
} from "../application/AnalysisProvider.js";
import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  BinaryNinjaMcp,
  redactValue,
  type BinaryNinjaMcpConfig,
  type BinaryNinjaTransportFactory,
} from "./BinaryNinjaMcp.js";
import {
  address,
  byteResult,
  functionDossier,
  functionIdentity,
  inputAddress,
  renderedText,
  searchRows,
  textField,
  namedInventory,
  segmentInventory,
} from "./BinaryNinjaValues.js";

import { parseBinaryNinjaParameters } from "./BinaryNinjaInputs.js";
const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/** Serialized target-bound session owning only its imported item and temporary input. */
export class BinaryNinjaSession implements AnalysisClient {
  readonly #mcp: BinaryNinjaMcp;
  #root: string | undefined;
  #openItem: string | undefined;
  #binaryView: string | undefined;
  #started = false;
  #startupAttempted = false;
  #closed = false;
  #cleanup: Promise<Result<null, AnalysisError>> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly target: BinaryTarget,
    private readonly profile: AnalysisProfileCommitment,
    config: BinaryNinjaMcpConfig,
    factory?: BinaryNinjaTransportFactory,
  ) {
    this.#mcp = new BinaryNinjaMcp(config, factory);
  }

  execute: AnalysisClient["execute"] = (operation, parameters, options) => {
    const result = this.#tail.then(async () => {
      try {
        if (isAborted(options?.signal))
          return err(new AnalysisCancelledError(operation));
        const input = parseBinaryNinjaParameters(operation, parameters);
        this.#checkDocument(input, operation);
        if (this.#closed)
          throw new ProviderAdapterError("binary-ninja", operation, {
            diagnostics: { reason: "client_closed" },
          });
        this.#mcp.raw.length = 0;
        await this.#start(options?.signal);
        if (isAborted(options?.signal))
          throw new AnalysisCancelledError(operation);
        const value = await this.#dispatch(operation, input, options?.signal);
        return ok(
          createAnalysisExecution(value, this.profile.provider, {
            analysisProfile: this.profile,
            rawResult: redactValue([...this.#mcp.raw], this.#mcp.config.token),
            limitations: [
              "Binary Ninja opens a digest-verified temporary copy; only that imported item is closed, and no database is saved.",
              "The adapter selects its explicit BinaryView before each operation. Concurrent external GUI/MCP view changes during a request are outside REA's control.",
              "The profile commits the MCP server's advertised version; it does not independently attest the Binary Ninja engine build or analysis settings.",
            ],
          }),
        );
      } catch (cause: unknown) {
        if (!this.#started && this.#startupAttempted) {
          this.#closed = true;
          this.#cleanup ??= this.#dispose();
          const cleanup = await this.#cleanup;
          if (!cleanup.ok) return cleanup;
        }
        if (isAborted(options?.signal))
          return err(new AnalysisCancelledError(operation));
        if (cause instanceof AnalysisError) return err(cause);
        return err(
          new ProviderAdapterError("binary-ninja", operation, {
            diagnostics: {
              reason: redactValue(
                cause instanceof Error ? cause.message : String(cause),
                this.#mcp.config.token,
              ),
            },
          }),
        );
      }
    });
    this.#tail = result.then(() => undefined);
    return result;
  };

  /** Verify provider item closure before removing the temporary target. */
  async closeWithOutcome(): Promise<Result<null, AnalysisError>> {
    this.#closed = true;
    await this.#tail;
    this.#cleanup ??= this.#dispose();
    return this.#cleanup;
  }

  async #dispose(): Promise<Result<null, AnalysisError>> {
    let failure: AnalysisError | undefined;
    try {
      if (this.#openItem !== undefined) {
        const closed = await this.#mcp.call("close", {
          openItem: this.#openItem,
        });
        const status = jsonObjectSchema.safeParse(closed);
        if (
          closed === false ||
          (status.success && status.data.closed === false)
        )
          throw new AnalysisOutputError(
            "close_binary",
            "Binary Ninja refused to close the owned item",
          );
      }
    } catch (cause: unknown) {
      failure =
        cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError("binary-ninja", "close_binary", {
              diagnostics: {
                reason:
                  "Could not verify closure of the owned Binary Ninja item",
              },
            });
    }
    try {
      await this.#mcp.close();
    } catch {
      failure ??= new ProviderAdapterError("binary-ninja", "close_binary", {
        diagnostics: { reason: "Could not close the MCP transport" },
      });
    }
    if (failure === undefined && this.#root !== undefined) {
      try {
        await rm(this.#root, { recursive: true, force: true });
      } catch {
        failure = new ProviderAdapterError("binary-ninja", "close_binary", {
          diagnostics: {
            reason: "Could not remove the temporary target",
            path: this.#root,
          },
        });
      }
    }
    return failure === undefined ? ok(null) : err(failure);
  }

  async close(): Promise<void> {
    const outcome = await this.closeWithOutcome();
    if (!outcome.ok) throw outcome.error;
  }

  async #start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    this.#startupAttempted = true;
    await this.#mcp.connect(signal);
    if (
      this.#mcp.client.getServerVersion()?.version !==
      this.profile.provider.version
    )
      throw new AnalysisOutputError(
        "health",
        "Binary Ninja MCP server version changed after profile selection",
      );
    const committedRoles = jsonObjectSchema.parse(
      this.profile.parameters.tool_roles,
    );
    const actualRoles = this.#mcp.inventory();
    if (
      Object.keys(committedRoles).length !== Object.keys(actualRoles).length ||
      Object.entries(committedRoles).some(
        ([key, value]) => actualRoles[key] !== value,
      )
    )
      throw new AnalysisOutputError(
        "health",
        "Binary Ninja tool inventory changed after profile selection",
      );
    this.#root = await mkdtemp(join(tmpdir(), "rea-binary-ninja-"));
    const snapshot = join(this.#root, basename(this.target.path));
    await copyFile(this.target.path, snapshot);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(snapshot))
      hash.update(z.instanceof(Buffer).parse(chunk));
    const digest = hash.digest("hex");
    if (digest !== this.target.sha256)
      throw new AnalysisOutputError(
        "health",
        "Target changed after REA parsed its digest",
      );
    if (signal?.aborted === true) throw new AnalysisCancelledError("health");
    // Ownership must be learned even if the caller cancels while the server opens the file.
    const opened = jsonObjectSchema.parse(
      await this.#mcp.call("open", { path: snapshot, filename: snapshot }),
    );
    this.#openItem = textField(opened, "openItem", "handle");
    const views = await this.#mcp.list(
      "views",
      { openItem: this.#openItem },
      signal,
    );
    const recommended = views.filter((row) => row.recommended === true);
    const candidates =
      recommended.length > 0
        ? recommended
        : views.filter((row) => (row.type ?? row.viewType) !== "Raw");
    if (candidates.length !== 1)
      throw new AnalysisOutputError(
        "health",
        "The imported item has no unambiguous recommended BinaryView",
      );
    const view = candidates[0];
    if (view === undefined)
      throw new AnalysisOutputError("health", "Missing selected BinaryView");
    this.#binaryView = textField(view, "binaryView", "handle");
    await this.#activate(signal);
    const analyzed = await this.#mcp.call("analyze", {}, signal);
    const analysisStatus = jsonObjectSchema.safeParse(analyzed);
    if (
      analyzed === false ||
      (analysisStatus.success && analysisStatus.data.complete === false)
    )
      throw new AnalysisOutputError(
        "health",
        "Binary Ninja analysis did not complete",
      );
    this.#started = true;
  }

  async #activate(signal?: AbortSignal): Promise<void> {
    if (this.#binaryView === undefined)
      throw new AnalysisOutputError("health", "No owned BinaryView");
    await this.#mcp.call("activate", { binaryView: this.#binaryView }, signal);
  }

  #checkDocument(
    input: Readonly<Record<string, JsonValue>>,
    operation: string,
  ): void {
    if (
      input.document !== undefined &&
      input.document !== null &&
      input.document !== basename(this.target.path)
    )
      throw new AnalysisInputError(operation, {}, [
        {
          path: ["document"],
          reason: "invalid_value",
          message:
            "This target-bound session contains only its imported file; omit document or use its exact basename.",
        },
      ]);
  }

  async #functions(signal?: AbortSignal) {
    await this.#activate(signal);
    return this.#mcp.list("functions", {}, signal);
  }

  async #function(procedure: JsonValue | undefined, signal?: AbortSignal) {
    const identifier = z.string().min(1).parse(procedure);
    const rows = await this.#functions(signal);
    const normalized = /^0x[0-9a-f]+$/iu.test(identifier)
      ? address(identifier)
      : undefined;
    const matching = rows.filter((row) =>
      normalized === undefined
        ? functionIdentity(row).name === identifier
        : functionIdentity(row).address === normalized,
    );
    if (matching.length !== 1)
      throw new AnalysisInputError("procedure_address", {}, [
        {
          path: ["procedure"],
          reason: "invalid_value",
          message:
            matching.length === 0
              ? "No function matches the exact name or start address."
              : "The function is ambiguous; use an unambiguous start address.",
        },
      ]);
    const row = matching[0];
    if (row === undefined) throw new AnalysisInputError("procedure_address");
    return {
      row,
      input: {
        function: functionIdentity(row).address,
        ...(typeof row.arch === "string" ? { arch: row.arch } : {}),
      },
    };
  }

  async #dispatch(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    await this.#activate(signal);
    switch (operation) {
      case "health":
        return { status: "ready", tools: this.#mcp.inventory() };
      case "list_documents":
        return [basename(this.target.path)];
      case "list_procedures":
      case "search_procedures": {
        const rows = (await this.#functions(signal)).map((row) => ({
          address: functionIdentity(row).address,
          value: functionIdentity(row).name,
        }));
        return operation === "search_procedures"
          ? searchRows(rows, parameters, operation)
          : rows;
      }
      case "list_names":
      case "address_name":
      case "list_strings":
      case "search_strings":
        return namedInventory(this.#mcp, operation, parameters, signal);
      case "list_segments":
        return segmentInventory(this.#mcp, signal);
      case "read_bytes": {
        const query = inputAddress(parameters.address, operation);
        const length = z
          .number()
          .int()
          .positive()
          .safe()
          .parse(parameters.length ?? 256);
        return byteResult(
          await this.#mcp.call("bytes", { address: query, length }, signal),
          query,
          length,
        );
      }
      case "xrefs":
        return (
          await this.#mcp.list(
            "xrefs",
            { address: inputAddress(parameters.address, operation) },
            signal,
          )
        ).map((row) => address(row.source ?? row.sourceAddress ?? row.address));
      case "procedure_address":
        return functionIdentity(
          (await this.#function(parameters.procedure, signal)).row,
        ).address;
      default:
        return this.#dispatchFunction(operation, parameters, signal);
    }
  }

  async #dispatchFunction(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const { row, input } = await this.#function(parameters.procedure, signal);
    await this.#activate(signal);
    switch (operation) {
      case "procedure_pseudo_code":
        return renderedText(
          await this.#mcp.call("pseudocode", input, signal),
          "pseudocode",
        );
      case "procedure_assembly":
        return renderedText(
          await this.#mcp.call("disassembly", input, signal),
          "disassembly",
        );
      case "procedure_callers":
      case "procedure_callees":
        return (
          await this.#mcp.list(
            operation === "procedure_callers" ? "callers" : "callees",
            input,
            signal,
          )
        ).map((item) => functionIdentity(item).address);
      case "read_function_instructions": {
        const assembly = renderedText(
          await this.#mcp.call("disassembly", input, signal),
          "disassembly",
        );
        if (assembly === null)
          throw new AnalysisOutputError(
            operation,
            "The server returned null assembly",
          );
        return {
          procedure: jsonValueSchema.parse(functionIdentity(row)),
          instructions: assembly.split("\n"),
          limitations: [
            "Instruction text is Binary Ninja-specific; complete owned body ranges are unavailable.",
          ],
        };
      }
      case "procedure_info":
        return {
          ...jsonObjectSchema.parse(
            await this.#mcp.call("info", input, signal),
          ),
          name: functionIdentity(row).name,
          entrypoint: functionIdentity(row).address,
          body: functionIdentity(row).body,
        };
      case "analyze_function":
        return functionDossier(this.#mcp, row, input, signal);
      default:
        throw new AnalysisCapabilityUnavailableError(
          "binary-ninja",
          operation,
          "Unknown function operation",
        );
    }
  }
}
