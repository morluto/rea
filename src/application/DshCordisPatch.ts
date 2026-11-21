import { validateRegistrationEnvironment } from "./RegistrationEnvironmentValidation.js";
import { isMap, isSeq, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import type { Environment } from "../config/environment.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";
import { CordisExpression, DshCordisYaml } from "./DshCordisYaml.js";
import { mergeEnvironmentOverrides } from "../process/snapshotEnvironment.js";
import { isRecord } from "../kernel/isRecord.js";

export const DSH_ENTRY_ID = "rea-mcp";
export const DSH_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const LAUNCHER_KEYS = new Set(["serverName", "transport", "command", "args"]);
const SELECTOR_KEYS = new Set(["id", "name"]);
const isPatchRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !(value instanceof CordisExpression);

interface PatchOperation {
  readonly source: unknown;
  readonly map: YAMLMap<unknown, unknown>;
  readonly insertion: OwnedInsertion | undefined;
  readonly direct: boolean;
}

interface OwnedInsertion {
  readonly list: YAMLSeq<unknown>;
  readonly ownedRows: ReadonlyMap<number, YAMLMap<unknown, unknown>>;
  readonly groups: ReadonlyMap<number, OwnedInsertion>;
}

/** One interpretation of identity, ordered patch applicability and source nodes. */
export class DshCordisDocument {
  readonly #yaml: DshCordisYaml;
  readonly #operations: readonly PatchOperation[];
  readonly #fields = new Map<string, unknown>();
  #entryNode: YAMLMap<unknown, unknown> | undefined;
  readonly #insertions: number;
  #unknownSelector = false;
  #unknownStructure = false;
  #malformedStructure = false;
  readonly #editabilityError: ConfigurationError | undefined;
  readonly config: Record<string, unknown> | undefined;

  constructor(text: string) {
    this.#yaml = new DshCordisYaml(text);
    const root = this.#yaml.document.contents;
    if (!isSeq(root))
      throw new ConfigurationError("Cordis patches must be a list");
    const operations: PatchOperation[] = [];
    let insertions = 0;
    let groupOwnership: string | undefined;
    for (const source of root.items) {
      const map = this.#map(source);
      if (map === undefined) {
        if (this.#yaml.value(source) instanceof CordisExpression)
          this.#unknownStructure = true;
        else this.#malformedStructure = true;
        continue;
      }
      const inserted = this.#yaml.resolve(this.#yaml.field(map, "insert"));
      const targetId = this.#id(map);
      const direct = !isSeq(inserted) && targetId === DSH_ENTRY_ID;
      const insertion = isSeq(inserted)
        ? this.#inspectInsertion(inserted)
        : undefined;
      const insertedValue = this.#yaml.value(inserted);
      if (insertedValue instanceof CordisExpression)
        this.#unknownStructure = true;
      else if (insertedValue != null && !isSeq(inserted))
        this.#malformedStructure = true;
      operations.push({ source, map, insertion, direct });
      if (insertion !== undefined) {
        if (targetId !== undefined)
          groupOwnership = "targets a group with unknown activity";
        else if (insertion.groups.size > 0)
          groupOwnership ??= "is nested in a group";
        for (const entry of insertion.ownedRows.values()) {
          insertions += 1;
          this.#entryNode = entry;
          this.#fields.clear();
          this.#unknownSelector = false;
          this.#readFields(entry);
        }
      } else if (direct) {
        if (insertions === 0) continue;
        // Cordis uses name as a selector, not a rename operation.
        const selector = this.#yaml.value(this.#yaml.field(map, "name"));
        if (
          selector instanceof CordisExpression ||
          (selector && this.#field("name") instanceof CordisExpression)
        ) {
          this.#unknownSelector = true;
          continue;
        }
        if (selector && selector !== this.#field("name")) continue;
        this.#readFields(map, new Set(["id", "name"]));
      }
    }
    this.#operations = operations;
    this.#insertions = insertions;
    this.#editabilityError = this.#unknownStructure
      ? new ConfigurationError(
          "Expression-backed Cordis patches have unknown structure; use literal patches before setup",
        )
      : this.#malformedStructure
        ? new ConfigurationError(
            "Malformed Cordis patches cannot be edited safely; use mapping entries and insert lists before setup",
          )
        : groupOwnership !== undefined
          ? new ConfigurationError(
              `Cordis REA insertion ${groupOwnership}; use a direct insertion before setup`,
            )
          : this.#unknownSelector
            ? new ConfigurationError(
                "Expression-backed Cordis name selectors have unknown applicability; use literal selectors before setup",
                {
                  settings: [
                    {
                      setting: "name",
                      constraint: "Use literal selectors before setup",
                    },
                  ],
                },
              )
            : undefined;
    const config = this.#field("config");
    // Ownership survives malformed config so uninstall can remove the source row.
    this.config =
      insertions === 0 ? undefined : isPatchRecord(config) ? config : {};
  }

  #map(node: unknown): YAMLMap<unknown, unknown> | undefined {
    const map = this.#yaml.resolve(node);
    return isMap(map) ? map : undefined;
  }
  #inspectInsertion(list: YAMLSeq<unknown>): OwnedInsertion | undefined {
    const ownedRows = new Map<number, YAMLMap<unknown, unknown>>();
    const groups = new Map<number, OwnedInsertion>();
    for (const [index, source] of list.items.entries()) {
      const row = this.#map(source);
      if (row === undefined) {
        if (this.#yaml.value(source) instanceof CordisExpression)
          this.#unknownStructure = true;
        else this.#malformedStructure = true;
        continue;
      }
      if (this.#id(row) === DSH_ENTRY_ID) {
        ownedRows.set(index, row);
        continue;
      }
      // Only a Cordis group gives its config list entry identity.
      if (this.#yaml.value(this.#yaml.field(row, "group")) !== true) continue;
      const config = this.#yaml.resolve(this.#yaml.field(row, "config"));
      if (!isSeq(config)) continue;
      const nested = this.#inspectInsertion(config);
      if (nested !== undefined) groups.set(index, nested);
    }
    return ownedRows.size > 0 || groups.size > 0
      ? { list, ownedRows, groups }
      : undefined;
  }

  #id(map: YAMLMap | undefined): unknown {
    const id = this.#yaml.value(this.#yaml.field(map, "id"));
    if (id instanceof CordisExpression)
      throw new ConfigurationError(
        "Expression-backed Cordis IDs have unknown ownership; use literal IDs before changing registrations",
      );
    return id;
  }
  #field(key: string): unknown {
    return this.#yaml.value(this.#fields.get(key));
  }
  #readFields(
    map: YAMLMap<unknown, unknown>,
    omitted: ReadonlySet<string> = new Set(),
  ): void {
    for (const pair of map.items) {
      const key = this.#yaml.value(pair.key);
      if (typeof key === "string" && !omitted.has(key))
        this.#fields.set(key, pair.value);
    }
  }
  get carriesEntry(): boolean {
    return this.#operations.some(
      (op) => op.direct || op.insertion !== undefined,
    );
  }
  get hasUnknownStructure(): boolean {
    return this.#unknownStructure;
  }
  get editabilityError(): ConfigurationError | undefined {
    return this.#editabilityError;
  }
  get ready(): boolean {
    const disabled = this.#field("disabled");
    return (
      this.#insertions === 1 &&
      this.#editabilityError === undefined &&
      this.#field("name") === DSH_CLIENT_PACKAGE &&
      (disabled === undefined || disabled === false)
    );
  }

  /** Validate literals without treating expression source as an environment value. */
  environment(
    overrides: Readonly<Record<string, string>>,
    validation: "fragment" | "effective",
    platform: NodeJS.Platform,
  ): Result<
    {
      readonly values: Readonly<Record<string, string>>;
      readonly configuration: Environment;
      readonly unresolvedSettings: ReadonlySet<string>;
    },
    ConfigurationError
  > {
    const config = this.#field("config");
    if (config instanceof CordisExpression)
      return err(
        new ConfigurationError(
          "Expression-backed Cordis config cannot be safely edited",
          {
            settings: [
              {
                setting: "config",
                constraint:
                  "Use a literal mapping to preserve caller fields during setup",
              },
            ],
          },
        ),
      );
    if (config !== undefined && !isPatchRecord(config))
      return err(
        new ConfigurationError("Cordis REA config must be a mapping", {
          settings: [
            {
              setting: "config",
              constraint: "Use a literal mapping before setup",
            },
          ],
        }),
      );
    const raw = this.config?.env;
    if (raw !== undefined && !isPatchRecord(raw))
      return err(
        new ConfigurationError("Cordis server environment must be a mapping"),
      );
    const literals: Record<string, string> = Object.create(null);
    const unresolvedSettings = new Set<string>();
    for (const [key, value] of Object.entries(
      mergeEnvironmentOverrides<unknown>(raw ?? {}, overrides, platform),
    )) {
      if (value instanceof CordisExpression) {
        unresolvedSettings.add(key);
        continue;
      }
      if (typeof value !== "string")
        return err(
          new ConfigurationError("Invalid Cordis server environment", {
            settings: [
              {
                setting: `env.${key}`,
                constraint:
                  "Environment values must be strings or Cordis expressions",
              },
            ],
          }),
        );
      literals[key] = value;
    }
    const validated = validateRegistrationEnvironment(
      literals,
      unresolvedSettings,
      validation,
      platform,
    );
    return validated.ok
      ? ok({ values: literals, ...validated.value })
      : validated;
  }

  desired(
    command: readonly string[],
    overrides: Readonly<Record<string, string>>,
    platform: NodeJS.Platform,
    toolCallTimeoutMs?: number,
  ): Result<Record<string, unknown>, ConfigurationError> {
    if (this.#editabilityError !== undefined)
      return err(this.#editabilityError);
    const environment = this.environment(overrides, "effective", platform);
    if (!environment.ok) return environment;
    const env = mergeEnvironmentOverrides<unknown>(
      isPatchRecord(this.config?.env) ? this.config.env : {},
      overrides,
      platform,
    );
    const desired = { ...this.config, ...dshClientRegistrationEntry(command) };
    delete desired.env;
    if (Object.keys(env).length > 0) desired.env = env;
    if (
      toolCallTimeoutMs !== undefined &&
      dshToolCallTimeout(this.config?.toolCallTimeoutMs) === undefined
    )
      desired.toolCallTimeoutMs = toolCallTimeoutMs;
    return ok(desired);
  }

  /** Plan every replacement from source snapshots before changing an output tree. */
  serialize(edit?: DshCordisRegistration): string {
    const desired = edit?.desired;
    if (
      this.#editabilityError !== undefined &&
      (this.#unknownStructure || desired !== undefined)
    )
      throw this.#editabilityError;
    const root = this.#yaml.document.contents;
    if (!isSeq(root))
      throw new ConfigurationError("Cordis patches must be a list");
    const replacements = new Map<unknown, unknown>();
    const invalidated = new Set(
      this.#operations.flatMap((op) =>
        op.direct || op.insertion !== undefined
          ? this.#yaml.anchors(op.source)
          : [],
      ),
    );
    let carried = false;
    for (const op of this.#operations) {
      if (op.direct) {
        replacements.set(op.source, undefined);
        continue;
      }
      if (op.insertion === undefined) continue;
      const copy = this.#yaml.detach(op.map, invalidated);
      if (!isMap(copy))
        throw new ConfigurationError("Cordis operation is not a mapping");
      const inserted = this.#editInsertion(op.insertion, invalidated, () => {
        if (carried || edit === undefined) return undefined;
        carried = true;
        return this.#entry(edit.desired, edit.platform, invalidated);
      });
      copy.set("insert", inserted);
      if (inserted.items.length === 0) copy.delete("insert");
      // An emptied operation keeps caller fields unless it would patch REA's row.
      const kept =
        inserted.items.length > 0 ||
        (this.#id(op.map) !== DSH_ENTRY_ID &&
          copy.items.some(
            (pair) => !SELECTOR_KEYS.has(this.#yaml.value(pair.key) as string),
          ));
      replacements.set(op.source, kept ? copy : undefined);
    }
    const output = this.#yaml.document.clone();
    const outputRoot = output.contents;
    if (!isSeq(outputRoot))
      throw new ConfigurationError("Cordis patches must be a list");
    outputRoot.items = root.items.flatMap((source) => {
      const copy = replacements.has(source)
        ? replacements.get(source)
        : this.#yaml.copy(source, invalidated);
      return copy === undefined ? [] : [copy];
    }) as typeof outputRoot.items;
    if (!carried && desired !== undefined)
      outputRoot.items.push(
        output.createNode({
          insert: [
            { id: DSH_ENTRY_ID, name: DSH_CLIENT_PACKAGE, config: desired },
          ],
        }) as never,
      );
    return output.toString({ lineWidth: 0 });
  }

  #editInsertion(
    insertion: OwnedInsertion,
    invalidated: ReadonlySet<Node>,
    replaceOwned?: () => YAMLMap<unknown, unknown> | undefined,
  ): YAMLSeq<unknown> {
    const copy = this.#yaml.detach(insertion.list, invalidated);
    if (!isSeq(copy))
      throw new ConfigurationError("Cordis insertion is not a list");
    copy.items = copy.items.flatMap((entry, index) => {
      if (insertion.ownedRows.has(index)) {
        const replacement = replaceOwned?.();
        return replacement === undefined ? [] : [replacement];
      }
      const nested = insertion.groups.get(index);
      if (nested === undefined) return [entry];
      const group = isMap(entry)
        ? entry
        : this.#yaml.detach(
            this.#map(insertion.list.items[index]),
            invalidated,
          );
      if (!isMap(group))
        throw new ConfigurationError("Cordis group is not a mapping");
      group.set("config", this.#editInsertion(nested, invalidated));
      return [group];
    });
    return copy;
  }

  #entry(
    desired: Record<string, unknown>,
    platform: NodeJS.Platform,
    invalidated: ReadonlySet<Node>,
  ): YAMLMap<unknown, unknown> {
    const entry = this.#yaml.detach(this.#entryNode, invalidated);
    if (!isMap(entry))
      throw new ConfigurationError("Cordis entry is not a mapping");
    this.#yaml.setValue(entry, "id", DSH_ENTRY_ID);
    this.#yaml.setValue(entry, "name", DSH_CLIENT_PACKAGE);
    entry.delete("disabled");
    for (const [key, value] of this.#fields) {
      if (["id", "name", "config", "disabled"].includes(key)) continue;
      entry.set(key, this.#yaml.detach(value, invalidated));
    }
    const sourceConfig = this.#map(this.#fields.get("config"));
    const config =
      sourceConfig === undefined
        ? this.#yaml.document.createNode({})
        : this.#yaml.detach(sourceConfig, invalidated);
    if (!isMap(config))
      throw new ConfigurationError(
        "Cordis registration config is not a mapping",
      );
    // Caller nodes keep their tags and spelling; only literal launcher values change.
    for (const key of LAUNCHER_KEYS)
      this.#yaml.setValue(config, key, desired[key]);
    if (typeof desired.toolCallTimeoutMs === "number")
      this.#yaml.setValue(
        config,
        "toolCallTimeoutMs",
        desired.toolCallTimeoutMs,
      );
    const env = this.#map(this.#yaml.field(sourceConfig, "env"));
    const desiredEnv = desired.env;
    if (isPatchRecord(desiredEnv)) {
      const nextEnv =
        env === undefined
          ? this.#yaml.document.createNode({})
          : this.#yaml.detach(env, invalidated);
      if (!isMap(nextEnv))
        throw new ConfigurationError("Cordis environment is not a mapping");
      for (const pair of [...nextEnv.items]) {
        const key = this.#yaml.key(pair.key);
        if (Object.hasOwn(desiredEnv, key)) {
          this.#yaml.renameKey(nextEnv, pair, key);
          continue;
        }
        // Windows environment names match case-insensitively, so a caller's
        // spelling of a desired name is kept rather than duplicated.
        const alias =
          platform === "win32"
            ? Object.keys(desiredEnv).find(
                (name) => name.toUpperCase() === key.toUpperCase(),
              )
            : undefined;
        if (alias === undefined) nextEnv.delete(pair.key);
        else this.#yaml.renameKey(nextEnv, pair, alias);
      }
      for (const [key, value] of Object.entries(desiredEnv)) {
        this.#yaml.setValue(nextEnv, key, value);
      }
      config.set("env", nextEnv);
    } else config.delete("env");
    entry.set("config", config);
    return entry;
  }
}

/** REA's desired entry and the platform whose environment names it uses. */
export interface DshCordisRegistration {
  readonly desired: Record<string, unknown>;
  readonly platform: NodeJS.Platform;
}

class DshCordisEdit {
  constructor(
    readonly source: DshCordisDocument,
    readonly registration?: DshCordisRegistration,
  ) {}
}
export const dshDocument = (
  document: Record<string, unknown>,
): DshCordisDocument => {
  if (!(document.cordis instanceof DshCordisDocument))
    throw new ConfigurationError("Missing Cordis document owner");
  return document.cordis;
};
export const parseDshCordisDocument = (
  text: string,
): ClientConfigurationDocument => {
  const source = new DshCordisDocument(text);
  return {
    document: { cordis: source },
    servers: source.config === undefined ? {} : { rea: source.config },
    serversPath: [],
    dialect: "dsh",
    environmentKey: "env",
    legacyServers: {},
  };
};
export const editDshDocument = (
  parsed: ClientConfigurationDocument,
  registration?: DshCordisRegistration,
): Record<string, unknown> => ({
  cordis: new DshCordisEdit(dshDocument(parsed.document), registration),
});
export const serializeDshDocument = (
  document: Record<string, unknown>,
): string => {
  if (!(document.cordis instanceof DshCordisEdit))
    throw new ConfigurationError("Missing Cordis edit plan");
  return document.cordis.source.serialize(document.cordis.registration);
};
/** Read a positive literal deadline or null for a caller-owned expression of unknown value. */
export const dshToolCallTimeout = (
  value: unknown,
): number | null | undefined => {
  if (value instanceof CordisExpression) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
};

export const dshClientRegistrationEntry = (
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Record<string, unknown> => {
  const [executable = "rea", ...args] = command;
  return {
    serverName: "rea",
    transport: "stdio",
    command: executable,
    args,
    ...(Object.keys(environment).length === 0
      ? {}
      : { env: { ...environment } }),
  };
};
