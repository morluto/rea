import { isCanonicalBase64 } from "../domain/stringPatterns.js";
import type { DriverResult } from "./AgentEnvComputer.js";

/** Decode the driver's first screenshot only when its encoded bytes are intact. */
export const readComputerScreenshotBytes = (
  reply: DriverResult,
): Buffer | undefined => {
  if (reply.isError) return undefined;
  const data = reply.content.find((block) => block.type === "image")?.data;
  if (typeof data !== "string" || data.length === 0 || !isCanonicalBase64(data))
    return undefined;
  return Buffer.from(data, "base64");
};
