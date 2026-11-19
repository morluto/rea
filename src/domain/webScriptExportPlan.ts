import type {
  CapturedWebScript,
  ExportedWebScript,
} from "./webScriptExport.js";
import { urlDeclaresQueryOrFragment } from "./urlComponents.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

// Literal URL path characters that are also portable filename characters.
// Percent escapes remain isolated: decoding them could change path identity.
const PORTABLE_SEGMENT = /^[A-Za-z0-9_~.!$&'()+,;=@-]+$/u;
const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** One planned file, or an explicit missing source with no filesystem effect. */
export interface PlannedWebScript {
  readonly script: CapturedWebScript;
  readonly record: ExportedWebScript;
}

/** Stable isolated identity shared by planning and destination collision fallback. */
export const isolatedWebScriptPath = (
  source: CapturedWebScript["source"],
  index: number,
): string =>
  `isolated/source-${index + 1}-${sha256Hex(JSON.stringify(source))}.js`;

/** Preserve safe URL layouts only when every captured path is unambiguous. */
export const planWebScriptExport = (
  scripts: readonly CapturedWebScript[],
): readonly PlannedWebScript[] => {
  const candidates = scripts.map(candidatePath);
  const conflicts = conflictingPaths(candidates);
  return scripts.map((script, index) => {
    if (script.content.state === "unavailable")
      return {
        script,
        record: {
          source: script.source,
          url: script.url,
          content: script.content,
        },
      };
    const candidate = candidates[index];
    const reason = conflicts.has(index)
      ? "Captured paths collide by content version or file/directory prefix."
      : (candidate?.reason ?? null);
    const path = reason === null ? candidate?.path : undefined;
    return {
      script,
      record: {
        source: script.source,
        url: script.url,
        content: {
          state: "exported",
          relative_path: path ?? isolatedWebScriptPath(script.source, index),
          layout: path === undefined ? "isolated" : "url-path",
          layout_reason: reason,
          sha256: script.content.sha256,
          bytes: script.content.bytes.length,
          media_type: script.content.media_type,
          redacted: script.content.redacted,
          representation: script.content.representation,
        },
      },
    };
  });
};

interface CandidatePath {
  readonly path?: string;
  readonly reason: string | null;
}

const candidatePath = (script: CapturedWebScript): CandidatePath => {
  let url: URL;
  try {
    url = new URL(script.url);
  } catch {
    return {
      reason: "Source has no absolute HTTP URL (for example an inline script).",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { reason: "Source URL scheme has no local module layout mapping." };
  const parts = url.pathname.slice(1).split("/");
  if (
    !/\.(?:js|mjs|cjs)$/u.test(url.pathname) ||
    parts.some(
      (part) =>
        !PORTABLE_SEGMENT.test(part) ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        RESERVED_SEGMENT.test(part),
    )
  )
    return {
      reason: "URL path is not an ordinary portable JavaScript module path.",
    };
  return {
    path: `origins/${sha256Hex(url.origin)}/${parts.join("/")}`,
    reason:
      urlDeclaresQueryOrFragment(url) ||
      url.username !== "" ||
      url.password !== ""
        ? "URL query, fragment, or credentials cannot select a canonical local module."
        : null,
  };
};

// Sort file paths with a separator that precedes every portable segment
// character. Repetitions and descendants then follow their file prefix
// contiguously, without allocating a string for every directory prefix.
const conflictingPaths = (
  candidates: readonly CandidatePath[],
): Set<number> => {
  const sorted = candidates.flatMap(({ path }, index) =>
    path === undefined ? [] : [{ key: path.replaceAll("/", "\0"), index }],
  );
  sorted.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const conflicts = new Set<number>();
  let root: (typeof sorted)[number] | undefined;
  for (const candidate of sorted) {
    if (
      root !== undefined &&
      (candidate.key === root.key ||
        (candidate.key.charCodeAt(root.key.length) === 0 &&
          candidate.key.startsWith(root.key)))
    ) {
      conflicts.add(root.index);
      conflicts.add(candidate.index);
    } else {
      root = candidate;
    }
  }
  return conflicts;
};
