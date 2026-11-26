// Imported directly by pre-install fixture scripts; keep this module dependency-free.
import { readFileSync } from "node:fs";

/** Audited upstream release; source remains unmodified in the Git submodule. */
export const JADX_RELEASE = Object.freeze({
  version: "0.8.0",
  revision: "2b2a560e8035169f75e3c4f1695e773f9c0eebd0",
  sha256: "4b9a01c23845c123c217840182d2b5f2c26a7ca20dec3d08810b310fc80a2372",
  url: "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.8.0/jadx-headless-mcp-0.8.0-all.jar",
});

/** Packaged single-file bridge source that REA copies and launches. */
export const JADX_BRIDGE_SOURCE_URL = new URL(
  "../../bridge/android/ReaJadxBridge.java",
  import.meta.url,
);

export interface JadxBridgeIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Java source as string and character literals, single characters, and one
 * space per comment, each with the brace depth it sits at (a brace carries the
 * depth outside it). Braces inside literals and comments are not counted. Text
 * blocks are not handled; the bridge source does not use them.
 */
function* javaPieces(
  source: string,
): Generator<{ readonly text: string; readonly depth: number }> {
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1];
    let end = index + 1;
    let text = character;
    if (character === "/" && (next === "/" || next === "*")) {
      const close =
        next === "/"
          ? source.indexOf("\n", index)
          : source.indexOf("*/", index + 2);
      end = close === -1 ? source.length : next === "/" ? close : close + 2;
      text = " ";
    } else if (character === '"' || character === "'") {
      while (end < source.length && source[end] !== character)
        end += source[end] === "\\" ? 2 : 1;
      end += 1;
      text = source.slice(index, end);
    }
    if (text === "}") depth -= 1;
    yield { text, depth };
    if (text === "{") depth += 1;
    index = end;
  }
}

/**
 * The body of the top-level class named `className`, with comments removed and
 * nested bodies blanked, so only that class's own member declarations remain.
 * Other top-level types in the same file are ignored.
 */
const topLevelClassMembers = (
  source: string,
  className: string,
): JadxBridgeSourceRead<string> => {
  const declaresClass = new RegExp(
    String.raw`(?:^|\s)class\s+${className}(?![\w$])`,
    "u",
  );
  let members = "";
  let header = "";
  let inClass = false;
  let classBodies = 0;
  for (const { text, depth } of javaPieces(source)) {
    if (depth === 0 && text === "{") {
      // A top-level type body opens; its header names the type.
      inClass = declaresClass.test(header);
      if (inClass) classBodies += 1;
      header = "";
    } else if (depth === 0)
      header = text === ";" || text === "}" ? "" : header + text;
    else if (depth === 1 && inClass)
      members += text === "{" || text === "}" ? " " : text;
  }
  return classBodies === 1
    ? { ok: true, value: members }
    : {
        ok: false,
        error: `REA's JADX bridge source must declare top-level class ${className} exactly once; found ${String(classBodies)}`,
      };
};

const declaredString = (
  members: string,
  constant: string,
): JadxBridgeSourceRead<string> => {
  const matches = [
    ...members.matchAll(
      new RegExp(
        String.raw`(?:^|[;\s])(?:(?:public|protected|private|static|final)\s+)*String\s+${constant}\s*=\s*"([A-Za-z0-9._-]+)"\s*;`,
        "gu",
      ),
    ),
  ];
  const value = matches.length === 1 ? matches[0]?.[1] : undefined;
  return value === undefined
    ? {
        ok: false,
        error: `REA's JADX bridge source must declare ${constant} exactly once; found ${String(matches.length)}`,
      }
    : { ok: true, value };
};

/**
 * A read of REA's own packaged bridge source, shaped like `Result` from
 * src/domain/result.ts. This module is loaded by fixture scripts without a
 * build, so it cannot import that module.
 */
export type JadxBridgeSourceRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Read the bridge identity the bridge source itself declares. */
export const parseJadxBridgeIdentity = (
  source: string,
): JadxBridgeSourceRead<JadxBridgeIdentity> => {
  const members = topLevelClassMembers(source, "ReaJadxBridge");
  if (!members.ok) return members;
  const name = declaredString(members.value, "BRIDGE_NAME");
  if (!name.ok) return name;
  const version = declaredString(members.value, "BRIDGE_VERSION");
  if (!version.ok) return version;
  return {
    ok: true,
    value: Object.freeze({ name: name.value, version: version.value }),
  };
};

let bridgeIdentity: JadxBridgeSourceRead<JadxBridgeIdentity> | undefined;

/**
 * Identity of REA's metadata bridge, distinct from the producing engine. The
 * bridge source owns it; REA reads it from the packaged copy it launches, so a
 * version bump cannot be made in one place and missed in the other.
 */
export const jadxBridgeIdentity =
  (): JadxBridgeSourceRead<JadxBridgeIdentity> => {
    bridgeIdentity ??= parseJadxBridgeIdentity(
      readFileSync(JADX_BRIDGE_SOURCE_URL, "utf8"),
    );
    return bridgeIdentity;
  };

/** Remediation when `REA_JADX_MCP_JAR` is missing or not an absolute path. */
export const JADX_JAR_CONFIGURATION_REMEDIATION = `Download the jadx-headless-mcp ${JADX_RELEASE.version} release JAR from ${JADX_RELEASE.url}, verify SHA-256 ${JADX_RELEASE.sha256}, and set REA_JADX_MCP_JAR to its absolute path. REA does not download or install it.`;

/** Remediation when the selected Java runtime cannot satisfy the JADX bridge. */
export const JADX_JAVA_RUNTIME_REMEDIATION =
  "Select a full JDK including jdk.compiler via JAVA_HOME or PATH, then verify it with java --list-modules. REA does not install Java.";

/** Remediation when a JADX JVM resource override is malformed. */
export const JADX_JVM_OPTIONS_REMEDIATION =
  "Set REA_JADX_HEAP_MIB to a positive integer (heap size in MiB) and REA_JADX_ACTIVE_PROCESSOR_COUNT to a positive integer within the JVM's signed 32-bit range.";

/**
 * Remediation for a JADX worker heap shortage, whether the bridge reported it or
 * the launcher stopped before answering. REA passes REA_JADX_HEAP_MIB as an
 * explicit command-line -Xmx, which outranks JAVA_TOOL_OPTIONS and
 * JDK_JAVA_OPTIONS, while _JAVA_OPTIONS outranks the command line.
 */
export const JADX_HEAP_REMEDIATION =
  "Increase REA_JADX_HEAP_MIB (MiB) in the environment that starts REA, within the host or container memory budget. REA passes it as an explicit -Xmx, so JAVA_TOOL_OPTIONS and JDK_JAVA_OPTIONS set the heap only while it is unset, and _JAVA_OPTIONS overrides it. An observed heap is this run's limit, not the heap the APK requires.";

/** Remediation when the host cannot run the Android JADX subprocess. */
export const JADX_UNSUPPORTED_HOST_REMEDIATION =
  "Use Linux, macOS, or Windows x64 with its bundled native controls for Android JADX analysis.";

/** Remediation when the Windows native backend cannot take process ownership. */
export const JADX_WINDOWS_NATIVE_REMEDIATION =
  "Use a matching current Windows x64 REA package with its bundled native controls. The native failure above identifies the failed constraint; Java installation or registration changes cannot enable a missing native backend.";

/** Remediation when the Java module-listing probe cannot establish the runtime. */
export const JADX_JAVA_PROBE_REMEDIATION =
  "Verify the selected Java launcher with java --list-modules: it must start promptly and emit a concise module listing including a parseable java.base version. REA does not install Java.";

/** Producing engine identity used by Evidence and the generated product catalog. */
export const JADX_PROVIDER_IDENTITY = Object.freeze({
  id: "jadx",
  name: "JADX headless",
  version: JADX_RELEASE.version,
});

/** Audited engine coverage, kept outside portable Android semantics. */
export const JADX_LIMITATIONS = [
  "Static decompiler observations do not establish runtime behavior; the APK is never executed.",
  "Method signatures use provider display types; DEX prototypes come from frozen JADX metadata. Display names may be aliases, and overload indices are local to this engine and artifact.",
  "Class inventories use parsed metadata before code generation, including synthetic members that may be omitted from decompiled source. Source positions remain unknown.",
  "Incoming reference totals count JADX using nodes. Direct invoke entries within a using method report raw DEX code-unit offsets and method indexes, but coverage is limited to those nodes and directly matched invokes; it does not establish every possible dynamic or reflective call site.",
  "Manifest summaries are parsed once by REA's bridge from the exact root AndroidManifest.xml resource, using namespace-aware XML attributes; decoded XML is retained. These summaries do not verify APK signatures, split APKs or Android runtime capture.",
] as const;
