import { AnalysisTargetFailureError } from "../domain/analysisErrorCore.js";
import {
  bindMetadataCommitment,
  solidityMetadataBudgetLimit,
  type SolidityMetadataBudget,
  type VerifySolidityMetadataInput,
} from "../domain/evm/solidityMetadataBinding.js";
import { SOLIDITY_METADATA_BINDING_PROVIDER } from "../domain/investigationProviders.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { err, ok } from "../domain/result.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { SolidityMetadataBindingPort } from "../ports/evm/SolidityMetadataBindingPort.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import {
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
  assertArtifactReadActive,
  closeArtifactResources,
  completedStableArtifactObservation,
  projectStableArtifactFailure,
  readStableArtifact,
  type ArtifactFilePrimaryFacts,
} from "../resources/index.js";
import {
  decodeEvmBytecodeCarrier,
  EvmCarrierFailure,
} from "./EvmBytecodeCarrier.js";
import { ipfsFileMultihash } from "./IpfsFileHash.js";
import { inspectSolidityMetadata } from "./SolidityMetadata.js";

const OPERATION = "verify_solidity_metadata";

const LIMITATIONS = [
  "A match shows only that these exact metadata bytes have the hash recorded at the end of the selected bytecode. It does not verify source code, compilation, deployment or who produced either file.",
  "Only IPFS commitments are compared; Swarm (bzzr0, bzzr1) commitments stay unverified. A reformatted or newline-terminated copy of the metadata is a different file and does not match.",
  "Source URLs and hashes inside the metadata are not read or retrieved.",
] as const;

/** The file being read, named by the request fields that select and bound it. */
interface SelectedFile {
  readonly path: string;
  readonly field: "path" | "metadata_path";
  readonly budget: SolidityMetadataBudget;
  readonly maximum: number;
}

/** Offline comparison of a bytecode metadata commitment with a local file. */
export class SolidityMetadataBindingProvider implements SolidityMetadataBindingPort {
  readonly identity = SOLIDITY_METADATA_BINDING_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      SOLIDITY_METADATA_BINDING_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: VerifySolidityMetadataInput,
    options?: ExecutionOptions,
  ) {
    const carrierFile: SelectedFile = {
      path: input.path,
      field: "path",
      budget: "max_file_bytes",
      maximum: input.max_file_bytes,
    };
    const metadataFile: SelectedFile = {
      path: input.metadata_path,
      field: "metadata_path",
      budget: "max_metadata_bytes",
      maximum: input.max_metadata_bytes,
    };
    // The current file names a failure; completed files survive it.
    let current = carrierFile;
    let observed: { sha256: string; bytes: number } | undefined;
    const completed: { path: string; sha256: string; bytes: number }[] = [];
    const read = async (file: SelectedFile) => {
      current = file;
      observed = undefined;
      const snapshot = await readStableArtifact(
        file.path,
        file.maximum,
        options?.signal,
        undefined,
        this.#resources,
      );
      observed = { sha256: snapshot.sha256, bytes: snapshot.bytes.length };
      assertArtifactReadActive(options?.signal);
      return snapshot;
    };
    try {
      return await this.#resources.run(async () => {
        const carrier = await read(carrierFile);
        const code = decodeEvmBytecodeCarrier(carrier.bytes, input.encoding);
        const artifact = {
          path: input.path,
          sha256: carrier.sha256,
          bytes: carrier.bytes.length,
        };
        completed.push(artifact);
        const metadata = await read(metadataFile);
        const trailer = inspectSolidityMetadata(code);
        return ok({
          artifact: { ...artifact, encoding: input.encoding },
          bytecode: { sha256: sha256Hex(code), bytes: code.length },
          metadata_file: {
            path: input.metadata_path,
            sha256: metadata.sha256,
            bytes: metadata.bytes.length,
          },
          trailer,
          binding: bindMetadataCommitment(trailer, () =>
            ipfsFileMultihash(metadata.bytes),
          ),
          limitations: [...LIMITATIONS],
        });
      });
    } catch (cause) {
      const facts = artifactFilePrimaryFacts(cause);
      const primary = classifyProviderFailure(
        facts.cause,
        bindingDialect(facts, current),
      );
      if (completed.length > 0 && current === metadataFile) {
        // A read can complete inside the thrown error, e.g. when close fails.
        const failed = completedStableArtifactObservation(
          cause,
          current.path,
          observed,
        );
        primary.retainPartialObservation({
          kind: "solidity-metadata-files",
          files: [
            ...completed,
            ...(failed?.kind === "file-snapshot-hash" && failed.sha256 !== null
              ? [
                  {
                    path: current.path,
                    sha256: failed.sha256,
                    bytes: failed.bytes,
                  },
                ]
              : []),
          ],
        });
      }
      return err(
        projectStableArtifactFailure(
          cause,
          primary,
          current.path,
          SOLIDITY_METADATA_BINDING_PROVIDER.id,
          OPERATION,
          observed,
        ),
      );
    }
  }
}

const bindingDialect = (facts: ArtifactFilePrimaryFacts, file: SelectedFile) =>
  offlineArtifactFailureDialect(facts, {
    providerId: SOLIDITY_METADATA_BINDING_PROVIDER.id,
    operation: OPERATION,
    path: file.path,
    field: file.field,
    description: file.field === "path" ? "bytecode carrier" : "metadata file",
    fallbackMessage: "Solidity metadata verification failed.",
    recognise: (failure) =>
      failure instanceof EvmCarrierFailure
        ? new AnalysisTargetFailureError(OPERATION, file.path, {
            kind: "malformed",
            format: "evm-bytecode",
            detail: failure.message,
          })
        : undefined,
    fileSize: (failure) => {
      // Absent or beyond a safe integer: report no retry value.
      const measured = Number(failure.observedBytes);
      const limit = solidityMetadataBudgetLimit(file.budget, file.maximum);
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "evm-bytecode",
          failure.message,
          {
            name: file.budget,
            maximum: file.maximum,
            ...(failure.observedBytes === undefined
              ? {}
              : { required: failure.observedBytes }),
          },
          { cause: failure },
        ),
        {
          retryable: false,
          limit: Number.isSafeInteger(measured)
            ? { ...limit, required_value: measured }
            : limit,
        },
      );
    },
  });
