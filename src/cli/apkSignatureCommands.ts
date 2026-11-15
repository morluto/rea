import type { Logger } from "pino";

import { APK_SIGNATURE_PROVIDER_IDENTITY } from "../apkSignature/ApkSignatureRelease.js";
import { apkSignatureModule } from "../composition/apkSignature.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** CLI shares selected delivery and complete-Evidence publication with other artifact tools. */
export const registerApkSignatureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const deliver = deliverWithService(
    () => apkSignatureModule.create(environment),
    APK_SIGNATURE_PROVIDER_IDENTITY.id,
  );
  registerContractCommand(
    cli,
    logger,
    apkSignatureModule.contract,
    {
      command: apkSignatureModule.cliCommand,
      description:
        "Inspect declared APK signing schemes, signers and content digests",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      viewDelivery: {
        invalidJson: "view must be a JSON APK signature selection",
        kind: "apk-signature",
      },
      fields: {
        path: { description: "Selected local APK/ZIP/AAB" },
        view: {
          description:
            "JSON signer/digest/lineage selection; requires --detail summary and --evidence_output",
        },
      },
    },
    // The CLI delivers the summary itself, so the service returns complete
    // Evidence; the contract's own default would retain a summary instead.
    (input, context) => deliver({ ...input, detail: "complete" }, context),
  );
};
