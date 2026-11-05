import { z } from "zod";

import { buildSourceSchema } from "../domain/desktop/appBuild.js";
import {
  COMPUTER_ACTIONS,
  computerActionInputSchema,
} from "../domain/desktop/computerActions.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

const computerId = z.uuid().describe("The id start_build_computer returned.");
const driverResult = jsonObjectSchema
  .nullable()
  .describe(
    "The driver's structured result, such as frame_id, width and height; null when it returned none.",
  );
const EXAMPLE_ID = "00000000-0000-4000-8000-000000000001";

/** Session tools that keep an agentenv computer up and forward computer-use actions to it while an environment is built. */
export const DESKTOP_BUILD_TOOL_CONTRACTS = [
  {
    name: "start_build_computer",
    ...toolContractMetadata("start_build_computer"),
    kind: "application",
    description:
      "Start a local agentenv computer to build a desktop app environment on, and return its id with a first screenshot as an image. From a request, REA renders a bundle that installs the app from the Ubuntu archive, an apt repository or a .deb URL, opens it on demand from its desktop entry (it is not open at first: open it from the desktop's Applications menu, under Other, by the environment's name), and installs REA itself in a build-only layer from REA_BUILD_COMPUTER_REA_ARCHIVE; from a bundle folder, such as an exported one, it starts that bundle's smoke task as it is. Needs Docker and the agentenv runner named by REA_AGENT_ENV_COMMAND; the first start of a bundle builds its image, which downloads packages and can take minutes. The computer stays up, reachable on this host, until close_build_computer or the server closes.",
    inputSchema: z.strictObject({ source: buildSourceSchema }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      sandbox_id: z.string().describe("agentenv's sandbox id."),
      environment: z
        .string()
        .describe("The rendered environment's name, or the bundle folder."),
      screenshot: driverResult,
    }),
    examples: [
      {
        title: "Build Mousepad from the Ubuntu archive",
        input: {
          source: {
            kind: "request",
            desktop_entry: "org.xfce.mousepad",
            install: { kind: "archive", package: "mousepad" },
          },
        },
      },
      {
        title: "Start an exported bundle",
        input: { source: { kind: "bundle", path: "/tmp/mousepad-bundle" } },
      },
    ],
  },
  {
    name: "act_on_build_computer",
    ...toolContractMetadata("act_on_build_computer"),
    kind: "application",
    description: `Drive the app on a build computer: one action, ${COMPUTER_ACTIONS.join(", ")}, sent to the computer's computer_<action> tool with the fields given, which are the driver's own arguments. Points are pixels of the latest frame, so take a screenshot first, or space norm on a 0..norm_scale grid; count 2 double-clicks; keys names one chord in W3C names, and spellings such as ctrl+s are translated. Returns the driver's content unchanged, its images included, and its structured result; an action's screenshot is taken at once, so after one that opens a menu or a window, take it with a wait instead; a refusal, such as a stale frame, is an error with the computer's message. Each action is logged on the computer.`,
    inputSchema: computerActionInputSchema,
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      action: z.enum(COMPUTER_ACTIONS),
      action_index: z
        .int()
        .nonnegative()
        .describe("The action's place in the computer's action log."),
      result: driverResult,
    }),
    examples: [
      {
        title: "Look at the screen",
        input: { computer_id: EXAMPLE_ID, action: "screenshot" },
      },
      {
        title: "Double-click a point of the latest frame",
        input: {
          computer_id: EXAMPLE_ID,
          action: "click",
          x: 640,
          y: 400,
          count: 2,
        },
      },
      {
        title: "Save",
        input: { computer_id: EXAMPLE_ID, action: "key", keys: ["ctrl+s"] },
      },
    ],
  },
  {
    name: "close_build_computer",
    ...toolContractMetadata("close_build_computer"),
    kind: "application",
    description:
      "Tear a build computer down and discard its state. agentenv's teardown is tried first; if it leaves the computer up, REA removes that exact sandbox's containers, the one named agent-<sandbox id> and any labelled agentenv.sandbox=<sandbox id>, with REA_DOCKER_COMMAND. When neither confirms it, the error names what is left and the computer stays listed, so closing again retries.",
    inputSchema: z.strictObject({ computer_id: computerId }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      teardown: z
        .enum(["agentenv", "container_label"])
        .describe("What confirmed the computer is gone."),
    }),
    examples: [
      {
        title: "Close a build computer",
        input: { computer_id: EXAMPLE_ID },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
