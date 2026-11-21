import {
  buildASTSchema,
  parse as parseNative,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from "graphql";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseGraphqlContractSteps } from "./parseGraphqlContract.js";
import { graphqlContractSchema } from "./graphqlContract.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import type { GraphqlSourceDocument } from "./GraphqlDocuments.js";

const source = (text: string, name: string): GraphqlSourceDocument => ({
  text,
  artifact: {
    path: "/fixtures/" + name + ".graphql",
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  },
});
const parse = (schema: string, operations?: string) => {
  const steps = parseGraphqlContractSteps(
    source(schema, "schema"),
    operations === undefined ? undefined : source(operations, "operations"),
  );
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};
const successful = (schema: string, operations?: string) => {
  const result = parse(schema, operations);
  if (!result.ok) throw result.error;
  return graphqlContractSchema.parse(result.value);
};

it("binds aliases and extension fields to exact SDL occurrences with list/null wrappers", () => {
  const schema =
    "type Query { people: [Person!]! } type Person { id: ID! } extend type Person { name: String }";
  const operations =
    "query People { rows: people { ...Identity name } } fragment Identity on Person { id }";
  const report = successful(schema, operations);
  expect(report.types.map((row) => [row.name, row.extension])).toEqual([
    ["Query", false],
    ["Person", false],
    ["Person", true],
  ]);
  expect(
    report.fields.map((row) => [row.field_key, row.type_ref, row.named_type]),
  ).toEqual([
    ["Query.people", "[Person!]!", "Person"],
    ["Person.id", "ID!", "ID"],
    ["Person.name", "String", "String"],
  ]);
  expect(
    report.references.map((row) => [
      row.field_name,
      row.response_key,
      row.parent_type_name,
      row.state,
    ]),
  ).toEqual([
    ["people", "rows", "Query", "resolved"],
    ["name", "name", "Person", "resolved"],
    ["id", "id", "Person", "resolved"],
  ]);
  for (const reference of report.references) {
    const field = report.fields.find(
      (row) => row.field_id === reference.schema_field_id,
    )!;
    expect(field.field_key).toBe(
      reference.parent_type_name + "." + reference.field_name,
    );
    expect(
      schema.slice(field.source.start_utf16, field.source.end_utf16),
    ).toContain(field.name);
    expect(
      operations.slice(
        reference.source.start_utf16,
        reference.source.end_utf16,
      ),
    ).toContain(reference.field_name);
  }
  expect(report.references[1]?.parent_reference_id).toBe(
    report.references[0]?.reference_id,
  );
  expect(report.references[2]?.parent_reference_id).toBeNull();
  expect(report.fragment_spreads[0]?.target_definition_id).toBe(
    report.definitions[1]?.definition_id,
  );
  expect(report.source_coverage).toMatchObject({
    status: "complete-within-scope",
    endpoint_behavior: "unknown",
  });
});

it("uses declared roots and interface/inline-fragment type scopes", () => {
  const report = successful(
    "schema { query: Root } interface Node { id: ID! } type User implements Node { id: ID! name: String } type Root { node: Node }",
    "{ node { id ... on User { name } } }",
  );
  expect(report.model_roots.query).toBe("Root");
  expect(report.references.map((row) => row.parent_type_name)).toEqual([
    "Root",
    "Node",
    "User",
  ]);
  expect(report.types.find((row) => row.name === "User")?.interfaces).toEqual([
    "Node",
  ]);
  expect(report.references.every((row) => row.state === "resolved")).toBe(true);
});

it("retains fragment cycles as finite edges without expanding selections", () => {
  const report = successful(
    "type Query { value: String }",
    "query Q { ...A } fragment A on Query { value ...A }",
  );
  expect(report.definitions).toHaveLength(2);
  expect(report.references).toHaveLength(1);
  expect(report.fragment_spreads).toHaveLength(2);
  expect(report.fragment_spreads.every((row) => row.state === "resolved")).toBe(
    true,
  );
  expect(report.source_coverage.operation_validation).toBe(
    "field-resolution-only",
  );
});

it("keeps duplicate fragment names ambiguous and missing fragments explicit", () => {
  const report = successful(
    "type Query { value: String }",
    "query Q { ...A ...Missing } fragment A on Query { value } fragment A on Query { value }",
  );
  expect(
    report.fragment_spreads.map((row) => [
      row.state,
      row.matching_definitions,
      row.target_definition_id,
    ]),
  ).toEqual([
    ["ambiguous", 2, null],
    ["missing", 0, null],
  ]);
  expect(report.summary.unresolved_spreads).toBe(2);
  expect(report.source_coverage.status).toBe("partial");
});

it("preserves duplicate SDL field occurrences without selecting a model winner", () => {
  const report = successful(
    "type Query { value: String value: Int }",
    "{ value }",
  );
  expect(report.fields.map((row) => row.field_key)).toEqual([
    "Query.value",
    "Query.value",
  ]);
  expect(new Set(report.fields.map((row) => row.field_id)).size).toBe(2);
  expect(report.source_coverage.schema_model).toBe("unavailable");
  expect(report.references[0]).toMatchObject({
    state: "unknown",
    reason: "schema-model-unavailable",
    schema_field_id: null,
  });
});

it("retains unknown field and unavailable parent scopes instead of assuming absence", () => {
  const report = successful(
    "type Query { value: String }",
    "{ missing { child } }",
  );
  expect(report.references.map((row) => row.reason)).toEqual([
    "unknown-field",
    "parent-type-unavailable",
  ]);
  expect(report.summary.unknown_references).toBe(2);
  expect(report.source_coverage.status).toBe("partial");
});

it("distinguishes library model fields from supplied SDL declarations", () => {
  const report = successful("type Query { value: String }", "{ __typename }");
  expect(report.references[0]).toMatchObject({
    state: "model-only",
    reason: "no-sdl-source",
    schema_field_id: null,
    result_type: "String!",
  });
  expect(report.summary.model_only_references).toBe(1);
});

it("preserves input fields, union members and ordinary credential-like names", () => {
  const report = successful(
    "input Input { access_token: String } type User { authorization: String } union Result = User type Query { result(input: Input): Result }",
    "{ result { ... on User { authorization } } }",
  );
  expect(
    report.fields.find((row) => row.field_key === "Input.access_token")?.kind,
  ).toBe("input");
  expect(report.types.find((row) => row.name === "Result")?.members).toEqual([
    "User",
  ]);
  expect(report.references.at(-1)?.field_name).toBe("authorization");
});

it("keeps verified SDL facts when the operation document cannot be parsed", () => {
  const report = successful(
    "type Query { value: String }",
    '{ value( url: "https://name:FAKE_GQL_SECRET@example.invalid" ) ',
  );
  expect(report.fields).toHaveLength(1);
  expect(report.operations_artifact).not.toBeNull();
  expect(report.source_coverage.operations).toBe("unavailable");
  expect(report.diagnostics[0]).toMatchObject({
    code: "operations-parse-refused",
    source_role: "operations",
    source: { line: 1 },
  });
  expect(JSON.stringify(report)).not.toContain("FAKE_GQL_SECRET");
});

it("retains partial source metadata and source-located neutral diagnostics on schema refusal", () => {
  const result = parse(
    'type Query { field: "https://name:FAKE_GQL_SECRET@example.invalid" }',
  );
  if (result.ok) throw new Error("Expected syntax refusal");
  expect(result.error._tag).toBe("AnalysisInputError");
  const partial = graphqlContractSchema.parse(result.error.partialObservation);
  expect(partial.source_coverage.schema_declarations).toBe("unavailable");
  expect(partial.diagnostics[0]).toMatchObject({
    code: "schema-parse-refused",
    source: { line: 1 },
  });
  expect(JSON.stringify(projectAnalysisError(result.error))).not.toContain(
    "FAKE_GQL_SECRET",
  );
});

it("preserves UTF-16/BOM positions and stable content identities across repeated imports", () => {
  const schema = "\uFEFF\n# 雪🦊\ntype Query { value: String }";
  const one = successful(schema, "{ value }"),
    two = successful(schema, "{ value }");
  expect(one).toEqual(two);
  const field = one.fields[0]!;
  expect(field.source).toMatchObject({ role: "schema", line: 3, column: 14 });
  expect(schema.slice(field.source.start_utf16, field.source.end_utf16)).toBe(
    "value: String",
  );
});

it("refuses deep ASTs through a typed resource result with retained schema facts", () => {
  const result = parse(
    "type Query { child: Query }",
    "{ child ".repeat(90) + "}".repeat(90),
  );
  if (result.ok) throw new Error("Expected nesting admission refusal");
  expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  expect(
    graphqlContractSchema.parse(result.error.partialObservation).fields,
  ).toHaveLength(1);
});

it("imports the unmodified published SWAPI SDL with independently counted declarations", async () => {
  const bytes = await readFile(
    new URL(
      "../../../tests/fixtures/graphql/swapi.graphql.txt",
      import.meta.url,
    ),
  );
  expect(bytes.length).toBe(35868);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "ebc4d09b21e2aec2735d6f0d3c812fc017cd49a44900dd3ae34f49f6f8c25133",
  );
  const report = successful(
    bytes.toString("utf8"),
    "query Films { allFilms(first: 2) { films { ...FilmIdentity } } } fragment FilmIdentity on Film { id title }",
  );
  expect(report.summary).toMatchObject({
    types: 53,
    fields: 243,
    definitions: 2,
    references: 4,
    unknown_references: 0,
  });
  expect(report.model_roots.query).toBe("Root");
  expect(report.source_coverage.status).toBe("complete-within-scope");
});

it("retains a bounded prefix when expanded field facts exceed the shared allowance", () => {
  const result = parse(
    "type Query { " +
      Array.from({ length: 18000 }, (_, i) => `field${i}: String`).join(" ") +
      " }",
  );
  if (result.ok) throw new Error("Expected fact capacity refusal");
  expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  const report = graphqlContractSchema.parse(result.error.partialObservation);
  expect(report.fields.length).toBeGreaterThan(1000);
  expect(report.fields.length).toBeLessThan(18000);
  expect(report.source_coverage).toMatchObject({
    status: "partial",
    schema_declarations: "partial",
  });
});

it("matches full SDK field scope while pruning variable defaults, arguments and directive payloads", () => {
  const schema =
    "directive @choice(values: [Int!]) on FIELD | QUERY input Filter { name: String } type Query { user(filter: Filter): User } type User { id: ID! name: String }";
  const operations =
    'query Q($filter: Filter = {name:"default"}) @choice(values:[1,2]) { first: user(filter:$filter) @choice(values:[3]) { id } user(filter:{name:"x"}) { id ... on User { name } ...Names } } fragment Names on User { name }';
  const info = new TypeInfo(buildASTSchema(parseNative(schema)));
  const expected: unknown[] = [];
  visit(
    parseNative(operations),
    visitWithTypeInfo(info, {
      Field(node) {
        expected.push([
          node.name.value,
          node.alias?.value ?? node.name.value,
          info.getParentType()?.name ?? null,
          String(info.getType()),
        ]);
      },
    }),
  );
  const report = successful(schema, operations);
  expect(
    report.references.map((row) => [
      row.field_name,
      row.response_key,
      row.parent_type_name,
      row.result_type,
    ]),
  ).toEqual(expected);
  expect(report.references.every((row) => row.state === "resolved")).toBe(true);
});
