import { Cli, z } from "incur";

import { currentClientRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
import { clientRegistrationCommandText } from "./cli/clientRegistrationCommandText.js";
import { PRODUCT_IDENTITY } from "./identity.js";

/** Shared CLI identity and builtins, without command-specific schemas. */
export const createCliBase = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const cli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    globals: z.object({
      timings: z
        .boolean()
        .default(false)
        .describe("Write measured command timing to stderr."),
    }),
    mcp: {
      command: clientRegistrationCommandText(
        currentClientRegistrationCommand({ environment }),
      ),
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
    update: {
      // Incur's update:false only suppresses notices. Reject its explicit
      // installer so ambiguous flags cannot bypass REA's verified workflow.
      install: () => {
        throw new Error(
          "Use 'rea update' to update the identified installation. The '--update' alias accepts only global output flags.",
        );
      },
    },
  });

  cli.use(async (context, next) => {
    if (!context.globals.timings) return next();
    const started = performance.now();
    try {
      await next();
    } finally {
      // This interval covers CLI command dispatch, including result delivery.
      // It is not a provider-only or analysis-only measurement.
      process.stderr.write(
        `${JSON.stringify({ rea_timings: { version: 1, command_ms: Math.round(performance.now() - started) } })}\n`,
      );
    }
  });
  return cli;
};
