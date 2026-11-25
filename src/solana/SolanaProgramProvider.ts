import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";

import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { SolanaProgramPort } from "../ports/solana/SolanaProgramPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisTargetFailureError,
  cancelledBy,
  isAborted,
  unsupportedTarget,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { decodeLimit } from "../domain/parseFailure.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalyzeSolanaProgramInput,
  SolanaProgramAnalysis,
} from "../domain/solana/solanaProgram.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  SafeOutputTree,
  SafeOutputTreeCreationFailure,
  outputDirectoryAdmissionRefusal,
} from "../resources/index.js";
import {
  parseSolanaElf,
  solanaElfMachineName,
  solanaSbpfVersion,
  SOLANA_MAX_SYMBOL_NAME_BYTES,
  solanaTextSection,
  ELF_MACHINE_BPF,
  type SolanaElfImage,
  type SolanaElfSection,
} from "./SolanaElf.js";
import {
  disassembleSbpf,
  isUnknownSbpfInstruction,
  sbpfCodeBoundaryIssues,
  type SbpfInstruction,
} from "./SbpfDisassembler.js";
import {
  anchorDiscriminator,
  scanSolanaDispatch,
  SOLANA_MAX_TABLE_ENTRIES,
} from "./SolanaDispatch.js";
import {
  resolveSolanaCallSites,
  type SolanaCallResolution,
} from "./SolanaSyscalls.js";
import {
  buildSolanaHandoff,
  renderSolanaHandoffBrief,
} from "./SolanaHandoff.js";
import {
  DEFAULT_SOLANA_RPC_URL,
  fetchSolanaProgramElf,
  SolanaRpcResponseTooLarge,
} from "./SolanaRpc.js";
import { SOLANA_PROGRAM_PROVIDER_IDENTITY } from "./SolanaProviderIdentity.js";

export { SOLANA_PROGRAM_PROVIDER_IDENTITY };

/** Name of the fixed byte allowance on one program's ELF intake. */
const ELF_INTAKE_LIMIT = "solana-elf-intake-bytes";

/** Refuse an ELF (local, fetched, or an RPC response) above the fixed intake allowance. */
const intakeLimitRefusal = (detail: string, maximum: number) =>
  parseLimitConstraint(
    OPERATION,
    "memory",
    decodeLimit("elf", detail, { name: ELF_INTAKE_LIMIT, maximum }),
    {
      legacyMaximumKey: "maximum_bytes",
      ...fixedAllowanceOptions("The Solana program intake allowance", "input", {
        limit: maximum,
        unit: "bytes",
      }),
    },
  );

const OPERATION = "analyze_solana_program";
/** Solana program accounts are bounded well below this fixed intake allowance. */
const MAX_ELF_BYTES = 64 * 1024 * 1024;
const MAX_RELEVANT_STRINGS = 64;
const RELEVANT_STRING = /sol_|invoke|syscall|cpi/i;
/** Analysis file names reserved inside out_dir; the handoff ELF copy lives under handoff/elf/. */
export const SOLANA_ANALYSIS_FILE = "solana-analysis.json";
const DISASSEMBLY_FILE = "disassembly.txt";
const HANDOFF_ELF_DIRECTORY = "handoff/elf";

/** The relative path RPC intake materializes the fetched ELF at inside out_dir. */
export const solanaFetchedElfName = (programId: string): string =>
  `${programId}.so`;

const adapterError = (cause: unknown): ProviderAdapterError =>
  new ProviderAdapterError(SOLANA_PROGRAM_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
  });

/** Classify a recognized abort at the I/O owner, keeping the caller's reason. */
const abortedOr = (
  signal: AbortSignal | undefined,
  failure: () => AnalysisError,
): AnalysisError =>
  isAborted(signal) ? cancelledBy(OPERATION, signal) : failure();

const BASE_LIMITATIONS: readonly string[] = [
  "Handler candidates come from the dispatch idioms the analyzer can verify — lddw-constant register compares, split 32-bit half compares, and read-only jump tables. Register-indirect transfers matching none of these are counted as unresolved computed jumps, never guessed.",
  "Disassembly is a linear sweep by the bundled sBPF decoder, not a Ghidra/IDA-grade lift: no Rust source, types, control-flow recovery, or account layouts are produced.",
  "Discriminator candidates are reconstruction leads, never proof of behavior; parity with a deployed program is established only by differential tests against the captured original.",
];

interface AcquiredProgram {
  readonly bytes: Uint8Array;
  readonly path: string;
  readonly source: "local-file" | "solana-rpc";
  readonly programId: string | null;
  readonly programDataAccount: string | null;
  readonly slot: number | null;
}

const readLocalElf = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<AcquiredProgram, AnalysisError>> => {
  let info: Awaited<ReturnType<typeof stat>>;
  if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
  try {
    info = await stat(path);
  } catch (cause) {
    if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM")
      return err(
        new AnalysisAccessDeniedError(OPERATION, path, code, { cause }),
      );
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "ELOOP" ||
      code === "ENAMETOOLONG"
    )
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `Selected ELF file cannot be resolved: ${path} (${code}).`,
          },
        ]),
      );
    return err(adapterError(cause));
  }
  if (!info.isFile())
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected path is not a regular file: ${path}.`,
        },
      ]),
    );
  if (info.size > MAX_ELF_BYTES)
    return err(
      intakeLimitRefusal(
        `Selected ELF ${path} is ${String(info.size)} bytes, above the ${String(MAX_ELF_BYTES)}-byte intake allowance.`,
        MAX_ELF_BYTES,
      ),
    );
  try {
    const bytes = await readFile(path, { signal });
    return ok({
      bytes,
      path,
      source: "local-file",
      programId: null,
      programDataAccount: null,
      slot: null,
    });
  } catch (cause) {
    return err(abortedOr(signal, () => adapterError(cause)));
  }
};

/**
 * Fetch a program's executable bytes read-only, in memory. The fetched ELF
 * is materialized under out_dir only by the same safe output tree that
 * receives the analysis, after analysis succeeds.
 */
const fetchProgramElf = async (
  input: AnalyzeSolanaProgramInput,
  rpcUrl: string,
  signal: AbortSignal | undefined,
): Promise<Result<AcquiredProgram, AnalysisError>> => {
  const programId = input.program_id as string;
  const outDir = input.out_dir as string;
  if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
  let fetched: Awaited<ReturnType<typeof fetchSolanaProgramElf>>;
  try {
    fetched = await fetchSolanaProgramElf(programId, rpcUrl, {
      maxProgramBytes: MAX_ELF_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
    if (cause instanceof SolanaRpcResponseTooLarge)
      return err(intakeLimitRefusal(cause.message, cause.maximumBytes));
    return err(adapterError(cause));
  }
  if (fetched.elfBytes.length > MAX_ELF_BYTES)
    return err(
      intakeLimitRefusal(
        `Fetched program ${programId} is ${String(fetched.elfBytes.length)} bytes, above the ${String(MAX_ELF_BYTES)}-byte intake allowance.`,
        MAX_ELF_BYTES,
      ),
    );
  return ok({
    bytes: fetched.elfBytes,
    path: join(outDir, solanaFetchedElfName(programId)),
    source: "solana-rpc",
    programId,
    programDataAccount: fetched.programDataAccount,
    slot: fetched.slot,
  });
};

/** Extract printable strings from `.rodata`-family sections with file offsets. */
const extractStrings = (
  image: SolanaElfImage,
): SolanaProgramAnalysis["strings"] => {
  let total = 0;
  const relevant: { value: string; file_offset: number }[] = [];
  for (const section of image.sections) {
    if (section.type !== 1 || !section.name.startsWith(".rodata")) continue;
    const bytes = image.bytes;
    let runStart = -1;
    const flush = (end: number): void => {
      if (runStart < 0 || end - runStart < 4) return;
      total += 1;
      if (relevant.length < MAX_RELEVANT_STRINGS) {
        const value = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(runStart, end),
        );
        if (RELEVANT_STRING.test(value))
          relevant.push({ value, file_offset: runStart });
      }
    };
    const limit = Math.min(section.offset + section.size, bytes.length);
    for (let index = section.offset; index < limit; index += 1) {
      const byte = bytes[index] ?? 0;
      if (byte >= 0x20 && byte < 0x7f) {
        if (runStart < 0) runStart = index;
      } else {
        flush(index);
        runStart = -1;
      }
    }
    flush(limit);
  }
  return { total, relevant };
};

interface AnalyzedProgram {
  readonly report: SolanaProgramAnalysis;
  readonly callResolutions: readonly SolanaCallResolution[];
  /** The decoded code section, reused to render disassembly.txt. */
  readonly instructions: readonly SbpfInstruction[];
}

/**
 * The declared code section must lie wholly inside the captured bytes and
 * end on an instruction boundary; otherwise the scan could not be complete,
 * so the target is refused instead of reported with complete coverage.
 */
const codeExtentFailure = (
  acquired: AcquiredProgram,
  textSection: SolanaElfSection,
): AnalysisError | undefined => {
  const malformed = (detail: string): AnalysisError =>
    new AnalysisTargetFailureError(OPERATION, acquired.path, {
      kind: "malformed",
      format: "elf",
      detail,
      offset: textSection.offset,
      field: textSection.name || "code section",
    });
  if (
    !Number.isSafeInteger(textSection.offset + textSection.size) ||
    textSection.offset + textSection.size > acquired.bytes.length
  )
    return malformed(
      `Code section ${textSection.name || "(unnamed)"} declares ${String(textSection.size)} bytes at offset ${String(textSection.offset)}, past the ${String(acquired.bytes.length)}-byte capture.`,
    );
  const issues = sbpfCodeBoundaryIssues(
    acquired.bytes.subarray(
      textSection.offset,
      textSection.offset + textSection.size,
    ),
  );
  if (issues.trailingBytes !== 0)
    return malformed(
      `Code section size ${String(textSection.size)} is not a whole number of 8-byte sBPF instructions (${String(issues.trailingBytes)} trailing bytes).`,
    );
  if (issues.truncatedLddw)
    return malformed("Code section ends inside a two-word lddw instruction.");
  return undefined;
};

const analyzeAcquired = (
  acquired: AcquiredProgram,
  instructionNames: readonly string[],
): Result<AnalyzedProgram, AnalysisError> => {
  let image: SolanaElfImage;
  try {
    image = parseSolanaElf(acquired.bytes);
  } catch (cause) {
    // SolanaElfFailure and BinaryReader range failures are shared parser
    // failures; project their kind, offset and field unchanged.
    if (isParseLimit(cause, "elf"))
      return err(
        parseLimitConstraint(OPERATION, "memory", cause, {
          path: acquired.path,
          ...fixedAllowanceOptions(
            "The Solana symbol name allowance",
            "input",
            { limit: SOLANA_MAX_SYMBOL_NAME_BYTES, unit: "bytes" },
          ),
        }),
      );
    const refusal = parseFailureAnalysisError(OPERATION, acquired.path, cause);
    if (refusal !== undefined) return err(refusal);
    return err(adapterError(cause));
  }
  const sbpfVersion = solanaSbpfVersion(image.elfFlags);
  if (image.machine !== ELF_MACHINE_BPF)
    return err(
      unsupportedTarget(
        OPERATION,
        acquired.path,
        "elf",
        `ELF machine ${String(image.machine)} is not sBPF (EM_BPF 263); this analyzer covers Solana programs only.`,
      ),
    );
  // The bundled decoder reads little-endian words only; refuse before
  // disassembly rather than report wrong offsets, constants and targets.
  if (image.byteOrder !== "little")
    return err(
      unsupportedTarget(
        OPERATION,
        acquired.path,
        "elf",
        "Big-endian sBPF ELF is not supported; the bundled decoder reads little-endian (Solana) instruction words only.",
        { undecodedContent: true, field: "e_ident[EI_DATA]" },
      ),
    );

  const textSection = solanaTextSection(image);
  if (textSection !== undefined) {
    const extentFailure = codeExtentFailure(acquired, textSection);
    if (extentFailure !== undefined) return err(extentFailure);
  }
  const instructions =
    textSection === undefined
      ? []
      : disassembleSbpf(
          acquired.bytes.subarray(
            textSection.offset,
            textSection.offset + textSection.size,
          ),
          textSection.address,
          textSection.offset,
          sbpfVersion ?? 0,
        );
  const dispatch = scanSolanaDispatch(instructions, image);
  const handlers = dispatch.candidates;
  const callResolutions = resolveSolanaCallSites(instructions, image);
  const confirmedNames = new Map<string, string>();
  for (const name of instructionNames) {
    const discriminator = anchorDiscriminator(name);
    if (!confirmedNames.has(discriminator))
      confirmedNames.set(discriminator, name);
  }
  const limitations = [...BASE_LIMITATIONS];
  if (textSection === undefined)
    limitations.push(
      "The ELF carries no .text section; no disassembly or dispatch scan was possible.",
    );
  if (image.trailingBytes > 0)
    limitations.push(
      `The artifact carries ${String(image.trailingBytes)} trailing bytes beyond its ELF-declared extents (typical of account-capacity dumps); identity covers the whole file.`,
    );
  if (dispatch.truncatedTables > 0)
    limitations.push(
      `${String(dispatch.truncatedTables)} jump table(s) still held code targets past the ${String(SOLANA_MAX_TABLE_ENTRIES)}-slot table allowance; slots beyond it were not examined and are not listed as candidates.`,
    );
  if (sbpfVersion === null)
    limitations.push(
      `The ELF declares unrecognized e_flags 0x${image.elfFlags.toString(16)}; sbpf_version is null and the code was decoded with version 0 rules, so callx registers and version-specific opcodes may be misread.`,
    );
  if (acquired.source === "solana-rpc")
    limitations.push(
      "Fetched at finalized commitment from the selected RPC endpoint; the deployed program may differ from any earlier capture if it was upgraded.",
    );

  let definedSymbols = 0;
  const undefinedSymbols: SolanaElfImage["dynamicSymbols"][number][] = [];
  for (const symbol of image.dynamicSymbols) {
    if (symbol.sectionIndex !== 0) definedSymbols += 1;
    else if (symbol.name.length > 0) undefinedSymbols.push(symbol);
  }
  const counts = { unknown: 0, call: 0, exit: 0, lddw: 0 };
  for (const instruction of instructions) {
    if (isUnknownSbpfInstruction(instruction)) counts.unknown += 1;
    else if (instruction.mnemonic === "call") counts.call += 1;
    else if (instruction.mnemonic === "exit") counts.exit += 1;
    else if (instruction.mnemonic === "lddw") counts.lddw += 1;
  }
  const byMethod = {
    "lddw-compare": 0,
    "split-compare": 0,
    "table-dispatch": 0,
  };
  for (const handler of handlers) byMethod[handler.method] += 1;
  let resolvedCalls = 0;
  for (const resolution of callResolutions)
    if (resolution.resolvedName !== null) resolvedCalls += 1;

  const report: SolanaProgramAnalysis = {
    artifact: {
      path: acquired.path,
      sha256: sha256Hex(acquired.bytes),
      bytes: acquired.bytes.length,
      source: acquired.source,
      program_id: acquired.programId,
      program_data_account: acquired.programDataAccount,
      slot: acquired.slot,
    },
    elf: {
      bits: 64,
      byte_order: image.byteOrder,
      elf_type: image.elfType,
      machine: image.machine,
      machine_name: solanaElfMachineName(image.machine),
      entrypoint: image.entrypoint,
      program_header_count: image.programHeaders.length,
      section_header_count: image.sections.length,
      trailing_bytes: image.trailingBytes,
      e_flags: image.elfFlags,
      sbpf_version: sbpfVersion,
      sections: image.sections.map((section) => ({
        name: section.name,
        type: section.type,
        address: section.address,
        offset: section.offset,
        size: section.size,
      })),
    },
    disassembly: {
      engine: "rea-sbpf-decoder",
      text_section: textSection?.name ?? null,
      instruction_count: instructions.length,
      unknown_opcodes: counts.unknown,
      call_sites: counts.call,
      exit_sites: counts.exit,
      lddw_constants: counts.lddw,
      coverage: textSection === undefined ? "no-text-section" : "complete",
    },
    handlers: handlers.map((handler) => ({
      method: handler.method,
      discriminator: handler.discriminator,
      label: handler.label,
      name:
        handler.discriminator === null
          ? null
          : (confirmedNames.get(handler.discriminator) ?? null),
      constant_address: handler.constantAddress,
      constant_file_offset: handler.constantFileOffset,
      comparison_address: handler.comparisonAddress,
      comparison_addresses: [...handler.comparisonAddresses],
      branch: handler.branch,
      branch_target: handler.branchTarget,
      value_register: handler.valueRegister,
      constant_register: handler.constantRegister,
      table_address: handler.tableAddress,
      table_index: handler.tableIndex,
    })),
    dispatch: {
      total_candidates: handlers.length,
      by_method: byMethod,
      computed_jumps_unresolved: dispatch.computedJumpsUnresolved,
    },
    syscalls: {
      // Distinct names only: thousands of symbols can share one long
      // name, and repeating it per symbol would let a small capture
      // expand into an unbounded report. The distinct total is bounded
      // by the parser's retained-name allowance.
      dynamic_symbols: [
        ...new Set(undefinedSymbols.map((symbol) => symbol.name)),
      ].sort(),
      defined_symbols: definedSymbols,
      undefined_symbols: undefinedSymbols.length,
      call_sites: callResolutions.map((resolution) => ({
        address: resolution.address,
        immediate: resolution.immediate,
        resolved_name: resolution.resolvedName,
        basis: resolution.basis,
        note: resolution.note,
      })),
      resolved_calls: resolvedCalls,
      unresolved_calls: callResolutions.length - resolvedCalls,
    },
    strings: extractStrings(image),
    limitations,
  };
  return ok({ report, callResolutions, instructions });
};

interface PlannedOutputFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Every file the analysis writes under out_dir, with reserved distinct names. */
const plannedOutputs = (
  input: AnalyzeSolanaProgramInput & { readonly out_dir: string },
  acquired: AcquiredProgram,
  report: SolanaProgramAnalysis,
  callResolutions: readonly SolanaCallResolution[],
  instructions: readonly SbpfInstruction[],
): PlannedOutputFile[] => {
  const files: PlannedOutputFile[] = [];
  const text = (value: string): Uint8Array => Buffer.from(value, "utf8");
  if (acquired.source === "solana-rpc" && acquired.programId !== null)
    files.push({
      relativePath: solanaFetchedElfName(acquired.programId),
      bytes: acquired.bytes,
    });
  files.push({
    relativePath: SOLANA_ANALYSIS_FILE,
    bytes: text(`${JSON.stringify(report, null, 2)}\n`),
  });
  if (report.disassembly.coverage === "complete") {
    const resolvedByAddress = new Map(
      callResolutions
        .filter((resolution) => resolution.resolvedName !== null)
        .map((resolution) => [resolution.address, resolution]),
    );
    const lines = instructions.map((instruction) => {
      const line = `${instruction.address.toString(16).padStart(8, "0")}  ${instruction.text}`;
      const resolution = resolvedByAddress.get(instruction.address);
      return resolution === undefined
        ? line
        : `${line}  ; ${resolution.resolvedName as string}`;
    });
    files.push({
      relativePath: DISASSEMBLY_FILE,
      bytes: text(`${lines.join("\n")}\n`),
    });
  }
  if (input.handoff === true) {
    const elfFileName = `${HANDOFF_ELF_DIRECTORY}/${basename(acquired.path)}`;
    const handoff = buildSolanaHandoff(
      report,
      join(input.out_dir, SOLANA_ANALYSIS_FILE),
    );
    files.push(
      { relativePath: elfFileName, bytes: acquired.bytes },
      {
        relativePath: "handoff/handoff.json",
        bytes: text(`${JSON.stringify(handoff, null, 2)}\n`),
      },
      {
        relativePath: "handoff/HANDOFF.md",
        bytes: text(renderSolanaHandoffBrief(report, handoff, elfFileName)),
      },
    );
  }
  return files;
};

/** In-process Solana program analyzer: ELF intake, sBPF disassembly, Anchor dispatch scan. */
export class SolanaProgramProvider implements SolanaProgramPort {
  readonly identity = SOLANA_PROGRAM_PROVIDER_IDENTITY;

  /**
   * Cleanup leases for output trees whose rollback could not prove
   * removal. The provider owns them until release succeeds: `close()`
   * retries every retained lease, so failed cleanup is never dropped.
   */
  #retainedCleanup: AnalysisCleanupLease[] = [];

  constructor(
    private readonly defaults: {
      readonly rpcUrl?: string;
    } = {},
  ) {}

  /**
   * Roll back an unpublished tree. When rollback cannot prove removal,
   * the tree stays owned by a cleanup lease bound to the returned
   * cleanup error and retained here, so the residual output is reported
   * and `close()` can retry its release.
   */
  async #rollbackRetained(
    tree: SafeOutputTree,
  ): Promise<AnalysisError | undefined> {
    const lease = new AnalysisCleanupLease(async () => {
      await tree.rollback();
    }, [tree.outputRoot]);
    try {
      await lease.release();
      return undefined;
    } catch (cause) {
      this.#retainedCleanup.push(lease);
      const cleanup = new ProviderCleanupError(
        SOLANA_PROGRAM_PROVIDER_IDENTITY.id,
        [tree.outputRoot],
        { reason: errorMessage(cause) },
        { cause, operation: OPERATION },
      );
      new AnalysisCleanupLeaseGroup(cleanup, [lease]);
      return cleanup;
    }
  }

  /**
   * Publish the analysis through the shared SafeOutputTree owner: out_dir
   * must be absent or an empty directory, every file is created
   * exclusively and digest-verified, and an incomplete tree is rolled
   * back. A selected directory that already holds the capture (or
   * anything else) is refused, so a successful analysis can never
   * overwrite its own input.
   */
  async #writeArtifacts(
    input: AnalyzeSolanaProgramInput,
    acquired: AcquiredProgram,
    report: SolanaProgramAnalysis,
    callResolutions: readonly SolanaCallResolution[],
    instructions: readonly SbpfInstruction[],
    signal: AbortSignal | undefined,
  ): Promise<AnalysisError | undefined> {
    if (input.out_dir === undefined) return undefined;
    const outDir = input.out_dir;
    const files = plannedOutputs(
      { ...input, out_dir: outDir },
      acquired,
      report,
      callResolutions,
      instructions,
    );
    let tree: SafeOutputTree | undefined;
    try {
      tree = await SafeOutputTree.create(outDir, undefined, {
        acceptExistingEmpty: true,
        createParents: true,
      });
      for (const file of files) {
        const expected = sha256Hex(file.bytes);
        const written = await tree.write(
          file.relativePath,
          Readable.from([file.bytes]),
          { sha256: expected, bytes: file.bytes.length },
          signal,
        );
        if (written.sha256 !== expected) throw new Error("digest mismatch");
      }
      await tree.commit(signal);
      return undefined;
    } catch (cause) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      const refusal = outputDirectoryAdmissionRefusal(
        OPERATION,
        "out_dir",
        cause,
      );
      // A refused destination was never claimed: there is nothing to roll back.
      const cleanupFailure =
        tree === undefined || tree.published || refusal instanceof AnalysisError
          ? undefined
          : await this.#rollbackRetained(tree);
      const primary = isAborted(signal)
        ? cancelledBy(OPERATION, signal)
        : refusal instanceof AnalysisError
          ? refusal
          : adapterError(cause);
      return cleanupFailure === undefined
        ? primary
        : analysisErrorWithCleanupDependencies(
            primary,
            cleanupFailure,
            OPERATION,
          );
    }
  }

  /**
   * Retry release of every output tree whose rollback failed. Trees that
   * release are forgotten; any that still cannot be proven removed stay
   * retained and are reported as a cleanup error naming their roots.
   */
  async close(): Promise<void> {
    const retained = this.#retainedCleanup;
    if (retained.length === 0) return;
    this.#retainedCleanup = [];
    const unreleased: AnalysisCleanupLease[] = [];
    let reason = "";
    for (const lease of retained) {
      try {
        await lease.release();
      } catch (cause) {
        unreleased.push(lease);
        reason = errorMessage(cause);
      }
    }
    if (unreleased.length === 0) return;
    this.#retainedCleanup = unreleased;
    const failure = new ProviderCleanupError(
      SOLANA_PROGRAM_PROVIDER_IDENTITY.id,
      unreleased.flatMap((lease) => lease.cleanupResources ?? []),
      { reason },
      { operation: OPERATION },
    );
    // The retry error follows its exact cleanup owners: once every
    // retained lease releases, it stops reporting cleanup incomplete.
    new AnalysisCleanupLeaseGroup(failure, unreleased);
    throw failure;
  }

  async analyze(
    input: AnalyzeSolanaProgramInput,
    options?: ExecutionOptions,
  ): Promise<Result<SolanaProgramAnalysis, AnalysisError>> {
    const signal = options?.signal;
    const acquired =
      input.path !== undefined
        ? await readLocalElf(input.path, signal)
        : await fetchProgramElf(
            input,
            input.rpc_url ?? this.defaults.rpcUrl ?? DEFAULT_SOLANA_RPC_URL,
            signal,
          );
    if (!acquired.ok) return acquired;
    const analyzed = analyzeAcquired(
      acquired.value,
      input.instruction_names ?? [],
    );
    if (!analyzed.ok) return analyzed;
    const writeFailure = await this.#writeArtifacts(
      input,
      acquired.value,
      analyzed.value.report,
      analyzed.value.callResolutions,
      analyzed.value.instructions,
      signal,
    );
    if (writeFailure !== undefined) return err(writeFailure);
    return ok(analyzed.value.report);
  }
}
