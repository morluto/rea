import { CutterBridgeClient } from "../cutter/CutterBridgeClient.js";
import { CutterBridgeService } from "../cutter/CutterBridgeService.js";

/** Compose a fresh bridge owner without discovering or contacting Cutter. */
export const createCutterBridgeService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: NonNullable<
    ConstructorParameters<typeof CutterBridgeClient>[1]
  > = {},
): CutterBridgeService =>
  new CutterBridgeService(new CutterBridgeClient(environment, options));
