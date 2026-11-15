import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse as parseGraphql } from "graphql";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const documents = [
  "query FieldFirst { user }",
  "query NamedSpread { ...UserFields } fragment UserFields on Query { user }",
  "query TypedInline { ... on Query { user } }",
  "query DirectedInline { ... @include(if: true) { user } }",
  "query UntypedInline { ... { ... { user } } }",
];

it.each(["text", "DocumentNode"] as const)(
  "retains GraphQL operation grammar and source Evidence through application analysis: %s",
  async (representation) => {
    const root = await createTestTempDirectory("rea-graphql-grammar-");
    const names =
      representation === "text"
        ? documents.map((text) => {
            const operation = parseGraphql(text).definitions.find(
              (definition) => definition.kind === "OperationDefinition",
            );
            if (operation?.name === undefined)
              throw new Error("Expected named operation");
            return operation.name.value;
          })
        : ["_", "_GetUser2"];
    const definitions =
      representation === "text"
        ? documents
            .map(
              (text, index) =>
                `const document${index} = ${index % 3 === 0 ? JSON.stringify(text) : index % 3 === 1 ? "gql`" + text + "`" : `{ body: ${JSON.stringify(text)}, locationOffset: { line: 1, column: 1 } }`};`,
            )
            .join("\n")
        : [...names, "", "two words", "123Name", "GetUser\n", "GetUser💫"]
            .map(
              (name, index) =>
                `const document${index} = { kind: "OperationDefinition", operation: "query", name: { kind: "Name", value: ${JSON.stringify(name)} } };`,
            )
            .join("\n");
    const source = `throw new Error("This authored input must never execute");\n${definitions}\nconst malformed = "query Broken { ... }";\nconst prose = "query string parameters";\nfetch(dynamicEndpoint);\n`;
    await writeFile(join(root, "app.mjs"), source);
    const analyzed = await analyzeJavaScriptApplication({
      input_path: root,
      format: "directory",
    });
    if (!analyzed.ok) throw analyzed.error;
    expect(analyzed.value.parameters).toMatchObject({
      input_path: root,
      format: "directory",
    });
    expect(analyzed.value.authority).toBe("shipped-artifact");
    const result = javascriptApplicationAnalysisResultSchema.parse(
      analyzed.value.normalized_result,
    );
    const endpoints = result.graph.nodes.filter(
      ({ kind }) => kind === "endpoint",
    );
    const graphql = endpoints
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties }) =>
          typeof properties.mechanism === "string" &&
          properties.mechanism.startsWith("graphql:"),
      );
    expect(graphql.map(({ properties }) => properties.value).sort()).toEqual(
      [...names].sort(),
    );
    const sha256 = createHash("sha256").update(source).digest("hex");
    for (const observation of graphql) {
      expect(observation.properties.mechanism).toBe("graphql:query");
      expect(observation.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        confidence: "exact",
        artifact: { available: true, sha256 },
        location: {
          available: true,
          value: {
            kind: "source-range",
            source: "app.mjs",
            start: { line: expect.any(Number), column: expect.any(Number) },
            end: { line: expect.any(Number), column: expect.any(Number) },
          },
        },
      });
      const location = observation.evidence.location;
      if (!location.available || location.value.kind !== "source-range")
        throw new Error("Expected the operation's source range");
      const name = String(observation.properties.value);
      expect(location.value.start.line).toBe(names.indexOf(name) + 2);
      expect(location.value.end.line).toBe(location.value.start.line);
      const selected = source
        .split("\n")
        [location.value.start.line - 1]!.slice(
          location.value.start.column,
          location.value.end.column,
        );
      expect(selected).toContain(name);
    }
    const unresolved = endpoints
      .flatMap(({ observations }) => observations)
      .find(({ properties }) => properties.value === "dynamicEndpoint");
    expect(unresolved).toMatchObject({
      properties: { mechanism: "call:fetch", resolution: "partial" },
      evidence: {
        limitations: expect.arrayContaining([
          expect.stringContaining("unresolved source expression"),
        ]),
      },
    });
    const calls = result.graph.edges.filter(
      ({ relation }) => relation === "calls",
    );
    expect(calls).toHaveLength(names.length + 1);
    expect(calls.every(({ evidence }) => evidence.state === "inferred")).toBe(
      true,
    );
  },
);
