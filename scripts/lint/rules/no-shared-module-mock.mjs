import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { isVitestExport, propertyName, unwrap } from "../bindings.mjs";
import { projectForTest } from "../../lib/test-projects.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const mockMethods = new Set(["mock", "doMock"]);

const isModuleMockCall = (sourceCode, callee) => {
  const method = unwrap(callee);
  return (
    method?.type === "MemberExpression" &&
    mockMethods.has(propertyName(method)) &&
    isVitestExport(sourceCode, method.object, "vi")
  );
};

const isolationForFile = (filename, cwd) => {
  if (typeof filename !== "string" || !filename.endsWith(".test.ts"))
    return undefined;
  const testPath = relative(cwd, filename).split("\\").join("/");
  if (
    testPath === "" ||
    isAbsolute(testPath) ||
    testPath === ".." ||
    testPath.startsWith("../")
  )
    return undefined;
  try {
    return projectForTest(testPath).isolate !== false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("No test project owns ")
    )
      return undefined;
    throw error;
  }
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Vitest module mocks in projects with per-file module isolation.",
    },
    schema: [],
    messages: {
      shared:
        "Vitest module mocks need an isolated test project; move the test to an isolated project or replace the module mock with a scoped spy or injected dependency.",
    },
  },
  create(context) {
    const filename = context.physicalFilename ?? context.filename;
    const sourceCode = context.sourceCode;
    const cwd =
      context.cwd ?? context.getCwd?.() ?? sourceCode.getCwd?.() ?? repository;
    if (isolationForFile(filename, cwd) !== false) return {};
    return {
      CallExpression(node) {
        if (isModuleMockCall(sourceCode, node.callee))
          context.report({ node, messageId: "shared" });
      },
    };
  },
};
