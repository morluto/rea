import { execFile } from "node:child_process";

import { z } from "zod";

import type { ScreenJudge } from "../domain/desktop/appTaskScreen.js";
import { agentEnvInterpreter } from "./AgentEnvComputerHelper.js";

/** How long one check's votes may take, every call retried. */
const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;
const answerSchema = z.object({
  id: z.string(),
  result: z.boolean(),
  description: z.string(),
});

/**
 * A screen judge that runs a bundle's own `verify.py` with the agentenv
 * runner's Python, as REA runs its helper, so the bundle's judge and the
 * runner's model config decide: REA calls no model itself.
 */
export const screenJudgeProcess =
  (environment: Readonly<NodeJS.ProcessEnv>): ScreenJudge =>
  async (verifier, check, image, signal) => {
    const python = await agentEnvInterpreter(environment, "check_build_task");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        python,
        [verifier, "judge", JSON.stringify(check), image],
        {
          encoding: "utf8",
          env: { ...environment, PYTHONDONTWRITEBYTECODE: "1" },
          timeout: JUDGE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          signal,
        },
        (error, out, stderr) => {
          if (error === null) resolve(out);
          else
            reject(
              new Error(
                `The bundle's screen judge failed: ${stderr.trim().split("\n").slice(-3).join(" ") || error.message}`,
                { cause: error },
              ),
            );
        },
      );
    });
    const answer = answerSchema.parse(
      JSON.parse(stdout.trim().split("\n").at(-1) ?? ""),
    );
    return {
      id: answer.id,
      passed: answer.result,
      description: answer.description,
    };
  };
