import { AnalysisTargetFailureError } from "../domain/analysisErrorCore.js";
import {
  evmProxyBudgetLimit,
  deriveProxyFacts,
  followProxyChain,
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

const EVM_PROXY_LIMITATIONS = [
  "Only the exact 45-byte ERC-1167 runtime is recognized; shortened-address clones and other proxy patterns are not, so none_recognized does not show the code is not a proxy.",
  "Edges are inferred from the selected bytes and caller-supplied slot words. Deployment, snapshot authenticity, whether bytecode belongs to its snapshot account and any executed delegatecall are not established.",
  "A supplied chain step means the caller provided an artifact for that account, chain and block; it does not verify the relationship on chain.",
  "A beacon's implementation is not resolved; implementation() is never called.",
] as const;

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
    // The file being read and, once read, its identity: both name a failure.
    let path = input.path;
    let observed: { sha256: string; bytes: number } | undefined;
    const read = async (selected: Parameters<typeof followedAccount>[0]) => {
      path = selected.path;
      observed = undefined;
      const carrier = await readStableArtifact(
        selected.path,
        input.max_file_bytes,
        options?.signal,
        undefined,
        this.#resources,
      );
      observed = { sha256: carrier.sha256, bytes: carrier.bytes.length };
      assertArtifactReadActive(options?.signal);
      return followedAccount(selected, carrier);
    };
    try {
      return await this.#resources.run(async () => {
        const root = await read(input);
        const accounts = [];
        for (const entry of input.related ?? [])
          accounts.push(await read(entry));
        const { chain, reached } = followProxyChain(root, accounts);
        return ok({
          ...root,
          related: accounts.map((account, index) => ({
            ...account,
            reached: reached[index] === true,
          })),
          chain,
          limitations: [...EVM_PROXY_LIMITATIONS],
        });
      });
    } catch (cause) {
      const facts = artifactFilePrimaryFacts(cause);
      const selected = { path, max_file_bytes: input.max_file_bytes };
      return err(
        projectStableArtifactFailure(
          cause,
          classifyProviderFailure(
            facts.cause,
            evmProxyDialect(facts, selected),
          ),
          path,
          EVM_PROXY_PROVIDER.id,
          OPERATION,
          observed,
        ),
      );
    }
  }
}

/** Decode one read carrier into that account's identity and proxy facts. */
const followedAccount = (
  selected: Pick<InspectEvmProxyInput, "path" | "encoding" | "snapshot">,
  carrier: { readonly sha256: string; readonly bytes: Uint8Array },
) => {
  const code = decodeEvmBytecodeCarrier(carrier.bytes, selected.encoding);
  return {
    artifact: {
      path: selected.path,
      sha256: carrier.sha256,
      bytes: carrier.bytes.length,
      encoding: selected.encoding,
    },
    bytecode: { sha256: sha256Hex(code), bytes: code.length },
    ...deriveProxyFacts(code, selected.snapshot),
  };
};

const evmProxyDialect = (
  facts: ArtifactFilePrimaryFacts,
  input: Pick<InspectEvmProxyInput, "path" | "max_file_bytes">,
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
    fileSize: (failure) => {
      // Absent or beyond a safe integer: report no retry value.
      const observed = Number(failure.observedBytes);
      const required = Number.isSafeInteger(observed) ? observed : undefined;
      const limit = evmProxyBudgetLimit("max_file_bytes", input.max_file_bytes);
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "evm-bytecode",
          failure.message,
          {
            name: "max_file_bytes",
            maximum: input.max_file_bytes,
            ...(failure.observedBytes === undefined
              ? {}
              : { required: failure.observedBytes }),
          },
          { cause: failure },
        ),
        {
          retryable: false,
          limit:
            required === undefined
              ? limit
              : { ...limit, required_value: required },
        },
      );
    },
  });
