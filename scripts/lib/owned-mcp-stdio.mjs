import { importVerifierSource } from "./verifier-source-loader.mjs";

let implementation;

/** Create an SDK-compatible transport which retains the exact process owner. */
export async function createOwnedMcpStdioTransport(options) {
  implementation ??= importVerifierSource(
    new URL("../../src/process/OwnedMcpStdioTransport.ts", import.meta.url)
      .href,
    import.meta.url,
  );
  const { OwnedMcpStdioTransport } = await implementation;
  return new OwnedMcpStdioTransport(options, {
    provider: "artifact-verifier",
    label: "Artifact verifier",
    // Match the SDK's default maximum buffered stdio message size.
    maxFrameBytes: 10 * 1024 * 1024,
    // Unlike the JADX adapter, artifact verifiers do not impose a cumulative
    // per-connection output limit; the SDK bounds each buffered message.
    maxOperationBytes: Infinity,
    gracefulInputCloseMs: 2000,
    maxDiagnosticBytes: 64 * 1024,
  });
}
