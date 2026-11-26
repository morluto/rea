import { z } from "zod";

import { optionalSettingParser } from "./optionalSetting.js";

export const ENVIRONMENT_NAME_CONSTRAINT =
  "ENVIRONMENT_NAME must be a non-empty name when set.";

const parseName = optionalSettingParser(
  "ENVIRONMENT_NAME",
  z.string().trim().min(1),
  ENVIRONMENT_NAME_CONSTRAINT,
);

/** The served environment name override, or undefined when the manifest name applies. */
export const parseEnvironmentName = (
  environment: Readonly<NodeJS.ProcessEnv>,
) => parseName(environment.ENVIRONMENT_NAME);
