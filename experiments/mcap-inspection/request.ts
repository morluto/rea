import { parseArgs } from "node:util";
import { createHash, type Hash } from "node:crypto";
import { err, ok } from "../../src/domain/result.js";
import { jsonValueByteLength } from "../../src/domain/jsonValueByteLength.js";
import { InspectionFailure } from "./limits.ts";

export type RequestProvenance = {
  readonly arguments: string[];
  readonly positionals: string[] | null;
};

export function parseRequest(args: string[]) {
  const parsed = parseArgs({
    args,
    strict: false,
    tokens: true,
    allowPositionals: true,
    options: { schema: { type: "string" } },
  });
  return {
    ...parsed,
    request: { arguments: args, positionals: parsed.positionals },
  };
}

export function validateRequest(parsed: ReturnType<typeof parseRequest>) {
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (token.name !== "schema")
      return err(
        new InspectionFailure("input", `Unknown option '${token.rawName}'`),
      );
    if (
      token.value === undefined ||
      (!token.inlineValue && token.value.startsWith("-"))
    )
      return err(new InspectionFailure("input", "--schema requires a value"));
  }
  const input = parsed.positionals[0];
  if (input === undefined || parsed.positionals.length !== 1)
    return err(
      new InspectionFailure(
        "input",
        "Usage: npm run inspect -- FILE [--schema ID]",
      ),
    );
  const schema = parsed.values.schema;
  if (
    schema !== undefined &&
    (typeof schema !== "string" ||
      !/^[1-9][0-9]{0,4}$/.test(schema) ||
      Number(schema) > 65535)
  )
    return err(
      new InspectionFailure(
        "input",
        "Schema ID must be an integer from 1 to 65535",
      ),
    );
  return ok({
    input,
    schemaId: schema === undefined ? undefined : Number(schema),
  });
}

function hashStrings(hash: Hash, values: readonly string[] | null): void {
  if (values === null) {
    hash.update("null");
    return;
  }
  hash.update("[");
  for (const [index, value] of values.entries()) {
    if (index > 0) hash.update(",");
    hash.update('"');
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 4096, value.length);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      hash.update(JSON.stringify(value.slice(start, end)).slice(1, -1));
      start = end;
    }
    hash.update('"');
  }
  hash.update("]");
}

export function omittedRequest(request: RequestProvenance) {
  const hash = createHash("sha256").update('{"arguments":');
  hashStrings(hash, request.arguments);
  hash.update(',"positionals":');
  hashStrings(hash, request.positionals);
  hash.update("}");
  return {
    omitted: "json_limit",
    json_bytes: jsonValueByteLength(request),
    sha256: hash.digest("hex"),
  };
}
