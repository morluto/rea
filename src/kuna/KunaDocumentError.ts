import { ParseFailureError } from "../domain/parseFailure.js";

const KUNA_DOCUMENT_CODES = [
  "invalid_address",
  "address_exceeds_u64",
  "buffered_capacity",
  "row_field",
  "not_kuna_number",
  "not_json_object",
  "member_not_container",
  "row_not_object",
  "row_not_array",
  "row_must_be_null",
  "field_must_be_empty",
  "repeated_field",
  "value_without_member",
  "rows_not_array",
  "not_object",
  "not_scalar",
  "unexpected_token",
  "encoding_contradicts_text",
  "length_contradicts_text",
  "address_hex_disagrees",
  "repeated_identity",
  "repeated_function",
  "repeated_edge",
  "repeated_callee_order",
  "xref_identity",
  "xref_count",
  "xref_alias_hex",
  "xref_endpoints",
  "xref_function_hex",
  "xref_target",
  "span_short",
] as const;

export type KunaDocumentCode = (typeof KUNA_DOCUMENT_CODES)[number];

const KUNA_FORMAT = "kuna-document";

type KunaDocumentFacts = Readonly<Record<string, string | number>>;

/**
 * Kuna document failure. `code` is the stable identity. A document larger
 * than its buffered allowance is a `limit`, a span that reads short is
 * `truncated`, and every other code is `malformed`.
 */
export class KunaDocumentError extends ParseFailureError<
  "malformed" | "truncated" | "limit"
> {
  readonly code: KunaDocumentCode;
  /** Format-specific facts, such as the field that failed. */
  readonly facts: KunaDocumentFacts | undefined;

  constructor(
    code: Exclude<KunaDocumentCode, "buffered_capacity">,
    facts?: KunaDocumentFacts,
  );
  constructor(code: "buffered_capacity", facts: { maximum_bytes: number });
  constructor(code: KunaDocumentCode, facts?: KunaDocumentFacts) {
    const field =
      typeof facts?.field === "string" ? { field: facts.field } : {};
    const maximum = facts?.maximum_bytes;
    super(
      code === "buffered_capacity" && typeof maximum === "number"
        ? {
            kind: "limit",
            format: KUNA_FORMAT,
            detail: code,
            limit: { name: "kuna-buffered-document-bytes", maximum },
          }
        : code === "span_short"
          ? { kind: "truncated", format: KUNA_FORMAT, detail: code, ...field }
          : { kind: "malformed", format: KUNA_FORMAT, detail: code, ...field },
    );
    this.name = "KunaDocumentError";
    this.code = code;
    this.facts = facts;
  }
}
