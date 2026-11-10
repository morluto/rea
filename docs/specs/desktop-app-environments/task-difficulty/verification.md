# Verification

## Tests

- `src/domain/desktop/taskDifficulty.test.ts`: the band for 0 and 3 of 3,
  1 and 2 of 3, 1, 3 and 4 of 5 and an unfinished solve beside finished ones;
  3 solves, 2 more, then a stop; an unfinished solve run again at most twice;
  the stop before a solve the largest cost so far would take past the budget,
  and after one of unknown cost; the record's counts, cost, turns and
  failures per check; and the README section replaced in place.
- `tests/boundary/mcp/buildMeasureMcp.test.ts` calls `measure_build_task`
  through the MCP with a stand-in agentenv whose `run_bundle` answers solves
  in order: 1 of 3 then 2 more keeps the task at 2 of 5, each solve run once
  in the bundle with the model, `claude-code`, `sandbox="local"`,
  `emulate=False` and the endpoint REA started with, and `difficulty.json`
  and the README record it with the task's digest; 3 of 3 stops as too easy
  after running an unfinished solve again; the budget stops before a third
  solve; a task the bundle lacks is refused before any solve. All of them
  failed before the change: the module and the tool did not exist. After
  review, the unfinished solve's error, `RuntimeError: deploy`, is kept in
  the result and `difficulty.json`; that test failed first, since the record
  dropped every solve's error.

## TreeLine, arm64

On the arm64 Ubuntu 24.04 build host with agentenv-framework 0.9.1431, REA's
MCP server started with `LITELLM_BASE_URL` and `LITELLM_API_KEY`, each task
measured with `anthropic/claude-sonnet-5-5`:

| Bundle   | Task                  | Budget | Solves | Passes | Band                   | Turns       | Cost  |
| -------- | --------------------- | ------ | ------ | ------ | ---------------------- | ----------- | ----- |
| `d-tl3`  | `rename-category`     | $2.50  | 2      | 2      | undecided, budget stop | 16, 20      | $2.02 |
| `d-tl3`  | `set-foundation-year` | $2.50  | 3      | 3      | too easy               | 17, 18, 22  | $1.89 |
| `d-tl3`  | `add-asimov-book`     | $2.50  | 3      | 3      | too easy               | 17, 17, 17  | $1.64 |
| `d-hard` | `apply-corrections`   | $9     | 3      | 3      | too easy               | 106, 61, 74 | $5.14 |

`rename-category` stopped before a third solve because the largest cost so
far, $1.06, would have taken $2.02 past $2.50. `apply-corrections` hardens
the 15-book reading list with a second document the solver opens in TreeLine,
`Documents/corrections.trln`, listing ten corrections to apply: eight years
and two authors across all three categories, one of them "the same year as
The Quiet Glacier's", with guards on three books left alone. Checked offline
against the app's own views, it fails on the seed, passes when applied, and
fails each near miss: a correction left out, an author without its hyphen,
the cross-reference given another book's new year, and an untouched book
changed. Every solve opened the corrections in a second window and applied
all ten; one typed a year into the tree, saw the stray node and undid it.

No task landed in the band: the four measures cost $10.69 of the $15 the
validation allowed, and the $4.31 left could not cover 3 solves of another
hardened task at the $1.50 to $2.07 a solve `apply-corrections` cost. Each
solve's computer was torn down by its run. `difficulty.json` and the README
of each bundle list the tasks measured.

## Forced-stop cleanup qualification, 2026-11-10

The original missing-identity review concern is addressed by the private root
owned by each `SolveSandboxRoot` and the provider guarantees shipped in the
pinned `agentenv-framework==0.9.1485`.
[Upstream #555](https://github.com/scaleapi/agentenv-framework/pull/555) exposes
`local_sandbox_ids()` for that root;
[#561](https://github.com/scaleapi/agentenv-framework/pull/561) makes incomplete
termination raise, so the teardown owner retains the work folder for retry.
[Issue #546](https://github.com/scaleapi/agentenv-framework/issues/546) is closed.
The published wheel was inspected, including folder creation before resource
startup, provider termination, and task teardown's folder-removal ordering.

The [qualification record](https://github.com/morluto/rea/blob/main/docs/specs/desktop-app-environments/task-difficulty/cleanup-qualification-2026-11-10.json) records the
wheel digest and observations. In an isolated Linux arm64 container with the
published provider, Python 3.12 and Docker Desktop's Linux daemon:

- A helper created a provider-owned folder and was killed with SIGKILL before
  returning any sandbox report. REA's cleanup helper discovered and removed it.
- Another helper started a real named/labeled Docker container, labeled network,
  and detached Linux process carrying the sandbox marker. After its process
  group was killed, REA's cleanup helper removed all three and emptied the root.
- A controlled Docker removal refusal made cleanup fail while preserving the
  work folder and container. Removing the refusal and retrying that same root
  removed the resources and folder.
- A separate unrelated container stayed running through every case and was
  removed by the qualification's own final cleanup.

The probe invoked the production `solve_cleanup.py` and actual published
`LocalSandbox`/`LocalSandboxProvider` with real Docker resources. It did not run
a paid model or a complete `run_bundle` solve. Linux process checks were inside
the qualification container's process namespace; this does not qualify native
macOS host-process cleanup. Existing conservative REA checks remain in place.
Controlled TypeScript cleanup/report/cancellation regressions also passed:
22 tests across `AgentEnvSolveHelper`, `SolveSandboxRoot`, and
`DesktopBuildSolves`.
