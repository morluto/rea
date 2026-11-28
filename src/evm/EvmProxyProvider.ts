import { AnalysisTargetFailureError } from "../domain/analysisErrorCore.js";
import {
  evmProxyBudgetLimit,
  deriveProxyFacts,
  type InspectEvmProxyInput,
} from "../domain/evm/evmProxy.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { EVM_PROXY_PROVIDER } from "../domain/investigationProviders.js";
import { err, ok } from "../domain/result.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { EvmProxyPort } from "../ports/evm/EvmProxyPort.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
  assertArtifactReadActive,
  closeArtifactResources,
  projectStableArtifactFailure,
  readStableArtifact,
} from "../resources/index.js";
import {
  decodeEvmBytecodeCarrier,
  EvmCarrierFailure,
} from "./EvmBytecodeCarrier.js";

const OPERATION = "inspect_evm_proxy";

/** Offline proxy recognition over one bounded, identity-checked carrier. */
export class EvmProxyProvider implements EvmProxyPort {
  readonly identity = EVM_PROXY_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      EVM_PROXY_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectEvmProxyInput, options?: ExecutionOptions) {
    try {
      return await this.#resources.run(async () => {
        const carrier = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const code = decodeEvmBytecodeCarrier(carrier.bytes, input.encoding);
        return ok({
          artifact: {
            path: input.path,
            sha256: carrier.sha256,
            bytes: carrier.bytes.length,
            encoding: input.encoding,
          },
          bytecode: { sha256: sha256Hex(code), bytes: code.length },
          ...deriveProxyFacts(code, input.snapshot),
          limitations: [
            "Only the exact 45-byte ERC-1167 runtime is recognized; shortened-address clones and other proxy patterns are not, so none_recognized does not show the code is not a proxy.",
            "Edges are inferred from the selected bytes and caller-supplied slot words. Deployment, snapshot authenticity, whether the bytecode belongs to the snapshot account, code at a target address and any executed delegatecall are not established.",
            "A beacon's implementation is not resolved; implementation() is never called.",
          ],
        });
      });
    } catch (cause) {
      const facts = artifactFilePrimaryFacts(cause);
      return err(
        projectStableArtifactFailure(
          cause,
          classifyProviderFailure(facts.cause, evmProxyDialect(facts, input)),
          input.path,
          EVM_PROXY_PROVIDER.id,
          OPERATION,
        ),
      );
    }
  }
}

const evmProxyDialect = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectEvmProxyInput,
) =>
  offlineArtifactFailureDialect(facts, {
    providerId: EVM_PROXY_PROVIDER.id,
    operation: OPERATION,
    path: input.path,
    description: "bytecode carrier",
    fallbackMessage: "EVM proxy inspection failed.",
    recognise: (failure) =>
      failure instanceof EvmCarrierFailure
        ? new AnalysisTargetFailureError(OPERATION, input.path, {
            kind: "malformed",
            format: "evm-bytecode",
            detail: failure.message,
          })
        : undefined,
    fileSize: (failure) =>
      parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "evm-bytecode",
          failure.message,
          { name: "max_file_bytes", maximum: input.max_file_bytes },
          { cause: failure },
        ),
        {
          retryable: false,
          limit: evmProxyBudgetLimit("max_file_bytes", input.max_file_bytes),
        },
      ),
  });
