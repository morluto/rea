import type { RequestAnalysisPort } from "../../../src/ports/AnalysisProvider.js";
import { createCommandCli } from "./commandCli.js";
import pino from "pino";

import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { presentOmittableDefaults } from "../../../src/cli/omittableDefaults.js";
import type { ApktoolRequest } from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { ok } from "../../../src/domain/result.js";
import { serveInProcessCli } from "./serveInProcessCli.js";

export const invokeApktoolCli = async (argv: readonly string[]) => {
  const requests: ApktoolRequest[] = [];
  const provider: RequestAnalysisPort<ApktoolRequest> = {
    async inspectAvailability() {
      throw new Error("unexpected provider probe");
    },
    async close() {},
    async execute(request) {
      requests.push(request);
      return ok(
        createAnalysisExecution(
          { strings: [] },
          { id: "apktool", name: "Apktool", version: null },
        ),
      );
    },
  };
  const cli = createCommandCli();
  registerApktoolCommands(cli, pino({ level: "silent" }), {}, provider);
  presentOmittableDefaults(cli);

  return { ...(await serveInProcessCli(cli, argv)), requests };
};
