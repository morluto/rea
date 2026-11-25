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

// A module is demonstrably macOS-only when every top-level registration is
// gated by a direct platform comparison that certainly skips on Linux and
// does not certainly skip on macOS. Nested registrations sit inside a
// top-level registration's callback, so only column-zero registrations
// decide. Anything undecidable — an ungated registration, a computed gate,
// a fixture call that could register tests — is not demonstrable, and the
// portable selection keeps the module.
const DARWIN_SKIP_GATE =
  /^(?:describe|it|test)\.skipIf\(\s*\(?\s*(?:process\.platform\s*!==?\s*["'`]darwin["'`]|["'`]darwin["'`]\s*!==?\s*process\.platform|process\.platform\s*===?\s*["'`]linux["'`]|["'`]linux["'`]\s*===?\s*process\.platform)\s*\)?\s*\)\s*\(/u;
const DARWIN_RUN_GATE =
  /^(?:describe|it|test)\.runIf\(\s*\(?\s*(?:process\.platform\s*===?\s*["'`]darwin["'`]|["'`]darwin["'`]\s*===?\s*process\.platform|process\.platform\s*!==?\s*["'`]linux["'`]|["'`]linux["'`]\s*!==?\s*process\.platform)\s*\)?\s*\)\s*\(/u;
const REGISTRATION = /^(?:describe|it|test)(?:\.\w+)*\s*\(/u;
const TOP_LEVEL_CALL = /^([A-Za-z_$][\w$]*)(?:\.(\w+))?\s*\(/u;
const HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);

/** Whether every test a module registers certainly skips on Linux. */
export const isMacOsOnlyTestSource = (source) => {
  let gated = false;
  for (const line of source.split("\n")) {
    if (DARWIN_SKIP_GATE.test(line) || DARWIN_RUN_GATE.test(line)) {
      gated = true;
      continue;
    }
    if (REGISTRATION.test(line)) return false;
    const call = TOP_LEVEL_CALL.exec(line);
    if (call && call[1] !== "vi" && !HOOKS.has(call[1])) return false;
  }
  return gated;
};
