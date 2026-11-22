/** Bridge files shared by the runtime and the package verifier. */
export const AGENTENV_BRIDGE_SOURCES = Object.freeze({
  capture: new URL("../../bridge/agentenv/capture.py", import.meta.url).href,
  computer: new URL("../../bridge/agentenv/computer.py", import.meta.url).href,
  solve: new URL("../../bridge/agentenv/solve.py", import.meta.url).href,
  solveCleanup: new URL(
    "../../bridge/agentenv/solve_cleanup.py",
    import.meta.url,
  ).href,
} as const);
