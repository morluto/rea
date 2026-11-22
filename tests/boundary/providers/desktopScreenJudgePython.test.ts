import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { renderTaskVerifier } from "../../../src/domain/desktop/appTaskPython.js";
import { DEFAULT_JUDGE_MODEL } from "../../../src/domain/desktop/appTaskScreen.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const EXAMPLES = { fail: "c2VlZA==", pass: "ZW5k" };
const SCREENSHOT = "c2NyZWVu";
const CHECK = {
  id: "shown",
  kind: "screen_judge" as const,
  question: "Does the display show 8.568?",
};

/** Stand-ins for the runner's modules: the computer's MCP tools, litellm and agentenv's config, driven by a scenario file. */
const STUBS: Readonly<Record<string, string>> = {
  "agentenv_protocol/__init__.py": "",
  "agentenv_protocol/tool_client.py": String.raw`
import json, os, types
class ToolSession:
    def __init__(self, *, mcp_url, **_):
        self.mcp_url = mcp_url
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_):
        return None
    async def call_tool(self, name, arguments=None):
        scenario = json.load(open(os.environ["SCENARIO"]))
        with open(os.environ["CALLS"], "a") as log:
            log.write(json.dumps({"tool": name, "arguments": arguments, "url": self.mcp_url}) + "\n")
        return types.SimpleNamespace(isError=False, content=[{"type": "image", "mimeType": "image/jpeg", "data": scenario["image"]}])
`,
  "litellm/__init__.py": String.raw`
import json, os, types
async def acompletion(model, messages, response_format=None, **settings):
    scenario = json.load(open(os.environ["SCENARIO"]))
    with open(os.environ["CALLS"]) as log:
        made = sum(1 for line in log if '"model"' in line)
    content = messages[0]["content"]
    with open(os.environ["CALLS"], "a") as log:
        log.write(json.dumps({"model": model, "settings": settings, "format": response_format["type"],
                              "images": [part["image_url"]["url"] for part in content if part["type"] == "image_url"],
                              "texts": [part["text"] for part in content if part["type"] == "text"]}) + "\n")
    answer = scenario["answers"][made]
    if answer == "raise":
        raise ConnectionError("the endpoint dropped the call")
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=json.dumps(answer)))])
`,
  "agent_env/__init__.py": "",
  "agent_env/config/__init__.py": String.raw`
import json, os, types
def get_config():
    scenario = json.load(open(os.environ["SCENARIO"]))
    def base_url():
        if scenario.get("no_endpoint"):
            raise RuntimeError("No model endpoint configured: set [model] base_url or LITELLM_BASE_URL.")
        return "https://models.example"
    call = types.SimpleNamespace(client_kwargs=lambda: {"api_key": "sk-test", "api_base": "https://models.example"})
    return types.SimpleNamespace(get_model_for_role=lambda role: scenario.get("roles", {}).get(role),
                                 get_litellm_base_url=base_url, resolve_model_call=lambda model: call)
`,
};

const DRIVER = String.raw`
import asyncio, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("verifier", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SCREEN_SETTLE_S = 0
print(json.dumps(asyncio.run(module.verify("http://computer:8080/mcp", "http://computer:8080"))))
`;

type Call = {
  tool?: string;
  model?: string;
  settings?: Record<string, string>;
  format?: string;
  images?: string[];
  texts?: string[];
};

/** A folder with the stubs, the scenario and the rendered verifier of a task with `checks`. */
const verifierFolder = async (
  scenario: Record<string, unknown>,
  checks: readonly (typeof CHECK)[] = [CHECK],
) => {
  const folder = await createTestTempDirectory("screen-judge-");
  for (const [path, source] of Object.entries(STUBS)) {
    await mkdir(join(folder, "site", path, ".."), { recursive: true });
    await writeFile(join(folder, "site", path), source);
  }
  await writeFile(
    join(folder, "scenario.json"),
    JSON.stringify({ image: SCREENSHOT, ...scenario }),
  );
  await writeFile(join(folder, "calls.jsonl"), "");
  const verifier = join(folder, "verify.py");
  await writeFile(
    verifier,
    renderTaskVerifier(
      {
        name: "tip-total",
        prompt: "In Calculator, work it out.",
        checks: [...checks],
      },
      "calculator",
      EXAMPLES,
    ),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    PYTHONPATH: join(folder, "site"),
    SCENARIO: join(folder, "scenario.json"),
    CALLS: join(folder, "calls.jsonl"),
  };
  const calls = async () =>
    (await readFile(join(folder, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Call);
  return { folder, verifier, env, calls };
};

const verify = async (scenario: Record<string, unknown>) => {
  const run = await verifierFolder(scenario);
  const { stdout } = await execute("python3", ["-c", DRIVER, run.verifier], {
    env: run.env,
  });
  return {
    results: JSON.parse(stdout) as {
      id: string;
      result: boolean;
      description: string;
    }[],
    calls: await run.calls(),
  };
};

const yes = { verdict: true, reason: "the display shows 8.568" };
const no = { verdict: false, reason: "the display shows 0" };

it("grades a check by the judge's majority of three votes on one fresh screenshot, shown the seed's and the end's examples", async () => {
  const { results, calls } = await verify({ answers: [yes, no, yes] });

  expect(results).toEqual([
    {
      id: "shown",
      result: true,
      description: expect.stringContaining("2 of 3 votes") as string,
    },
  ]);
  const [shot, ...votes] = calls;
  expect(shot).toMatchObject({
    tool: "computer_screenshot",
    url: "http://computer:8080/mcp",
  });
  expect(votes).toHaveLength(3);
  for (const vote of votes) {
    expect(vote).toMatchObject({
      model: DEFAULT_JUDGE_MODEL,
      settings: { api_key: "sk-test", api_base: "https://models.example" },
      format: "json_schema",
      images: [
        `data:image/jpeg;base64,${EXAMPLES.fail}`,
        `data:image/jpeg;base64,${EXAMPLES.pass}`,
        `data:image/jpeg;base64,${SCREENSHOT}`,
      ],
    });
    expect(vote.texts?.join(" ")).toContain(CHECK.question);
  }
});

it("fails a check most votes say no to, naming the votes and a reason", async () => {
  const { results } = await verify({ answers: [no, no, yes] });
  expect(results[0]).toMatchObject({ result: false });
  expect(results[0]?.description).toContain("2 of 3 votes");
  expect(results[0]?.description).toContain("the display shows 0");
});

it("asks the model [model.roles] judge names, before the bundle's default", async () => {
  const { calls } = await verify({
    answers: [yes, yes, yes],
    roles: { judge: "openai/judge-model" },
  });
  expect(
    calls.filter(({ model }) => model !== undefined).map(({ model }) => model),
  ).toEqual(["openai/judge-model", "openai/judge-model", "openai/judge-model"]);
});

it("asks a vote again when its call fails, and raises when it never answers", async () => {
  const retried = await verify({ answers: ["raise", yes, yes, yes] });
  expect(retried.results[0]?.result).toBe(true);
  await expect(
    verify({ answers: ["raise", "raise", "raise"] }),
  ).rejects.toThrow("the screen judge did not answer");
});

it("raises without a model endpoint, so the run fails rather than scoring the agent", async () => {
  await expect(
    verify({ answers: [yes, yes, yes], no_endpoint: true }),
  ).rejects.toThrow("the screen judge has no model endpoint");
});

it("judges a screenshot it is given when run as a script, as REA's witness runs it", async () => {
  const run = await verifierFolder({ answers: [yes, yes, no] });
  const image = join(run.folder, "shot.jpg");
  await writeFile(image, Buffer.from("screen"));
  const { stdout } = await execute(
    "python3",
    [run.verifier, "judge", JSON.stringify(CHECK), image],
    { env: run.env },
  );
  expect(JSON.parse(stdout)).toMatchObject({ id: "shown", result: true });
  const votes = (await run.calls()).filter(({ model }) => model !== undefined);
  expect(votes[0]?.images?.at(-1)).toBe(
    `data:image/jpeg;base64,${Buffer.from("screen").toString("base64")}`,
  );
});
