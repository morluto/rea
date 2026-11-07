import {
  OwnedMcpStdioTransport,
  type OwnedMcpLauncher,
  type OwnedMcpTransportFailure,
} from "../process/OwnedMcpStdioTransport.js";
import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";

export type JadxLauncher = OwnedMcpLauncher;
export type JadxTransportFailure = OwnedMcpTransportFailure;

/** The JADX provider's bounded stdio protocol transport. */
export class JadxMcpTransport extends OwnedMcpStdioTransport {
  constructor(
    options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    launcher?: JadxLauncher,
  ) {
    super(
      options,
      {
        provider: "jadx",
        label: "JADX",
        maxFrameBytes: 8 * 1024 * 1024,
        maxOperationBytes: 32 * 1024 * 1024,
        notifyOnExit: true,
      },
      launcher,
    );
  }
}
