// Graceful CLI/MCP shutdown cancels work through its owners. Retained process
// and file leases keep a referenced retry alive until verified release.
export function entrypointLifetime() {
  const controller = new AbortController();
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      process.exitCode = code;
      controller.abort(new Error(`Experiment received ${signal}`));
    });
  }
  return controller;
}
