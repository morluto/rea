import { createHash } from "node:crypto";

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";

import { zipArchiveFaultKind } from "../resources/index.js";

import {
  browserExtensionSchema,
  MAX_BROWSER_EXTENSION_MESSAGE_KEYS,
  type BrowserExtensionReport,
  type InspectBrowserExtensionInput,
} from "../domain/browserExtension/browserExtension.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MESSAGE_KEY = /__MSG_([A-Za-z0-9_@]+)__/gu;
const KNOWN_KEYS = new Set([
  "manifest_version",
  "name",
  "version",
  "description",
  "default_locale",
  "permissions",
  "optional_permissions",
  "host_permissions",
  "optional_host_permissions",
  "content_scripts",
  "background",
  "browser_specific_settings",
  "applications",
  "action",
  "browser_action",
  "page_action",
  "content_security_policy",
  "incognito",
  "side_panel",
  "commands",
  "web_accessible_resources",
  "externally_connectable",
]);

/** Which caller or projection bound a limit failure refers to. */
export type BrowserExtensionLimit =
  | "max_entries"
  | "max_manifest_bytes"
  | "max_file_bytes"
  | "fixed";

/** A package or manifest failed a format or budget boundary before a report existed. */
export class BrowserExtensionParseError extends Error {
  constructor(
    readonly code: "format" | "limit",
    readonly resource: "file-size" | "capacity" | null,
    message: string,
    readonly limits?: Readonly<Record<string, number>>,
    readonly limit: BrowserExtensionLimit = "fixed",
  ) {
    super(message);
    this.name = "BrowserExtensionParseError";
  }
}

interface ArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const abortIfNeeded = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
};

const u32 = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! |
  (bytes[offset + 1]! << 8) |
  (bytes[offset + 2]! << 16) |
  (bytes[offset + 3]! << 24);

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

const isCrx = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x43 &&
  bytes[1] === 0x72 &&
  bytes[2] === 0x32 &&
  bytes[3] === 0x34;

const formatError = (message: string): BrowserExtensionParseError =>
  new BrowserExtensionParseError("format", null, message);

const limitError = (
  resource: "file-size" | "capacity",
  message: string,
  limits: Readonly<Record<string, number>>,
  limit: BrowserExtensionParseError["limit"] = resource === "file-size"
    ? "max_manifest_bytes"
    : "fixed",
): BrowserExtensionParseError =>
  new BrowserExtensionParseError("limit", resource, message, limits, limit);

const zipParseError = (cause: unknown): unknown => {
  if (
    cause instanceof BrowserExtensionParseError ||
    (cause instanceof DOMException && cause.name === "AbortError")
  )
    return cause;
  const kind = zipArchiveFaultKind(cause);
  if (kind === undefined || !(cause instanceof Error)) return cause;
  return formatError(
    kind === "format"
      ? `ZIP archive is malformed: ${cause.message}`
      : `ZIP archive uses an unsupported feature: ${cause.message}`,
  );
};

const stringField = (
  value: unknown,
  label: string,
  maxLength = 8192,
): string | null => {
  if (value === undefined) return null;
  if (typeof value !== "string") throw formatError(`${label} is not a string.`);
  if (value.length > maxLength)
    throw formatError(`${label} exceeds ${String(maxLength)} characters.`);
  return value;
};

const stringArray = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw formatError(`${label} is not an array.`);
  if (value.length > 10000)
    throw limitError("capacity", `${label} exceeds 10000 entries.`, {
      max_items: 10000,
    });
  return value.map((item, index) => {
    if (typeof item !== "string")
      throw formatError(`${label}[${String(index)}] is not a string.`);
    if (item.length > 8192)
      throw formatError(`${label}[${String(index)}] exceeds 8192 characters.`);
    return item;
  });
};

/**
 * Collect `__MSG_*__` placeholders from every string in the admitted manifest.
 * The manifest byte budget bounds the iterative walk. Keep only distinct keys
 * and enforce their contract limit during collection, before allocating a report.
 */
const messageKeysInManifest = (manifest: Record<string, unknown>): string[] => {
  const keys = new Set<string>();
  const queue: unknown[] = Object.values(manifest);
  for (let index = 0; index < queue.length; index += 1) {
    const value = queue[index];
    if (typeof value === "string") {
      for (const match of value.matchAll(MESSAGE_KEY)) {
        const key = match[1];
        if (key === undefined) continue;
        keys.add(key);
        if (keys.size > MAX_BROWSER_EXTENSION_MESSAGE_KEYS)
          throw limitError(
            "capacity",
            `message keys exceeds ${String(MAX_BROWSER_EXTENSION_MESSAGE_KEYS)} entries.`,
            {
              max_items: MAX_BROWSER_EXTENSION_MESSAGE_KEYS,
              observed_items: keys.size,
            },
          );
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) queue.push(item);
      continue;
    }
    if (value !== null && typeof value === "object")
      for (const item of Object.values(value)) queue.push(item);
  }
  return [...keys];
};

const boundedList = (
  values: readonly string[],
  max: number,
  label: string,
): string[] => {
  if (values.length > max)
    throw limitError(
      "capacity",
      `${label} exceeds ${String(max)} entries.`,
      { max_items: max, observed_items: values.length },
      "fixed",
    );
  return [...values];
};

interface ContainerFacts {
  readonly format: "crx2" | "crx3" | "zip";
  readonly zip: Uint8Array;
  readonly container: NonNullable<BrowserExtensionReport["container"]>;
}

const containerFrom = (bytes: Uint8Array): ContainerFacts | null => {
  if (isCrx(bytes)) {
    if (bytes.length < 16)
      throw formatError("CRX header is shorter than 16 bytes.");
    const version = u32(bytes, 4) >>> 0;
    if (version === 3) {
      const headerBytes = u32(bytes, 8) >>> 0;
      const zipOffset = 12 + headerBytes;
      if (headerBytes > bytes.length - 12 || zipOffset > bytes.length)
        throw formatError("CRX3 header length exceeds the file.");
      return {
        format: "crx3",
        zip: bytes.subarray(zipOffset),
        container: {
          zip_offset: zipOffset,
          header_bytes: zipOffset,
          crx_version: 3,
          public_key_bytes: null,
          signature_bytes: null,
        },
      };
    }
    if (version === 2) {
      const publicKeyBytes = u32(bytes, 8) >>> 0;
      const signatureBytes = u32(bytes, 12) >>> 0;
      const zipOffset = 16 + publicKeyBytes + signatureBytes;
      if (
        publicKeyBytes > bytes.length ||
        signatureBytes > bytes.length - publicKeyBytes ||
        zipOffset > bytes.length
      )
        throw formatError("CRX2 key or signature length exceeds the file.");
      return {
        format: "crx2",
        zip: bytes.subarray(zipOffset),
        container: {
          zip_offset: zipOffset,
          header_bytes: zipOffset,
          crx_version: 2,
          public_key_bytes: publicKeyBytes,
          signature_bytes: signatureBytes,
        },
      };
    }
    throw formatError(
      `CRX version ${String(version)} is not a supported CRX2 or CRX3 container.`,
    );
  }
  if (isZip(bytes))
    return {
      format: "zip",
      zip: bytes,
      container: {
        zip_offset: 0,
        header_bytes: 0,
        crx_version: null,
        public_key_bytes: null,
        signature_bytes: null,
      },
    };
  return null;
};

const fileEntry = (entry: Entry): FileEntry => {
  if (entry.directory) throw formatError("manifest.json is a directory entry.");
  return entry as FileEntry;
};

const readManifestEntry = async (
  zip: Uint8Array,
  input: InspectBrowserExtensionInput,
  signal: AbortSignal | undefined,
): Promise<{ readonly path: string; readonly bytes: Uint8Array }> => {
  abortIfNeeded(signal);
  const reader = new ZipReader(new Uint8ArrayReader(zip));
  try {
    const entries: Entry[] = [];
    let observed = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      abortIfNeeded(signal);
      observed += 1;
      if (observed > input.max_entries)
        throw limitError(
          "capacity",
          `ZIP central directory exceeded ${String(input.max_entries)} entries.`,
          { max_entries: input.max_entries, observed_entries: observed },
          "max_entries",
        );
      entries.push(entry);
    }
    abortIfNeeded(signal);
    const roots = entries.filter((entry) => entry.filename === "manifest.json");
    if (roots.length > 1)
      throw formatError("The archive has multiple root manifest.json entries.");
    const exact = roots[0];
    const nested = entries.filter((entry) =>
      entry.filename.endsWith("/manifest.json"),
    );
    if (exact === undefined) {
      const observedPaths =
        nested.length === 0
          ? "no manifest.json entry"
          : `nested ${nested
              .slice(0, 3)
              .map((entry) => entry.filename)
              .join(", ")}`;
      throw formatError(
        `The archive has no root manifest.json (${observedPaths}).`,
      );
    }
    const selected = fileEntry(exact);
    if (selected.encrypted)
      throw formatError("manifest.json is encrypted and was not read.");
    if (selected.uncompressedSize > input.max_manifest_bytes)
      throw limitError(
        "file-size",
        `manifest.json declares ${String(selected.uncompressedSize)} uncompressed bytes.`,
        {
          max_manifest_bytes: input.max_manifest_bytes,
          declared_bytes: selected.uncompressedSize,
        },
        "max_manifest_bytes",
      );
    const bytes = await selected.getData(new Uint8ArrayWriter(), {
      ...(signal === undefined ? {} : { signal }),
      checkSignature: true,
    });
    abortIfNeeded(signal);
    if (bytes.length > input.max_manifest_bytes)
      throw limitError(
        "file-size",
        `manifest.json expanded to ${String(bytes.length)} bytes.`,
        {
          max_manifest_bytes: input.max_manifest_bytes,
          observed_bytes: bytes.length,
        },
        "max_manifest_bytes",
      );
    return { path: "manifest.json", bytes };
  } catch (cause) {
    throw zipParseError(cause);
  } finally {
    await reader.close();
  }
};

const objectField = (
  value: unknown,
  label: string,
): Record<string, unknown> | null => {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw formatError(`${label} is not an object.`);
  return value as Record<string, unknown>;
};

const booleanOrNull = (value: unknown, label: string): boolean | null => {
  if (value === undefined) return null;
  if (typeof value !== "boolean")
    throw formatError(`${label} is not a boolean.`);
  return value;
};

const contentScripts = (value: unknown) => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw formatError("content_scripts is not an array.");
  if (value.length > 1000)
    throw limitError("capacity", "content_scripts exceeds 1000 entries.", {
      max_items: 1000,
    });
  return value.map((item, index) => {
    const label = `content_scripts[${String(index)}]`;
    const record = objectField(item, label);
    if (record === null) throw formatError(`${label} is not an object.`);
    return {
      matches: stringArray(record.matches, `${label}.matches`),
      exclude_matches: stringArray(
        record.exclude_matches,
        `${label}.exclude_matches`,
      ),
      js: stringArray(record.js, `${label}.js`),
      css: stringArray(record.css, `${label}.css`),
      run_at: stringField(record.run_at, `${label}.run_at`),
      world: stringField(record.world, `${label}.world`),
      all_frames: booleanOrNull(record.all_frames, `${label}.all_frames`),
    };
  });
};

const background = (value: unknown) => {
  const record = objectField(value, "background");
  if (record === null) return null;
  const serviceWorker = stringField(
    record.service_worker,
    "background.service_worker",
  );
  const scripts = stringArray(record.scripts, "background.scripts");
  const page = stringField(record.page, "background.page");
  const kind =
    serviceWorker !== null
      ? "service_worker"
      : scripts.length > 0
        ? "scripts"
        : page !== null
          ? "page"
          : "unknown";
  return {
    kind,
    service_worker: serviceWorker,
    scripts,
    page,
    persistent: booleanOrNull(record.persistent, "background.persistent"),
    type: stringField(record.type, "background.type"),
  } as const;
};

const contentSecurityPolicy = (value: unknown) => {
  if (value === undefined) return null;
  if (typeof value === "string") {
    if (value.length > 65536)
      throw formatError("content_security_policy exceeds 65536 characters.");
    return { kind: "string" as const, value };
  }
  const record = objectField(value, "content_security_policy");
  if (record === null) return null;
  const extensionPages = stringField(
    record.extension_pages,
    "content_security_policy.extension_pages",
    65536,
  );
  const sandbox = stringField(
    record.sandbox,
    "content_security_policy.sandbox",
    65536,
  );
  return {
    kind: "object" as const,
    extension_pages: extensionPages,
    sandbox,
  };
};

const webAccessibleResources = (value: unknown) => {
  if (value === undefined) return null;
  if (!Array.isArray(value))
    throw formatError("web_accessible_resources is not an array.");
  if (value.length === 0) return { kind: "paths" as const, resources: [] };
  if (value.every((item) => typeof item === "string"))
    return {
      kind: "paths" as const,
      resources: stringArray(value, "web_accessible_resources"),
    };
  if (value.length > 1000)
    throw limitError(
      "capacity",
      "web_accessible_resources exceeds 1000 entries.",
      { max_items: 1000 },
    );
  return {
    kind: "entries" as const,
    entries: value.map((item, index) => {
      const label = `web_accessible_resources[${String(index)}]`;
      const record = objectField(item, label);
      if (record === null) throw formatError(`${label} is not an object.`);
      return {
        resources: stringArray(record.resources, `${label}.resources`),
        matches: stringArray(record.matches, `${label}.matches`),
      };
    }),
  };
};

const geckoFrom = (manifest: Record<string, unknown>) => {
  const modern = objectField(
    objectField(manifest.browser_specific_settings, "browser_specific_settings")
      ?.gecko,
    "browser_specific_settings.gecko",
  );
  const legacy = objectField(
    objectField(manifest.applications, "applications")?.gecko,
    "applications.gecko",
  );
  if (modern === null && legacy === null) return null;
  const modernId = modern === null ? null : stringField(modern.id, "gecko.id");
  const legacyId = legacy === null ? null : stringField(legacy.id, "gecko.id");
  const selected = modern ?? legacy;
  if (selected === null) return null;
  return {
    id: modernId ?? legacyId,
    id_source:
      modernId !== null
        ? ("browser_specific_settings" as const)
        : legacyId !== null
          ? ("applications" as const)
          : null,
    strict_min_version: stringField(
      selected.strict_min_version,
      "gecko.strict_min_version",
    ),
    strict_max_version: stringField(
      selected.strict_max_version,
      "gecko.strict_max_version",
    ),
    conflicting_id:
      modernId !== null && legacyId !== null && modernId !== legacyId
        ? legacyId
        : null,
  };
};

const actionKeys = (
  manifest: Record<string, unknown>,
): Array<"action" | "browser_action" | "page_action"> => {
  const keys: Array<"action" | "browser_action" | "page_action"> = [];
  for (const key of ["action", "browser_action", "page_action"] as const) {
    const record = objectField(manifest[key], key);
    if (record !== null) {
      stringField(record.default_title, `${key}.default_title`);
      keys.push(key);
    }
  }
  return keys;
};

const projectManifest = (
  bytes: Uint8Array,
  path: string,
): BrowserExtensionReport["manifest"] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch (cause) {
    throw formatError(
      cause instanceof Error
        ? `manifest.json is not UTF-8 JSON: ${cause.message}`
        : "manifest.json is not UTF-8 JSON.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw formatError("manifest.json is not a JSON object.");
  const manifest = parsed as Record<string, unknown>;
  const version = manifest.manifest_version;
  const manifestVersion =
    version === 2 || version === 3 ? version : ("other" as const);
  if (
    version !== undefined &&
    typeof version !== "number" &&
    typeof version !== "string"
  )
    throw formatError("manifest_version is not a number or string.");
  const name = stringField(manifest.name, "name");
  const description = stringField(manifest.description, "description");
  const commands = objectField(manifest.commands, "commands");
  const externally = objectField(
    manifest.externally_connectable,
    "externally_connectable",
  );
  return {
    path,
    sha256: sha256(bytes),
    bytes: bytes.length,
    manifest_version: manifestVersion,
    name,
    version: stringField(manifest.version, "version"),
    description,
    default_locale: stringField(manifest.default_locale, "default_locale"),
    message_keys: messageKeysInManifest(manifest),
    permissions: stringArray(manifest.permissions, "permissions"),
    optional_permissions: stringArray(
      manifest.optional_permissions,
      "optional_permissions",
    ),
    host_permissions: stringArray(
      manifest.host_permissions,
      "host_permissions",
    ),
    optional_host_permissions: stringArray(
      manifest.optional_host_permissions,
      "optional_host_permissions",
    ),
    content_scripts: contentScripts(manifest.content_scripts),
    background: background(manifest.background),
    gecko: geckoFrom(manifest),
    action_keys: actionKeys(manifest),
    content_security_policy: contentSecurityPolicy(
      manifest.content_security_policy,
    ),
    incognito: stringField(manifest.incognito, "incognito"),
    side_panel: manifest.side_panel !== undefined,
    commands: boundedList(
      commands === null ? [] : Object.keys(commands),
      10000,
      "commands",
    ),
    web_accessible_resources: webAccessibleResources(
      manifest.web_accessible_resources,
    ),
    externally_connectable_matches:
      externally === null
        ? []
        : stringArray(externally.matches, "externally_connectable.matches"),
    unknown_keys: Object.keys(manifest)
      .filter((key) => !KNOWN_KEYS.has(key))
      .sort((left, right) => left.localeCompare(right)),
  };
};

const limitationsFor = (
  format: BrowserExtensionReport["format"],
  manifest: BrowserExtensionReport["manifest"],
): string[] => {
  const limitations = [
    "Declared manifest fields are observed text. They do not establish runtime requests, grants, or execution.",
    "Extension JavaScript, HTML, and locales were not parsed.",
  ];
  if (format === "crx2" || format === "crx3")
    limitations.push(
      "CRX header lengths were measured and the signature was not verified.",
    );
  if (format !== "unpacked")
    limitations.push(
      "Only the root manifest.json entry was read. Other archive members remain unexamined.",
    );
  if (manifest.message_keys.length > 0)
    limitations.push(
      "Message placeholders were left unresolved. Locale catalogs were not opened.",
    );
  if (manifest.manifest_version === "other")
    limitations.push(
      "manifest_version is not 2 or 3. Field presence is still reported, without inferring a browser runtime.",
    );
  if (manifest.gecko?.conflicting_id !== null && manifest.gecko !== null)
    limitations.push(
      "browser_specific_settings.gecko.id and applications.gecko.id differ. The modern id is reported; the legacy id is conflicting_id.",
    );
  if (manifest.action_keys.length > 1)
    limitations.push(
      "More than one action key is present. All observed keys are listed; no precedence was applied.",
    );
  return limitations;
};

/**
 * Project a CRX, ZIP/XPI, or unpacked manifest.json into an extension surface.
 * Does not write files, contact a network, or load the extension.
 */
export const parseBrowserExtension = async (
  bytes: Uint8Array,
  artifact: ArtifactIdentity,
  input: InspectBrowserExtensionInput,
  signal?: AbortSignal,
): Promise<BrowserExtensionReport> => {
  abortIfNeeded(signal);
  if (bytes.length !== artifact.bytes)
    throw formatError(
      "Artifact byte length does not match the admitted snapshot.",
    );
  const container = containerFrom(bytes);
  if (container !== null && !isZip(container.zip))
    throw formatError(
      container.zip.length === 0
        ? "Package payload is empty."
        : "Package payload is not a ZIP archive.",
    );
  const manifestBytes =
    container === null
      ? { path: "manifest.json", bytes }
      : await readManifestEntry(container.zip, input, signal);
  if (container === null) {
    const normalized = artifact.path.replaceAll("\\", "/");
    const base = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (base !== "manifest.json")
      throw formatError(
        "The file is not a CRX or ZIP package, and it is not named manifest.json.",
      );
    if (bytes.length > input.max_manifest_bytes)
      throw limitError(
        "file-size",
        `manifest.json contains ${String(bytes.length)} bytes.`,
        {
          max_manifest_bytes: input.max_manifest_bytes,
          observed_bytes: bytes.length,
        },
        "max_manifest_bytes",
      );
  }
  const manifest = projectManifest(manifestBytes.bytes, manifestBytes.path);
  const format = container?.format ?? "unpacked";
  const report = {
    artifact,
    format,
    container: container?.container ?? null,
    manifest,
    limitations: limitationsFor(format, manifest),
  };
  const parsed = browserExtensionSchema.safeParse(report);
  if (!parsed.success)
    throw formatError(
      "Extension projection does not match its output contract.",
    );
  return parsed.data;
};
