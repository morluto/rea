import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PeRichHeaderPort } from "./PeRichHeaderPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPeRichHeaderInputSchema,
  PE_RICH_HEADER_ENTRY_BYTES,
  PE_RICH_HEADER_FOOTER_BYTES,
  PE_RICH_HEADER_START_BYTES,
  peRichHeaderSchema,
  type PeRichHeader,
} from "../../domain/native/peRichHeader.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_pe_rich_header";
const DOS_HEADER_BYTES = 64;

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeRichHeaderService {
  constructor(readonly provider: PeRichHeaderPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectPeRichHeaderInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = peRichHeaderSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "PE Rich header provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = peSubjectArchitecture(value.machine, value.format);
    const record = recordRange(value);
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "pe",
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path" as const, path: value.artifact.path },
            ...(record === null
              ? []
              : [
                  {
                    kind: "file-offset-range" as const,
                    start: record.offset,
                    end: record.offset + record.bytes,
                  },
                ]),
          ],
        },
      ),
      options?.signal,
    );
  }
}

/** The span the record occupies: the whole block, or only its footer when malformed. */
const recordRange = (
  report: PeRichHeader,
): { offset: number; bytes: number } | null => {
  const record = report.rich_header;
  if (record.state === "absent") return null;
  return record.state === "present" ? record.location : record.footer_location;
};

const validReport = (
  report: PeRichHeader,
  input: { max_entries: number; max_file_bytes: number },
): boolean => {
  const pe = report.pe_header_offset;
  if (
    report.artifact.bytes > input.max_file_bytes ||
    pe < DOS_HEADER_BYTES ||
    pe > report.artifact.bytes - 24
  )
    return false;
  const record = report.rich_header;
  if (record.state === "absent") return true;
  const footer = record.footer_location;
  if (
    footer.bytes !== PE_RICH_HEADER_FOOTER_BYTES ||
    footer.offset % 4 !== 0 ||
    footer.offset < DOS_HEADER_BYTES ||
    footer.offset > pe - footer.bytes
  )
    return false;
  if (record.state === "malformed") return true;
  const { location, entries } = record;
  return (
    entries.length <= input.max_entries &&
    location.offset >= DOS_HEADER_BYTES &&
    location.bytes ===
      PE_RICH_HEADER_START_BYTES +
        entries.length * PE_RICH_HEADER_ENTRY_BYTES +
        PE_RICH_HEADER_FOOTER_BYTES &&
    location.offset + location.bytes === footer.offset + footer.bytes &&
    record.checksum.matches === (record.checksum.computed === record.key)
  );
};
