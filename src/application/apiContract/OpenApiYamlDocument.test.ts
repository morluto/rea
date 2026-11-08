import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { apiContractSchema } from "../../domain/apiContract/apiContract.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectApiContractEvidence } from "./ApiContractService.js";
import { decodeOpenApiYaml } from "./OpenApiYamlDocument.js";

const jsonFixture = new URL(
  "../../../tests/fixtures/openapi/petstore.json.txt",
  import.meta.url,
);
const yamlFixture = new URL(
  "../../../tests/fixtures/openapi/petstore.yaml.txt",
  import.meta.url,
);

const importText = async (name: string, text: string, format: string) => {
  const root = await createTestTempDirectory("rea-api-contract-yaml-");
  const path = join(root, name);
  await writeFile(path, text);
  return inspectApiContractEvidence(
    format === "openapi-yaml"
      ? { path, format: "openapi-yaml", detail: "complete" }
      : { path, detail: "complete" },
    new ArtifactResourceScope(),
  );
};

const contractOf = (result: Awaited<ReturnType<typeof importText>>) => {
  if (!result.ok) throw result.error;
  return apiContractSchema.parse(result.value.normalized_result);
};

const yamlText = (paths: readonly string[]) =>
  [
    "openapi: 3.0.4",
    "info:",
    "  title: Owned API",
    '  version: "1"',
    "paths:",
    ...paths.map((path) => `  ${path}: {get: {operationId: op}}`),
  ].join("\n");

it("inventories the same declarations from the published YAML and JSON contracts", async () => {
  const [jsonBytes, yamlBytes] = await Promise.all([
    readFile(jsonFixture),
    readFile(yamlFixture),
  ]);
  const json = await importText("contract.json", jsonBytes.toString(), "openapi-json");
  const yaml = await importText("contract.yaml", yamlBytes.toString(), "openapi-yaml");
  const fromJson = contractOf(json);
  const fromYaml = contractOf(yaml);

  expect(fromJson.format).toBe("openapi-json");
  expect(fromYaml.format).toBe("openapi-yaml");
  expect(fromYaml.artifact).toEqual({
    path: fromYaml.artifact.path,
    bytes: yamlBytes.length,
    sha256: createHash("sha256").update(yamlBytes).digest("hex"),
  });
  // Format identity is recorded; every declaration the source makes is not.
  // Operation identity is source-digest-scoped, so it may differ.
  const declarations = (contract: typeof fromYaml) =>
    contract.operations.map(({ operation_id: _id, ...rest }) => rest);
  expect(declarations(fromYaml)).toEqual(declarations(fromJson));
  expect(fromYaml.path_item_references).toEqual(fromJson.path_item_references);
  expect(fromYaml.diagnostics).toEqual(fromJson.diagnostics);
  expect(fromYaml.info).toEqual(fromJson.info);
  expect(fromYaml.openapi).toBe(fromJson.openapi);
  expect(fromYaml.summary).toEqual(fromJson.summary);
  expect(fromYaml.summary.declared).toBe(19);
  expect(fromYaml.source_coverage).toEqual({
    ...fromJson.source_coverage,
    duplicate_json_members: "rejected",
  });
  expect(json.ok && json.value.evidence_id).not.toBe(
    yaml.ok && yaml.value.evidence_id,
  );
});

it("records YAML anchors, aliases, tags and comments without changing the facts", async () => {
  const text = [
    "# Anchors and comments are presentation, not declarations.",
    "openapi: 3.0.4",
    "info:",
    '  title: !!str "Owned API"',
    '  version: "1"',
    "shared: &responses",
    '  "200": {description: ok}',
    "paths:",
    "  /known:",
    "    get:",
    "      operationId: known",
    "      responses: *responses",
  ].join("\n");
  const contract = contractOf(
    await importText("anchors.yaml", text, "openapi-yaml"),
  );
  expect(contract.operations).toEqual([
    expect.objectContaining({
      method: "GET",
      path: "/known",
      declared_id: "known",
      state: "declared",
    }),
  ]);
  expect(contract.diagnostics).toEqual([]);
  expect(
    contract.limitations.some((limitation) =>
      limitation.includes("A repeated mapping key is rejected"),
    ),
  ).toBe(true);
});

it("rejects YAML that the decoder cannot compose, without inventing declarations", async () => {
  const malformed = contractError(
    await importText("broken.yaml", "openapi: 3.0.4\npaths: [\n", "openapi-yaml"),
  );
  expect(malformed).toContain("OpenAPI YAML could not be parsed");

  const repeated = contractError(
    await importText(
      "repeated.yaml",
      yamlText(["/a"]).replace(
        '  version: "1"',
        '  version: "1"\n  version: "2"',
      ),
      "openapi-yaml",
    ),
  );
  expect(repeated).toContain("repeats a mapping key");
});

it("rejects composition failures and non-scalar keys without escaping the Result", async () => {
  const unresolved = contractError(
    await importText(
      "unresolved.yaml",
      'openapi: 3.0.4\ninfo:\n  title: Owned API\n  version: "1"\npaths: *missing\n',
      "openapi-yaml",
    ),
  );
  expect(unresolved).toContain("could not be composed");

  const complexKey = contractError(
    await importText(
      "complex-key.yaml",
      [
        "openapi: 3.0.4",
        "info:",
        "  title: Owned API",
        '  version: "1"',
        "paths:",
        "  ? [/pets]",
        "  : {get: {operationId: op}}",
      ].join("\n"),
      "openapi-yaml",
    ),
  );
  expect(complexKey).toContain("non-scalar mapping key");
});

it("rejects an empty YAML document and non-UTF-8 bytes", async () => {
  expect(
    contractError(await importText("empty.yaml", "", "openapi-yaml")),
  ).toContain("OpenAPI YAML is empty");
  const root = await createTestTempDirectory("rea-api-contract-yaml-");
  const path = join(root, "binary.yaml");
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x00]));
  expect(
    contractError(
      await inspectApiContractEvidence(
        { path, format: "openapi-yaml", detail: "complete" },
        new ArtifactResourceScope(),
      ),
    ),
  ).toContain("not valid UTF-8");
});

it("decodes only the JSON-compatible shape the shared parser already accepts", () => {
  const decoded = decodeOpenApiYaml(
    Buffer.from('openapi: "3.1.0"\ninfo: {title: t, version: "1"}\n'),
    "/owned.yaml",
  );
  expect(decoded).toEqual({
    ok: true,
    value: { openapi: "3.1.0", info: { title: "t", version: "1" } },
  });
  const unsupported = decodeOpenApiYaml(
    Buffer.from("openapi: 3.3.0\ninfo: {}\n"),
    "/owned.yaml",
  );
  // Version refusal belongs to the shared parser, not the decoder.
  expect(unsupported.ok).toBe(true);
});

it("keeps collection-valued sequence items and names the selected format in parser refusals", async () => {
  // A sequence item is a value, never a member name, so these documents are
  // composable and must not be refused as non-scalar keys.
  const nested = contractOf(
    await importText(
      "nested.yaml",
      [
        "openapi: 3.0.4",
        'info: {title: Owned API, version: "1"}',
        "paths: {}",
        "servers:",
        "  - url: /a",
        "examples: [[1, 2], [3, 4]]",
        "list:",
        "  - - 1",
        "    - 2",
      ].join("\n"),
      "openapi-yaml",
    ),
  );
  expect(nested.operations).toEqual([]);

  const missingVersion = contractError(
    await importText(
      "no-version.yaml",
      "info: {title: t}\npaths: {}\n",
      "openapi-yaml",
    ),
  );
  expect(missingVersion).toContain("OpenAPI YAML document");
  expect(missingVersion).not.toContain("OpenAPI JSON object");

  const unsupportedVersion = contractError(
    await importText(
      "bad-version.yaml",
      'openapi: "3.3.0"\ninfo: {}\n',
      "openapi-yaml",
    ),
  );
  expect(unsupportedVersion).toContain(
    "Only OpenAPI 3.0, 3.1 and 3.2 YAML documents are supported.",
  );
});

const contractError = (
  result: Awaited<ReturnType<typeof importText>>,
): string => {
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  const issues = (result.error as { issues?: readonly { message: string }[] })
    .issues;
  return [result.error.message, ...(issues ?? []).map(({ message }) => message)]
    .join("\n");
};
