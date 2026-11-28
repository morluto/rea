// The CI planning job runs before dependencies are installed, so it cannot
// load the parser that darwin-gated-tests.mjs uses to decide a gate exactly.
// This dependency-free test admits a superset of that decision, and the
// exact discovery parses only the modules it admits, so the two cannot
// disagree about a gated module. A gate can tell macOS from Linux only by
// comparing process.platform with a "darwin" or "linux" literal. It is a
// skipIf/runIf call, or a case list chosen by a conditional on that literal.
// The test may admit modules that are not gated.

const PLATFORM_LITERAL = /["'`](?:darwin|linux)["'`]/u;
const GATE_SHAPE =
  /\.(?:skipIf|runIf)\s*\(|["'`](?:darwin|linux)["'`]\s*\)?\s*\?\s*\(?\s*\[/u;

/** Whether a test module's text could gate a test to macOS. */
export const mayGateTestToDarwin = (source) =>
  PLATFORM_LITERAL.test(source) && GATE_SHAPE.test(source);
