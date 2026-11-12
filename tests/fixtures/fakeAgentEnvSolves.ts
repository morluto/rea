import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "./temporaryDirectory.js";

/**
 * A stand-in `agent_env.bundle.run_bundle` for solves: each call takes the
 * next of `FAKE_SOLVES`, a JSON list of `{outcome, checks, turns, usd}`,
 * writes the solver's trajectory as Claude Code's last record holds turns and
 * cost, and returns a run shaped like agentenv's, its checks under the
 * instance's verifications. Each call notes its arguments and whether a
 * model endpoint reached it; `FAKE_SOLVE_RAISES` makes it raise instead, and
 * `FAKE_SOLVE_HANGS` makes it ignore SIGTERM and never return.
 */
const FAKE_SOLVE_MODULE = String.raw`
import enum
import json
import os
import signal
import time
import types

STATE = os.environ["FAKE_STATE"]


class Outcome(enum.Enum):
    PASSED = "passed"
    BELOW_ONE = "scored below 1"
    FAILED = "failed"


def _note(name, value):
    with open(os.path.join(STATE, name), "a") as handle:
        handle.write(json.dumps(value) + "\n")


def run_bundle(root, *, tasks=(), model=None, agent=None, sandbox=None, emulate=True, on_progress=None):
    counter = os.path.join(STATE, "count")
    n = int(open(counter).read()) if os.path.exists(counter) else 0
    open(counter, "w").write(str(n + 1))
    _note("solves.jsonl", {"root": str(root), "tasks": list(tasks), "model": model, "agent": agent,
                           "sandbox": sandbox, "emulate": emulate,
                           "endpoint": os.environ.get("LITELLM_BASE_URL")})
    if os.environ.get("FAKE_SOLVE_RAISES"):
        raise RuntimeError(os.environ["FAKE_SOLVE_RAISES"])
    if os.environ.get("FAKE_SOLVE_ROOT_ENTRY"):
        os.mkdir(os.path.join(os.environ["AGENT_ENV_LOCAL_SANDBOX_DIR"], os.environ["FAKE_SOLVE_ROOT_ENTRY"]))
    if os.environ.get("FAKE_SOLVE_HANGS"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(3600)
    on_progress("deploying the computer")
    planned = json.loads(os.environ["FAKE_SOLVES"])[n]
    trajectory = os.path.join(STATE, f"trajectory-{n}.json")
    with open(trajectory, "w") as handle:
        json.dump([{"type": "system"}, {"type": "result", "num_turns": planned["turns"],
                                        "total_cost_usd": planned["usd"]}], handle)
    results = [{"id": check, "result": passed, "description": f"{check} read", "settled": True}
               for check, passed in planned["checks"].items()]
    # An empty results list is unscored evidence. A planned pass or miss still
    # has to record one selected-verifier result so cleanup can retain that outcome.
    if not results and planned["outcome"] in ("passed", "scored below 1"):
        results = [{"id": "selected", "result": planned["outcome"] == "passed",
                    "description": "selected verifier", "settled": True}]
    context = types.SimpleNamespace(
        instance_id=f"inst-{n}",
        metadata={"verifications": {tasks[0]: {"score": 1.0 if planned["outcome"] == "passed" else 0.0,
                                                 "results": results}}},
        prompt_responses=[types.SimpleNamespace(agent_trajectory_object_url="file://" + trajectory)],
    )
    still_up = [types.SimpleNamespace(sandbox_id=id, sandbox_type="local")
                for id in json.loads(os.environ.get("FAKE_SOLVE_STILL_UP", "[]"))]
    run = types.SimpleNamespace(outcome=Outcome(planned["outcome"]), context=context, instance_id=f"inst-{n}",
                                duration=42.0, error=None if planned["outcome"] != "failed" else RuntimeError("deploy"),
                                torn_down=types.SimpleNamespace(still_up=still_up))
    return types.SimpleNamespace(runs=(run,))
`;

export interface FakeAgentEnvSolves {
  readonly environment: Readonly<Record<string, string>>;
  notes(name: string): Promise<unknown[]>;
}

/** A runner whose agentenv answers solves from `solves`, in order. */
export const fakeAgentEnvSolves = async (
  solves: readonly {
    readonly outcome: "passed" | "scored below 1" | "failed";
    readonly checks: Readonly<Record<string, boolean>>;
    readonly turns: number;
    readonly usd: number;
  }[],
): Promise<FakeAgentEnvSolves> => {
  const state = await createTestTempDirectory("fake-agentenv-solves-");
  const python = execFileSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  ).trim();
  await mkdir(join(state, "site", "agent_env"), { recursive: true });
  const runner = join(state, "agent-env");
  await writeFile(runner, `#!${python}\n# Stand-in runner.\n`);
  await chmod(runner, 0o755);
  await writeFile(join(state, "site", "agent_env", "__init__.py"), "");
  await writeFile(
    join(state, "site", "agent_env", "bundle.py"),
    FAKE_SOLVE_MODULE,
  );
  return {
    environment: {
      REA_AGENT_ENV_COMMAND: runner,
      PYTHONPATH: join(state, "site"),
      FAKE_STATE: state,
      FAKE_SOLVES: JSON.stringify(solves),
    },
    notes: async (name) => {
      const path = join(state, name);
      try {
        await access(path);
      } catch {
        return [];
      }
      return (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
    },
  };
};
