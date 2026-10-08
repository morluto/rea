import { realpath } from "node:fs/promises";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  inspectSignatureSchema,
  type NativeCommandInvocation,
} from "../domain/native/nativeInspection.js";
import { deriveSecurityFacets } from "./CodeSigningPolicy.js";
import {
  bindSignatureTarget,
  signatureTargetIssue,
} from "./SignatureTargetBinding.js";
import { omittedPrototypeKeysLimitation } from "../domain/propertyListKeys.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  NativeCommandFailure,
  type NativeCommandCapture,
} from "./CommandRunner.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY } from "./NativeMacOSProviderMetadata.js";
import type { NativeObservation } from "./NativeObservation.js";
import {
  signatureVerification,
  codesignOperationalFailure,
  codesignReasons,
} from "./CodesignVerification.js";
import { parseCodeSignature } from "./parsers/codesign.js";
import { parseSignatureEntitlements } from "./NativeSignatureEntitlements.js";
import {
  inspectSignatureSlices,
  unsignedSignatureCapture,
  type SignatureCapture,
} from "./NativeSignatureProbes.js";
import {
  SIGNATURE_POSTURE_LIMITATIONS,
  signedCodePath,
  stapledTicket,
} from "./NativeSignaturePosture.js";
import { unconfirmedNestedCode } from "./NativeNestedCode.js";

interface SignatureDisplays {
  readonly display: NativeCommandCapture;
  readonly requirements: NativeCommandCapture;
  readonly entitlements: NativeCommandCapture;
}

/** Display failures and unsigned observations use the same reason parser as verification. */
const signatureDisplays = async (
  path: string,
  capture: SignatureCapture,
  signal?: AbortSignal,
): Promise<Result<SignatureDisplays, AnalysisError>> => {
  const display = await capture(["-d", "--verbose=4", path], signal);
  if (!display.ok) return display;
  const requirements = await capture(["-d", "-r-", path], signal);
  if (!requirements.ok) return requirements;
  const entitlements = await capture(
    ["-d", "--entitlements", ":-", path],
    signal,
  );
  if (!entitlements.ok) return entitlements;
  for (const result of [
    display.value,
    requirements.value,
    entitlements.value,
  ]) {
    if (result.exitCode !== 0 && !unsignedSignatureCapture(result, path))
      return err(
        new ProviderAdapterError(
          NATIVE_MACOS_PROVIDER_IDENTITY.id,
          "inspect_signature",
          {
            cause: new NativeCommandFailure(
              "codesign",
              "nonzero-exit",
              result.exitCode,
            ),
          },
        ),
      );
  }
  return ok({
    display: display.value,
    requirements: requirements.value,
    entitlements: entitlements.value,
  });
};

/** Compose displays, independent slice knowledge, verification, and local ticket evidence. */
export const inspectNativeSignature = async (options: {
  readonly target: BinaryTarget;
  readonly capture: SignatureCapture;
  readonly invocation: (
    capture: NativeCommandCapture,
  ) => NativeCommandInvocation;
  readonly signal?: AbortSignal;
}): Promise<Result<NativeObservation, AnalysisError>> => {
  const { target, capture, signal } = options;
  const binding = await bindSignatureTarget(target, signal);
  const displays = await signatureDisplays(target.path, capture, signal);
  if (!displays.ok) return displays;
  const { display, requirements, entitlements } = displays.value;
  const unsigned = unsignedSignatureCapture(display, target.path);
  let canonical: string[] = [];
  try {
    canonical = [await realpath(target.path)];
  } catch {
    /* The display retains the observed path. */
  }
  const parsed = parseCodeSignature(display.stderr, unsigned, [
    target.path,
    ...canonical,
  ]);
  const entitlementValue = parseSignatureEntitlements(entitlements.stdout);
  const code = signedCodePath(target);
  const verify = (path: string) =>
    capture(["--verify", "--deep", "--strict", "--verbose=2", path], signal);
  const verified = await verify(code);
  if (!verified.ok) return verified;
  const captures = [display, requirements, entitlements, verified.value];
  let appleOrigin = false;
  let appleOriginFailure: string | undefined;
  if (!unsigned && (parsed.code_directory?.platform_identifier ?? 0) !== 0) {
    const anchor = await capture(["--verify", "-R=anchor apple", code], signal);
    if (!anchor.ok) return anchor;
    captures.push(anchor.value);
    appleOrigin = anchor.value.exitCode === 0;
    if (!appleOrigin) {
      const reason = codesignReasons(anchor.value, code).find(
        (line) => line.trim().length > 0,
      );
      appleOriginFailure = reason ?? `codesign exited ${anchor.value.exitCode}`;
    }
  }
  const slices = await inspectSignatureSlices(
    target,
    { format: parsed.format, requirements, entitlements, unsigned },
    capture,
    signal,
  );
  if (!slices.ok) return slices;
  captures.push(...slices.value.captures);
  const aggregateUnsigned =
    slices.value.signed === undefined ? unsigned : !slices.value.signed;
  // Verification is independent evidence: uncertain display probes must not
  // erase an explicit signature failure from the verifier.
  const verification = signatureVerification(
    verified.value,
    code,
    aggregateUnsigned,
  );
  const limitations = [
    ...parsed.limitations,
    ...SIGNATURE_POSTURE_LIMITATIONS,
    ...slices.value.limitations,
    ...(await unconfirmedNestedCode(verification, signal)),
  ];
  if (entitlementValue.omittedPrototypeKeys !== 0)
    limitations.push(
      `Entitlements: ${omittedPrototypeKeysLimitation(entitlementValue.omittedPrototypeKeys)}`,
    );
  if (appleOriginFailure !== undefined)
    limitations.push(`Apple-origin check failed: ${appleOriginFailure}`);
  if (verification.status === "unknown")
    limitations.push(
      "Signature verification is inconclusive (permission, I/O or unrecognized diagnostic); this is not a proven broken signature.",
    );
  else if (codesignOperationalFailure(verified.value, code))
    limitations.push(
      "Some code could not be verified due to operational diagnostics; definitive signature failures elsewhere still prove invalidity.",
    );
  let mainInvalid =
    verification.status === "invalid" || verification.status === "unknown";
  if (mainInvalid && !unsigned && code !== target.path) {
    const main = await verify(target.path);
    if (!main.ok) return main;
    captures.push(main.value);
    mainInvalid = main.value.exitCode !== 0;
  }
  const provenance = captures.map(options.invocation);
  const ticket = await stapledTicket(target, signal);
  const versionIssue = await signatureTargetIssue(target, binding, signal);
  const facets = deriveSecurityFacets({
    signed: !aggregateUnsigned,
    codeDirectory: parsed.code_directory,
    entitlements: entitlementValue.value,
    entitlementsKnown: unsigned || entitlements.exitCode === 0,
    mixedSlices: slices.value.mixed,
    appleOrigin,
    signatureInvalid: mainInvalid,
  });
  if (versionIssue !== null)
    limitations.push(
      versionIssue,
      "Security facets are unknown because command observations could not be bound to one registered target version.",
    );
  const result = inspectSignatureSchema.parse({
    ...parsed,
    signed: !aggregateUnsigned,
    designated_requirement:
      /designated\s*=>\s*(.+)$/mu.exec(requirements.stdout)?.[1] ?? null,
    entitlements: entitlementValue.value,
    verification,
    stapled_ticket: ticket,
    security_facets:
      versionIssue === null
        ? facets
        : facets.map((facet) => ({
            ...facet,
            state: "unknown" as const,
            evidence: [...facet.evidence, "target version not bound"],
            explanation: `${facet.explanation} Target version binding failed: ${versionIssue}`,
          })),
    provenance,
    limitations,
  });
  return ok({
    result: jsonValueSchema.parse(result),
    provenance,
    limitations: result.limitations,
    locations: [],
  });
};
