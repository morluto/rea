import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  completable,
  type RegisteredPrompt,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/binary/BinarySession.js";
import {
  PROMPT_CONTRACTS,
  renderGuidedPrompt,
  type PromptArgumentContract,
  type PromptContract,
} from "../contracts/promptContracts.js";
import {
  createPromptCompletionSource,
  type PromptCompletionSource,
} from "./promptCompletion.js";

const promptValuesSchema = z.record(z.string(), z.string());

/** Live prompt registry whose updates emit MCP prompts/list_changed. */
export interface GuidedPromptRegistry {
  update(contract: PromptContract): void;
}

/** Register every guided workflow and its session-scoped argument completers. */
export const registerGuidedPrompts = (
  server: EvidenceMcpServer,
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
): GuidedPromptRegistry => {
  const completion = createPromptCompletionSource(analysis, session);
  const prompts = new Map<string, RegisteredPrompt>();
  for (const contract of PROMPT_CONTRACTS)
    prompts.set(contract.name, registerPrompt(server, contract, completion));
  return {
    update(contract) {
      const prompt = prompts.get(contract.name);
      if (prompt === undefined)
        throw new RangeError(`Unknown guided prompt ${contract.name}`);
      const argsSchema = promptArgumentsSchema(contract, completion);
      prompt.update({
        title: contract.title,
        description: contract.description,
        argsSchema,
        callback: (arguments_) => promptResult(contract, arguments_),
      });
    },
  };
};

const registerPrompt = (
  server: EvidenceMcpServer,
  contract: PromptContract,
  completion: PromptCompletionSource,
): RegisteredPrompt => {
  const argsSchema = promptArgumentsSchema(contract, completion);
  return server.registerPrompt(
    contract.name,
    {
      title: contract.title,
      description: contract.description,
      argsSchema,
    },
    (arguments_) => promptResult(contract, arguments_),
  );
};

const promptArgumentsSchema = (
  contract: PromptContract,
  completion: PromptCompletionSource,
) => {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, argument] of Object.entries(contract.arguments))
    shape[name] = argumentSchema(argument, completion);
  return z.object(shape);
};

const argumentSchema = (
  argument: PromptArgumentContract,
  completion: PromptCompletionSource,
): z.ZodType => {
  const value = z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0)
    .describe(argument.description);
  const kind = argument.completion;
  const completed =
    kind === undefined
      ? value
      : completable(value, async (partial, context) => [
          ...(await completion.complete(kind, partial, context)),
        ]);
  return argument.required ? completed : completed.optional();
};

const promptResult = (contract: PromptContract, arguments_: unknown) => {
  const values = promptValuesSchema.parse(arguments_);
  for (const [name, argument] of Object.entries(contract.arguments))
    if (
      argument.required &&
      (values[name] === undefined || values[name]?.trim().length === 0)
    )
      throw new TypeError(`Invalid arguments: ${name} must not be empty`);
  return {
    description: contract.description,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: renderGuidedPrompt(contract, values),
        },
      },
    ],
  };
};
