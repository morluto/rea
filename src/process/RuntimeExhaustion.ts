import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderProcessOutputToken } from "./ProcessOutputTokenScanner.js";

/** A managed runtime whose memory exhaustion is reported in process output. */
export type ManagedRuntime = "jvm" | "v8";

/**
 * The literal each runtime writes when it runs out of memory. HotSpot writes
 * `java.lang.OutOfMemoryError: <area>`; V8 ends each fatal heap message with
 * `JavaScript heap out of memory`.
 */
export const RUNTIME_EXHAUSTION_TOKENS: Readonly<
  Record<ManagedRuntime, string>
> = {
  jvm: "java.lang.OutOfMemoryError",
  v8: "JavaScript heap out of memory",
};

/** The runtime memory areas a reported line can name. */
export const RUNTIME_EXHAUSTION_AREAS = [
  "heap",
  "gc-overhead",
  "metaspace",
  "array-size",
  "native-thread",
] as const;

/** Which runtime memory area the reported line names, when it names one. */
export type RuntimeExhaustionArea = (typeof RUNTIME_EXHAUSTION_AREAS)[number];

/** HotSpot's out-of-memory detail strings, in reporting precedence. */
export const JVM_EXHAUSTION_DETAILS: readonly (readonly [
  string,
  RuntimeExhaustionArea,
])[] = [
  ["Java heap space", "heap"],
  ["GC overhead limit exceeded", "gc-overhead"],
  ["Metaspace", "metaspace"],
  ["Requested array size exceeds VM limit", "array-size"],
  ["unable to create native thread", "native-thread"],
];

/**
 * A JVM whose memory limits REA does not set, as the provider that runs it
 * names it in recovery advice.
 */
export interface ExternalJvm {
  /** Possessive name of the program, such as "JEB's". */
  readonly program: string;
  /** What the JVM does for REA, such as "engine" or "decoder". */
  readonly role: string;
  /** How the user raises one JVM option, starting with a capital. */
  readonly raise: (option: string) => string;
  /** Where that JVM's memory settings are reviewed. */
  readonly settings: string;
  /** How the user lowers native thread demand, starting with a capital. */
  readonly threads: string;
  /** How the user selects smaller work, starting in lower case. */
  readonly smaller: string;
}

const capitalized = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
const lowered = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Recovery for a reported JVM memory area, naming the option that governs
 * that area: the heap (-Xmx) for heap and GC overhead, -XX:MaxMetaspaceSize
 * for metaspace, nothing for an oversized array, and host thread capacity
 * for native threads.
 */
export const externalJvmExhaustionRecovery = (
  area: RuntimeExhaustionArea | undefined,
  jvm: ExternalJvm,
): string => {
  const heap = jvm.raise("maximum heap (-Xmx)");
  switch (area) {
    case "heap":
      return `REA does not set ${jvm.program} Java heap. ${heap}, or ${jvm.smaller}.`;
    case "gc-overhead":
      return `REA does not set ${jvm.program} Java heap. The ${jvm.role} JVM spent nearly all its time collecting garbage; ${lowered(heap)}, or ${jvm.smaller}.`;
    case "metaspace":
      return `REA does not set ${jvm.program} class metadata limit. ${jvm.raise("-XX:MaxMetaspaceSize")}; a larger heap (-Xmx) does not raise it.`;
    case "array-size":
      return `The ${jvm.role} requested an array larger than the JVM allows; a larger heap (-Xmx) does not lift this limit. ${capitalized(jvm.smaller)}.`;
    case "native-thread":
      return `The ${jvm.role} JVM could not create a native thread. ${jvm.threads}; a larger heap (-Xmx) does not help.`;
    case undefined:
      return `REA does not set the memory limits of ${jvm.program} JVM. Review the reported out-of-memory line and ${jvm.settings}, or ${jvm.smaller}.`;
  }
};

/**
 * The runtime's own memory exhaustion report, observed from every drained
 * byte as output streamed, so a retention budget cannot hide it.
 */
export interface RuntimeExhaustion {
  readonly runtime: ManagedRuntime;
  readonly area: RuntimeExhaustionArea | undefined;
  readonly stream: "stdout" | "stderr";
  /** The reporting line, bounded; it may be cut on either side. */
  readonly line: string;
  /** False when the line's end was cut or not yet observed. */
  readonly lineComplete: boolean;
  /** True when the scanner omitted bytes on either side of the line. */
  readonly truncated: boolean;
  /** True when the retained line bytes were not valid UTF-8. */
  readonly invalidUtf8: boolean;
}

/** Name the memory area a JVM out-of-memory line reports, if it names one. */
export const jvmExhaustionArea = (
  line: string,
): RuntimeExhaustionArea | undefined =>
  JVM_EXHAUSTION_DETAILS.find(([detail]) => line.includes(detail))?.[1];

/** Interpret one observed runtime token as that runtime's exhaustion report. */
export const runtimeExhaustion = (
  runtime: ManagedRuntime,
  stream: "stdout" | "stderr",
  token: ProviderProcessOutputToken,
): RuntimeExhaustion => ({
  runtime,
  // Every V8 report of this token is heap exhaustion.
  area: runtime === "jvm" ? jvmExhaustionArea(token.line) : "heap",
  stream,
  line: token.line,
  lineComplete: token.trailingContextIncomplete !== true,
  truncated: token.truncated,
  invalidUtf8: token.invalidUtf8 === true,
});

/**
 * The diagnostics projection of an exhaustion report. The report may lie
 * beyond the retained output, so every error that claims exhaustion carries
 * its source line, with the same omission flags as Ghidra's observed-marker
 * projection.
 */
export const runtimeExhaustionReport = ({
  runtime,
  area,
  stream,
  line,
  lineComplete,
  truncated,
  invalidUtf8,
}: RuntimeExhaustion): Readonly<Record<string, JsonValue>> => ({
  runtime,
  area: area ?? null,
  stream,
  line,
  line_complete: lineComplete,
  ...(truncated ? { truncated: true } : {}),
  ...(invalidUtf8 ? { invalid_utf8: true } : {}),
});
