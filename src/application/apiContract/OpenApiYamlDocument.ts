import { parseDocument } from "yaml";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { API_CONTRACT_OPERATION } from "../../domain/apiContract/apiContract.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";

const YAML_ALIAS_LIMIT = 100;

const invalidDocument = (path: string, message: string): AnalysisError =>
  new AnalysisInputError(
    API_CONTRACT_OPERATION,
    {
      remediationAction:
        "Save the OpenAPI document as JSON, or correct the YAML syntax and select it with --contractFormat openapi-yaml.",
    },
    [{ path: ["path"], reason: "invalid_format", message: `${message} (${path})` }],
  );

const duplicateKeyDiagnostic = (path: string, line: number | undefined): AnalysisError =>
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
  const document = parseDocument(text, {
    // Comments, styles and YAML 1.1 scalar dialects stay unread; the document
    // is composed to the same JSON-compatible shape the JSON profile parses.
    prettyErrors: false,
    // A repeated key cannot express the JSON profile's last-value-wins member.
    uniqueKeys: true,
  });
  const duplicate = document.errors.find(
    (error) => error.code === "DUPLICATE_KEY",
  );
  if (duplicate !== undefined)
    return err(duplicateKeyDiagnostic(path, duplicate.linePos?.[0]?.line));
  if (document.errors.length > 0) {
    const [first] = document.errors;
    return err(
      invalidDocument(
        path,
        `OpenAPI YAML could not be parsed: ${first?.message ?? "unknown syntax error"}`,
      ),
    );
  }
  const value: unknown = document.toJS({ maxAliasCount: YAML_ALIAS_LIMIT });
  if (document.contents === null)
    return err(invalidDocument(path, "OpenAPI YAML is empty"));
  return ok(value);
};
