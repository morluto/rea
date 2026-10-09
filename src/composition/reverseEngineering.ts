import { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";

/** Compose BYO reverse-engineering commands without acquiring tools at import time. */
export const createReverseEngineeringService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): ReverseEngineeringService => new ReverseEngineeringService({ environment });
