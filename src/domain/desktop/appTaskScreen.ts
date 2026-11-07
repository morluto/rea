import type { DesktopTask, DesktopTaskCheck } from "./appTask.js";
import type { TaskCheckOutcome, TaskFileView } from "./appTaskChecks.js";

/** The model a bundle's screen judge asks when the runner's config names none for judges or by default. */
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-5-5";
/** How long the display is left to draw the agent's last action before the judge's screenshot. */
export const SCREEN_SETTLE_MS = 1000;
/** The largest checkpoint screenshot the export ships as a judge's example. */
export const SCREEN_EXAMPLE_MAX_BYTES = 2 * 1024 * 1024;
/** The most bytes of a bundle's verifier the witness reads: the judge's code and both examples, base64. */
export const VERIFIER_MAX_BYTES =
  1024 * 1024 + 2 * Math.ceil((SCREEN_EXAMPLE_MAX_BYTES * 4) / 3);
/** How many times the judge is asked each question; the check passes on most of them saying yes. */
export const SCREEN_JUDGE_VOTES = 3;

/** A screen judge check: a yes-or-no question about the app's screen. */
export type ScreenJudgeCheck = Extract<
  DesktopTaskCheck,
  { kind: "screen_judge" }
>;

/** The build's screenshots a screen-judged verifier ships, base64 JPEG: the seed's, where the answer is no, and the end's, where it is yes. */
export interface ScreenExamples {
  readonly fail: string;
  readonly pass: string;
}

/** Runs a bundle's own judge on one screenshot file, as the witness does, and gives the check's outcome. */
export type ScreenJudge = (
  verifier: string,
  check: ScreenJudgeCheck,
  image: string,
  signal: AbortSignal,
) => Promise<TaskCheckOutcome>;

/** Whether a task's checks are screen judges, which the parser lets stand only alone. */
export const isScreenTask = (task: DesktopTask): boolean =>
  task.checks.some(({ kind }) => kind === "screen_judge");

const readable = (view: TaskFileView | undefined): boolean =>
  view === undefined ||
  (view.format !== null &&
    view.format !== "binary" &&
    typeof view.error !== "string");

/** The files whose change between two sets of views a check could read: readable or absent at both ends, and not the same. */
export const readableChanges = (
  seed: ReadonlyMap<string, TaskFileView>,
  end: ReadonlyMap<string, TaskFileView>,
): string[] =>
  [...new Set([...seed.keys(), ...end.keys()])]
    .filter((file) => {
      const [before, after] = [seed.get(file), end.get(file)];
      return (
        readable(before) &&
        readable(after) &&
        JSON.stringify(before?.view ?? null) !==
          JSON.stringify(after?.view ?? null)
      );
    })
    .sort();

const EXAMPLES_LINE = /^EXAMPLES = (\{.*\})$/mu;

/** The examples a screen-judged verifier holds, or undefined when it holds none. */
export const screenExamplesOf = (
  verifier: string,
): ScreenExamples | undefined => {
  const line = EXAMPLES_LINE.exec(verifier)?.[1];
  if (line === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "fail" in parsed &&
      "pass" in parsed &&
      typeof parsed.fail === "string" &&
      typeof parsed.pass === "string"
    )
      return { fail: parsed.fail, pass: parsed.pass };
  } catch {
    // A line that is no JSON names no examples.
  }
  return undefined;
};

/** The judge's code: a screenshot through the computer's MCP tools, then votes through litellm on agentenv's model config. */
const PYTHON_SCREEN_JUDGE = String.raw`
#: Calls a vote makes before the judge counts as not answering.
ATTEMPTS = 3
VERDICT = {"type": "object", "additionalProperties": False, "required": ["verdict", "reason"],
           "properties": {"verdict": {"type": "boolean"}, "reason": {"type": "string"}}}
INSTRUCTIONS = ("You check a desktop app's screen against one yes-or-no question. Answer from the screenshot alone: when "
                "it does not show the answer, the verdict is false. Two labelled screenshots of the same app come first.")


def _image(data: str) -> dict:
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + data}}


def _endpoint():
    """The judge's model and the call's settings; no endpoint raises, so the run fails rather than scoring."""
    config = get_config()
    model = config.get_model_for_role("judge") or DEFAULT_JUDGE_MODEL
    try:
        config.get_litellm_base_url()
        settings = config.resolve_model_call(model).client_kwargs()
    except Exception as error:
        raise RuntimeError(f"the screen judge has no model endpoint: {error}") from error
    return model, settings


async def _vote(model: str, settings: dict, question: str, screenshot: str):
    content = [{"type": "text", "text": INSTRUCTIONS},
               {"type": "text", "text": f"The app before the task; for the question {json.dumps(question)} the verdict is false:"},
               _image(EXAMPLES["fail"]),
               {"type": "text", "text": "The app with the task done; the verdict is true:"},
               _image(EXAMPLES["pass"]),
               {"type": "text", "text": f"Question: {question}\nThe screenshot to judge:"},
               _image(screenshot)]
    failure = None
    for _ in range(ATTEMPTS):
        try:
            response = await litellm.acompletion(
                model=model, messages=[{"role": "user", "content": content}],
                response_format={"type": "json_schema", "json_schema": {"name": "screen_judge", "schema": VERDICT,
                                                                        "strict": True}}, **settings)
            answer = json.loads(response.choices[0].message.content or "")
            if isinstance(answer, dict) and isinstance(answer.get("verdict"), bool):
                return answer["verdict"], str(answer.get("reason", ""))
            failure = ValueError(f"the judge answered {answer!r}")
        except Exception as error:
            failure = error
    raise RuntimeError(f"the screen judge did not answer: {failure}")


async def judge_screen(check, screenshot: str) -> dict:
    """One check's result on a screenshot, base64 JPEG: it passes when most of VOTES votes say yes."""
    model, settings = _endpoint()
    votes = [await _vote(model, settings, check["question"], screenshot) for _ in range(VOTES)]
    yes = sum(1 for verdict, _ in votes if verdict)
    passed = 2 * yes > VOTES
    reason = next(reason for verdict, reason in votes if verdict == passed)
    said = yes if passed else VOTES - yes
    return {"id": check["id"], "result": passed,
            "description": f"the judge ({model}) said {'yes' if passed else 'no'} in {said} of {VOTES} votes: {reason}"}


async def _screenshot(mcp_url: str) -> str:
    async with ToolSession(mcp_url=mcp_url) as session:
        shot = await session.call_tool("computer_screenshot", {"format": "jpeg", "quality": 70})
    images = [block for block in shot.content if block.get("type") == "image"]
    if shot.isError or not images:
        raise RuntimeError("the computer took no screenshot for the screen judge")
    return images[0]["data"]


async def verify(mcp_url, env_url):
    await asyncio.sleep(SCREEN_SETTLE_S)
    screenshot = await _screenshot(mcp_url)
    return [await judge_screen(check, screenshot) for check in CHECKS]


if __name__ == "__main__":
    # REA's witness runs the judge on a screenshot it took: judge <check as JSON> <JPEG file>.
    with open(sys.argv[3], "rb") as handle:
        shot = base64.b64encode(handle.read()).decode()
    print(json.dumps(asyncio.run(judge_screen(json.loads(sys.argv[2]), shot))))
`;

/** The verifier artifact of a screen-judged task: the judge, its two examples from the build, and the checks' questions. */
export const renderScreenVerifier = (
  task: DesktopTask,
  app: string,
  examples: ScreenExamples,
): string =>
  `"""Checks of the task ${task.name} against the ${app} app's screen, exported by REA from a desktop application capture.

It takes a screenshot of the computer's display through its MCP tools and asks a model, the judge, each check's
yes-or-no question about it VOTES times, after two labelled examples from the build: the screen at the seed, where the
answer is no, and at the end, where it is yes. A check passes when most votes say yes. The judge's model is the runner
config's [model.roles] judge, else its [model] default, else DEFAULT_JUDGE_MODEL, called through LITELLM_BASE_URL and
LITELLM_API_KEY or [model] base_url and api_key; agent-env run's --judge-model does not reach it. Without an endpoint it
raises, so the run fails rather than scoring the agent.
"""
import asyncio
import base64
import json
import sys

import litellm
from agent_env.config import get_config
from agentenv_protocol.tool_client import ToolSession

APP = ${JSON.stringify(app)}
CHECKS = [
${task.checks.map((check) => `    ${JSON.stringify(check)},`).join("\n")}
]
VOTES = ${String(SCREEN_JUDGE_VOTES)}
#: Seconds the display is left to draw the agent's last action before the screenshot.
SCREEN_SETTLE_S = ${(SCREEN_SETTLE_MS / 1000).toFixed(1)}
DEFAULT_JUDGE_MODEL = ${JSON.stringify(DEFAULT_JUDGE_MODEL)}
#: The build's screenshots, base64 JPEG: the seed's, where the answer is no, and the end's, where it is yes.
EXAMPLES = ${JSON.stringify({ fail: examples.fail, pass: examples.pass })}
${PYTHON_SCREEN_JUDGE}`;
