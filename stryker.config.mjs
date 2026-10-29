import { mutationRanges } from "./scripts/lib/reverse-tools-mutation-targets.mjs";

const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "vitest",
  plugins: [
    "@stryker-mutator/typescript-checker",
    "@stryker-mutator/vitest-runner",
  ],
  vitest: {
    configFile: "vitest.reverse-tools.config.ts",
    related: true,
  },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.reverse-tools-mutation.json",
  typescriptChecker: {
    prioritizePerformanceOverAccuracy: true,
  },
  coverageAnalysis: "perTest",
  thresholds: { break: null },
  ignorePatterns: ["/.cache/rea-command-locks/**", "/coverage/**"],
  concurrency: 2,
  timeoutMS: 30000,
  reporters: ["clear-text", "progress", "html", "json"],
  jsonReporter: { fileName: "reports/mutation/reverse-tools.json" },
  htmlReporter: { fileName: "reports/mutation/reverse-tools.html" },
};

export default {
  ...config,
  mutate: [
    ...mutationRanges("src/application/reverse/ReverseEngineeringService.ts", [
      {
        kind: "method",
        owner: "ReverseEngineeringService",
        name: "inspectWithObjdump",
      },
      {
        kind: "method",
        owner: "ReverseEngineeringService",
        name: "executeRizinCommand",
      },
      {
        kind: "method",
        owner: "ReverseEngineeringService",
        name: "#observe",
      },
      {
        kind: "method",
        owner: "ReverseEngineeringService",
        name: "retryCleanup",
      },
      {
        kind: "guard",
        owner: "ReverseEngineeringService",
        method: "#observeProvider",
        condition: "signal?.aborted",
        direct: true,
      },
      {
        kind: "guard",
        owner: "ReverseEngineeringService",
        method: "#observeProvider",
        condition: "!cleanup.ok",
      },
      {
        kind: "declaration",
        owner: "ReverseEngineeringService",
        method: "#observeProvider",
        name: "absolutePath",
      },
      {
        kind: "declaration",
        owner: "ReverseEngineeringService",
        method: "#observeProvider",
        name: "cleanup",
      },
      {
        kind: "try",
        owner: "ReverseEngineeringService",
        method: "#observeProvider",
        assignment: "digest",
      },
      {
        kind: "try",
        owner: "ReverseEngineeringService",
        method: "#observeProvider",
        callee: "this.#run",
      },
      {
        kind: "expression",
        text: "snapshot.signal !== null && snapshot.signal !== undefined",
      },
    ]),
    ...mutationRanges("src/process/ExecFileOutput.ts", [
      {
        kind: "declaration",
        name: "execFileOutputFailure",
      },
    ]),
    ...mutationRanges("src/server/providerEnvironment.ts", [
      {
        kind: "declaration",
        name: "captureProviderEnvironment",
      },
    ]),
    ...mutationRanges("src/server/registerReverseEngineeringTools.ts", [
      {
        kind: "declaration",
        name: "registerReverseEngineeringTools",
      },
    ]),
    ...mutationRanges("src/gdb/GdbSessionManager.ts", [
      {
        kind: "constructor",
        owner: "GdbCommandTimeoutError",
      },
      {
        kind: "constructor",
        owner: "GdbCommandProcessExitError",
      },
      {
        kind: "constructor",
        owner: "GdbSessionManager",
      },
      {
        kind: "declaration",
        name: "DEFAULT_MAX_SESSIONS",
      },
      {
        kind: "declaration",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        name: "session",
      },
      {
        kind: "declaration",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        name: "stdoutSettled",
      },
      {
        kind: "call",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        callee: "launched.process.stdout?.on",
        event: "data",
      },
      {
        kind: "call",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        callee: "launched.process.stdin?.on",
        event: "error",
      },
      {
        kind: "call",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        callee: "launched.process.stdin?.once",
        event: "close",
      },
      {
        kind: "call",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        callee: "launched.process.once",
        event: "exit",
      },
      {
        kind: "guard",
        owner: "GdbSessionManager",
        method: "#startProtocol",
        condition: "launched.process.stdout === null",
      },
      {
        kind: "method",
        owner: "GdbSessionManager",
        name: "close",
      },
    ]),
    ...mutationRanges("src/process/ownedDebuggerSession.ts", [
      {
        kind: "declaration",
        name: "waitForInferiorDetach",
      },
    ]),
    ...mutationRanges("src/rizin/RizinDebugSessionManager.ts", [
      {
        kind: "guard",
        owner: "RizinDebugSessionManager",
        method: "execute",
        condition: "captured.outputTruncated",
      },
      {
        kind: "declaration",
        owner: "RizinDebugSessionManager",
        method: "execute",
        name: "result",
        withinBlockWithBinding: "captured",
      },
      {
        kind: "declaration",
        owner: "RizinDebugSessionManager",
        method: "execute",
        name: "evidence",
        withinBlockWithBinding: "captured",
      },
      {
        kind: "declaration",
        owner: "RizinDebugSessionManager",
        method: "#receive",
        name: "nextOffset",
      },
    ]),
    ...mutationRanges("src/cli/reverseEngineeringCommands.ts", [
      {
        kind: "command-handler",
        command: "debugWithGdb",
      },
      {
        kind: "command-handler",
        command: "debugWithRizin",
      },
    ]),
    ...mutationRanges("src/cutter/CutterBridgeClient.ts", [
      {
        kind: "expression",
        text: "status.data.current_file === undefined",
      },
      {
        kind: "expression",
        text: "response.current_file === undefined",
      },
    ]),
  ],
};
