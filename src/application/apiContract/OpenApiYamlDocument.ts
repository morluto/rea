import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  LineCounter,
  parseDocument,
  type Node,
} from "yaml";

import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { getHeapStatistics } from "node:v8";
import { nativeJsonParseRequiredBytes } from "../JsonInputFile.js";
import { API_CONTRACT_OPERATION } from "../../domain/apiContract/apiContract.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";

const YAML_ALIAS_LIMIT = 100;

/**
 * Walk the composed node tree without recursion. `yaml`'s own `visit` helper
 * descends recursively, so a document that nests deeper than the remaining
 * stack would throw `RangeError` instead of returning the typed refusal this
 * decoder owes its callers.
 */
function* yamlNodes(root: unknown): Generator<Node> {
  const pending: Node[] = [];
  if (isNode(root)) pending.push(root);
  for (let current = pending.pop(); current !== undefined;) {
    yield current;
    if (isMap<unknown, unknown>(current))
      for (const pair of current.items)
        pending.push(pair.key as Node, pair.value as Node);
    else if (isCollection(current))
      for (const item of current.items) if (isNode(item)) pending.push(item);
    current = pending.pop();
  }
}

const invalidDocument = (path: string, message: string): AnalysisError =>
  new AnalysisInputError(
    API_CONTRACT_OPERATION,
    {
      remediationAction:
        "Save the OpenAPI document as JSON, or correct the YAML syntax and select it with --contractFormat openapi-yaml.",
    },
    [
      {
        path: ["path"],
        reason: "invalid_format",
        message: `${message} (${path})`,
      },
    ],
  );

const duplicateKeyDiagnostic = (
  path: string,
  line: number | undefined,
): AnalysisError =>
  new AnalysisInputError(
    API_CONTRACT_OPERATION,
    {
      remediationAction:
        "Remove the repeated mapping key, or save the document as JSON where a repeated member resolves last-value-wins.",
    },
    [
      {
        path: ["path"],
        reason: "invalid_format",
        message: `OpenAPI YAML repeats a mapping key${line === undefined ? "" : ` at line ${String(line + 1)}`} (${path}). The JSON profile resolves a repeated member last-value-wins; YAML composition cannot express the same declaration, so no operation is inventoried until the key is unique.`,
      },
    ],
  );

/**
 * Decode one OpenAPI YAML document into the same JSON-compatible value the
 * JSON profile produces. YAML aliases are expanded before validation, so the
 * alias bound is applied to the expanded shape rather than to source size.
 */
export const decodeOpenApiYaml = (
  bytes: Uint8Array,
  path: string,
): Result<unknown, AnalysisError> => {
  // YAML composition allocates the decoded text, the composed document and its
  // JSON-compatible projection before any retained-fact allowance applies, so
  // admit the expansion against available heap first. The JSON profile bills a
  // fixture-backed snapshot twice; a YAML document keeps only one copy, so the
  // shared estimate covers it once.
  const required = nativeJsonParseRequiredBytes(bytes.length);
  const available = getHeapStatistics().total_available_size;
  if (required > available)
    return err(
      new AnalysisResourceConstraintError(
        API_CONTRACT_OPERATION,
        "memory",
        "Insufficient parser headroom for the admitted YAML representation expansion.",
        {
          input_bytes: bytes.length,
          required_bytes: required,
          available_heap_bytes: available,
        },
        {
          remediationAction:
            "Select a smaller complete document or free parser memory; paging a reply does not reduce YAML composition work.",
        },
      ),
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return err(
      invalidDocument(
        path,
        "OpenAPI YAML is not valid UTF-8; expected decoded text without a byte-order mark",
      ),
    );
  }
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    // Comments, styles and YAML 1.1 scalar dialects stay unread; the document
    // is composed to the same JSON-compatible shape the JSON profile parses.
    // `prettyErrors` stays on because `yaml` only fills `linePos` from it, and
    // a duplicate-key report has to name the source line it read.
    prettyErrors: true,
    // A repeated key cannot express the JSON profile's last-value-wins member.
    uniqueKeys: true,
    lineCounter,
  });
  const duplicate = document.errors.find(
    (error) => error.code === "DUPLICATE_KEY",
  );
  const duplicateLine = duplicate?.linePos?.[0]?.line;
  if (duplicate !== undefined)
    // `linePos` is already one-based; the helper adds 1 for its zero-based
    // callers, so subtract here as the projection-collision branch does.
    return err(
      duplicateKeyDiagnostic(
        path,
        duplicateLine === undefined ? undefined : duplicateLine - 1,
      ),
    );
  // An application-defined tag that nothing resolves is reported as a warning
  // and then dropped from `toJS`, which would report the untouched scalar as a
  // normal fact. The JSON profile cannot express such a tag either, so the
  // document is refused rather than projected with a value it never wrote.
  const unresolvedTag = document.warnings.find(
    (warning) => warning.code === "TAG_RESOLVE_FAILED",
  );
  if (unresolvedTag !== undefined)
    return err(
      invalidDocument(
        path,
        `OpenAPI YAML could not be parsed: ${unresolvedTag.message}`,
      ),
    );
  if (document.errors.length > 0) {
    const [first] = document.errors;
    return err(
      invalidDocument(
        path,
        `OpenAPI YAML could not be parsed: ${first?.message ?? "unknown syntax error"}`,
      ),
    );
  }
  // `toJS` projects a mapping key by coercion, so a sequence or mapping key
  // would become a property name no source document wrote, and two distinct
  // keys could collapse onto one member. The JSON profile only accepts string
  // member names, so refuse the document instead of inventing one.
  for (const node of yamlNodes(document.contents)) {
    if (!isMap<unknown, unknown>(node)) continue;
    const projected = new Set<string>();
    for (const pair of node.items) {
      const key = pair.key as Node;
      if (isCollection(key))
        return err(
          invalidDocument(
            path,
            "OpenAPI YAML uses a non-scalar mapping key; the JSON profile can only express string member names",
          ),
        );
      // A source alias whose anchor is a collection resolves to one here.
      const resolved = isAlias(key) ? key.resolve(document) : key;
      if (
        resolved === undefined ||
        !isScalar(resolved) ||
        isCollection(resolved)
      )
        return err(
          invalidDocument(
            path,
            "OpenAPI YAML uses a non-scalar mapping key; the JSON profile can only express string member names",
          ),
        );
      // Distinct source keys can share one projected member name: `1` and
      // `"1"` both become the property `"1"`, and an alias key can name one a
      // literal already names. `uniqueKeys` compares source nodes, so it
      // accepts both and `toJS` keeps only the later value.
      const member = String(resolved.value);
      if (projected.has(member))
        return err(
          duplicateKeyDiagnostic(
            path,
            key.range?.[0] === undefined
              ? undefined
              : lineCounter.linePos(key.range[0]).line - 1,
          ),
        );
      projected.add(member);
    }
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: YAML_ALIAS_LIMIT });
  } catch (cause: unknown) {
    // An unresolved alias reference and an alias expansion over the count
    // bound both throw out of `toJS`; they are expected refusals of this
    // document, not defects of the process.
    return err(
      invalidDocument(
        path,
        `OpenAPI YAML could not be composed into a document: ${cause instanceof Error ? cause.message : "unknown composition error"}`,
      ),
    );
  }
  if (document.contents === null)
    return err(invalidDocument(path, "OpenAPI YAML is empty"));
  return ok(value);
};
