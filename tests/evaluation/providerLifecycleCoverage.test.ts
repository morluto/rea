import { readFile } from "node:fs/promises";
import ts from "typescript6";
import { expect, it } from "vitest";
import { CAPABILITY_DECLARATIONS } from "../../src/composition/capabilityDeclarations.js";
import {
  LIFECYCLE_STAGES,
  PROVIDER_LIFECYCLE_COVERAGE,
} from "../support/providerLifecycleCoverage.js";

const repositoryRoot = new URL("../../", import.meta.url);

const registeredProviderIds = () =>
  [
    ...new Set(
      Object.values(CAPABILITY_DECLARATIONS).flatMap((declaration) =>
        declaration.providers.map((provider) => provider.identity.id),
      ),
    ),
  ].sort();

const tableGaps = () =>
  Object.entries(PROVIDER_LIFECYCLE_COVERAGE).flatMap(([id, entry]) =>
    LIFECYCLE_STAGES.filter((stage) => entry.stages[stage].kind === "gap").map(
      (stage) => `${id}:${stage}`,
    ),
  );

const fixtureRegistrars = new Map([
  ["cliFixture.js", "cliTest"],
  ["fileInspection.js", "fileInspectionTest"],
  ["mcpFixture.js", "mcpTest"],
  ["workspaceCliFixture.js", "workspaceCliTest"],
]);
const registrationModifiers = new Set([
  "concurrent",
  "each",
  "fails",
  "for",
  "runIf",
  "sequential",
  "skipIf",
]);

const testTitles = (path: string, source: string): ReadonlySet<string> => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const registrars = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const module = statement.moduleSpecifier.text;
    for (const binding of bindings.elements) {
      const imported = (binding.propertyName ?? binding.name).text;
      const fixture = fixtureRegistrars.get(module.split("/").at(-1) ?? "");
      if (
        (module === "vitest" && (imported === "it" || imported === "test")) ||
        (module.startsWith(".") && imported === fixture)
      )
        registrars.add(binding.name.text);
    }
  }

  const isRegistrar = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) return registrars.has(expression.text);
    if (!ts.isCallExpression(expression)) return false;
    const modifier = expression.expression;
    return (
      ts.isPropertyAccessExpression(modifier) &&
      registrationModifiers.has(modifier.name.text) &&
      isRegistrar(modifier.expression)
    );
  };

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const binding of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(binding.name) &&
        binding.initializer !== undefined &&
        isRegistrar(binding.initializer)
      )
        registrars.add(binding.name.text);
    }
  }

  const titles = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRegistrar(node.expression)) {
      const [title, callback] = node.arguments;
      if (
        title !== undefined &&
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        if (ts.isStringLiteralLike(title)) titles.add(title.text);
        if (ts.isTemplateExpression(title))
          titles.add(title.getText(file).slice(1, -1));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return titles;
};

it("counts test registrations instead of quoted source text", () => {
  const source = [
    'import { describe, it as test } from "vitest";',
    'import { workspaceCliTest as cli } from "../support/cli/workspaceCliFixture.js";',
    '// test("removed", () => {});',
    'const data = "another removed test";',
    'describe("suite title", () => {});',
    'log("diagnostic", () => {});',
    'const posix = test.skipIf(process.platform === "win32");',
    'posix("conditional", () => {});',
    'test.each([1, 2])("table %d", () => {});',
    'test("with a snapshot", () => expect(value).toMatchInlineSnapshot("snapshot"));',
    "cli(`inspect ${format}`, async () => {});",
  ].join("\n");
  expect([...testTitles("fixture.test.ts", source)]).toEqual([
    "conditional",
    "table %d",
    "with a snapshot",
    "inspect ${format}",
  ]);
});

it("has exactly one entry per registered provider id", () => {
  expect(Object.keys(PROVIDER_LIFECYCLE_COVERAGE).sort()).toEqual(
    registeredProviderIds(),
  );
});

it("names a test registration for every covered stage", async () => {
  const missing: string[] = [];
  const registrations = new Map<
    string,
    Promise<ReadonlySet<string> | undefined>
  >();
  const titlesFor = (path: string) => {
    let pending = registrations.get(path);
    if (pending === undefined) {
      pending = readFile(new URL(path, repositoryRoot), "utf8").then(
        (text) => testTitles(path, text),
        (cause: unknown) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw cause;
        },
      );
      registrations.set(path, pending);
    }
    return pending;
  };
  for (const [id, entry] of Object.entries(PROVIDER_LIFECYCLE_COVERAGE)) {
    for (const stage of LIFECYCLE_STAGES) {
      const coverage = entry.stages[stage];
      if (coverage.kind !== "covered") continue;
      for (const { path, title } of coverage.tests) {
        const titles = await titlesFor(path);
        if (!path.endsWith(".test.ts") || titles === undefined) {
          missing.push(`${id}:${stage} missing file ${path}`);
          continue;
        }
        if (!titles.has(title))
          missing.push(`${id}:${stage} missing title in ${path}: ${title}`);
      }
    }
  }
  expect(missing).toEqual([]);
});

it("has no uncovered applicable lifecycle stages", () => {
  expect(tableGaps()).toEqual([]);
});
