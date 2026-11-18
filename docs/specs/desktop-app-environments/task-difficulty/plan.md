# Plan

1. Domain: `taskDifficulty.ts` holds the band, the next-solve decision under
   the budget, the record and its README section.
2. Helper: `bridge/agentenv/solve.py` runs one solve with `run_bundle` and
   reports it; `AgentEnvSolveHelper.ts` spawns it as an owned process with the
   runner's Python and reads its report.
3. Application: `DesktopBuildSolves.ts` measures a task and writes
   `difficulty.json` and the README; `DesktopBuildOwnedWork.ts` holds the work
   closing REA stops, now shared by a computer's start and a measure.
4. MCP: the contract, its effects, registration with heartbeat progress, and
   the CLI-parity list.
5. Docs: the building guide's Measure and Harder tasks sections, the witness,
   tasks and build computer guides, and this spec.
6. Tests first: the band and budget rules, and the tool through the MCP with
   a stand-in agentenv; then TreeLine tasks on the arm64 VM.
