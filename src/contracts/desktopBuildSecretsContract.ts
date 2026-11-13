import { z } from "zod";

import {
  buildStatePathSchema,
  MAX_BUILD_STATE_PATHS,
} from "../domain/desktop/buildCapture.js";
import {
  MAX_WITHHELD_BYTES,
  SIGN_IN_END,
  SIGN_IN_START,
} from "../domain/desktop/appWithheld.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

const EXAMPLE_ID = "00000000-0000-4000-8000-000000000001";
const strings = z.array(z.string());
const computerId = z.uuid().describe("The id start_build_computer returned.");

/** Where the person writes a secret's file, as the tools name it. */
export const BUILD_SECRETS_FOLDER =
  "$XDG_CONFIG_HOME/rea/build-secrets/<handle>, or ~/.config/rea/build-secrets/<handle>";

/** The export's description of withheld sign-in state. */
export const WITHHELD_EXPORT_DESCRIPTION = `Files under the owned paths that changed between the ${SIGN_IN_START} and ${SIGN_IN_END} checkpoints, and those named in withhold, are withheld from the seed as sign-in or licence state: each becomes a secret setting the deploy takes from an environment variable as the file's bytes in base64, the README says how to fill it, a check may not name it, and REA keeps its bytes as the secret withheld_files names by handle, for start_build_computer's settings when witnessing; a file larger than ${String(MAX_WITHHELD_BYTES / 1024)} KiB cannot be withheld. With seed_sign_in, they are seeded instead, which needs a seed_sign_in consent from record_build_consent; every recorded consent ships as consent.json.`;

/** The draft's list of the files it leaves out as withheld. */
export const draftWithheldField = strings.describe(
  `Files that changed between ${SIGN_IN_START} and ${SIGN_IN_END}, which the draft leaves out and the export withholds from the seed.`,
);

/** act_on_build_computer's example of a typed secret. */
export const TYPE_SECRET_EXAMPLE = {
  title: "Type a password the person put in a secret's file",
  input: {
    computer_id: EXAMPLE_ID,
    action: "type_secret",
    secret: "keepassxc-master",
  },
} as const;

/** The export's inputs for withheld sign-in state: files to withhold beside the window's, and seeding them with consent. */
export const withholdInputFields = {
  withhold: z
    .array(buildStatePathSchema)
    .max(MAX_BUILD_STATE_PATHS)
    .optional()
    .describe(
      "Files under the owned paths to withhold from the seed as sign-in or licence state beside those the sign-in checkpoints find, such as a trial's licence file the app writes at first launch; relative to the home.",
    ),
  seed_sign_in: z
    .boolean()
    .optional()
    .describe(
      "Seed the withheld files after all; needs a seed_sign_in consent from record_build_consent on this computer.",
    ),
};

/** The export's report of withheld sign-in state: each file's variable and handle, and those seeded with consent. */
export const withheldOutputFields = {
  withheld_files: z
    .array(
      z.strictObject({
        file: z.string(),
        variable: z
          .string()
          .describe(
            "The environment variable a deploy reads the file's bytes from, in base64.",
          ),
        handle: z
          .string()
          .describe(
            "The secret REA keeps the file's bytes in, for start_build_computer's settings.",
          ),
      }),
    )
    .describe("Files withheld from the seed as sign-in or licence state."),
  consented_files: strings.describe(
    "Withheld files seeded all the same, with the person's consent.",
  ),
};

/** Record the person's consent, in their words, for the export to ship and to gate seeding withheld state. */
export const RECORD_BUILD_CONSENT_CONTRACT = {
  name: "record_build_consent",
  ...toolContractMetadata("record_build_consent"),
  kind: "application",
  description:
    "Record a consent the person gave, in their own words, after you asked them: kind licence when they accepted a licence the app or its installer shows, which you then accept on their behalf, or seed_sign_in when they allowed the bundle to hold their sign-in or licence state. Never record one they did not give. The consent is kept with the computer; the export writes every one into the bundle's consent.json, and seeds withheld state only with a seed_sign_in consent.",
  inputSchema: z.strictObject({
    computer_id: computerId,
    kind: z.enum(["licence", "seed_sign_in"]),
    subject: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "What the person consented to: the licence's name, or the signed-in state the bundle holds.",
      ),
    url: z
      .url({ protocol: /^https?$/u })
      .optional()
      .describe("Where the licence can be read."),
    words: z
      .string()
      .min(1)
      .max(2000)
      .describe("The person's reply, word for word."),
  }),
  outputSchema: z.strictObject({
    computer_id: z.uuid(),
    consent: z.strictObject({
      kind: z.enum(["licence", "seed_sign_in"]),
      subject: z.string(),
      url: z.string().optional(),
      words: z.string(),
      recorded_at: z.string(),
      source: z
        .literal("relayed")
        .describe("The agent relayed the person's words."),
    }),
    consents: z
      .int()
      .nonnegative()
      .describe("How many consents this computer holds."),
  }),
  examples: [
    {
      title: "Record that the person accepted a licence",
      input: {
        computer_id: EXAMPLE_ID,
        kind: "licence",
        subject: "VariCAD 30-day trial licence",
        url: "https://www.varicad.com/",
        words: "I accept the VariCAD trial licence.",
      },
    },
  ],
} as const satisfies ToolContract;
