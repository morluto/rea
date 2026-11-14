import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PeResourcesPort } from "./PeResourcesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPeResourcesInputSchema,
  peResourcesSchema,
  type PeResources,
  type PeResourceIdentity,
} from "../../domain/native/peResources.js";
import {
  BYTE_PRESERVING_CODE_PAGE,
  DEFAULT_CODE_PAGE,
  DELPHI_FORM_BYTE_CHARGES,
  DELPHI_FORM_FLOAT_NOTES,
  decodeDelphiExtended,
  decodeDelphiText,
  delphiFormBinaryCharge,
  delphiFormTextCharge,
  formatDelphiCurrency,
  isDelphiFormValueType,
  MAX_DELPHI_FORM_DEPTH,
  MAX_DELPHI_FORM_HEX_BYTES,
  MAX_DELPHI_FORM_OBJECTS,
  MAX_DELPHI_FORM_PROPERTIES,
  MAX_DELPHI_FORM_RETAINED_BYTES,
  MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES,
  MAX_DELPHI_FORM_TEXT_BYTES,
  MAX_DELPHI_FORM_VALUES,
  RESOURCE_CODE_PAGES,
  type DelphiFormCollectionItem,
  type DelphiFormObject,
  type DelphiFormPosition,
  type DelphiFormProperty,
  type DelphiFormResource,
  type DelphiFormText,
  type DelphiFormValue,
} from "../../domain/native/delphiForm.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import { err, ok, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeResourcesService {
  constructor(readonly provider: PeResourcesPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_pe_resources";
    const input = parseAnalysisInput(
      operation,
      rawInput,
      inspectPeResourcesInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    if (!formTreeWithinDepth(result.value))
      return err(
        new AnalysisOutputError(
          operation,
          "PE resource provider returned malformed output or changed artifact identity.",
        ),
      );
    const report = peResourcesSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(
        report.data,
        input.value.max_entries,
        input.value.max_file_bytes,
      )
    )
      return err(
        new AnalysisOutputError(
          operation,
          "PE resource provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = peSubjectArchitecture(value.machine, value.format);
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "pe",
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
      options?.signal,
    );
  }
}

type FormTreeFrame =
  | {
      readonly kind: "object" | "property" | "value" | "collection-item";
      readonly value: unknown;
      readonly depth: number;
      readonly valueType?: string;
    }
  | { readonly kind: "leave"; readonly value: object };

const arrayItems = (node: object, key: string): readonly unknown[] => {
  const items = (node as Record<string, unknown>)[key];
  return Array.isArray(items) ? items : [];
};

const zeroLength = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>).bytes === 0;

/** The decoder's only over-budget node is a zero-length unknown sentinel. */
const stoppedUnknownValue = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>).kind === "unknown" &&
  zeroLength((value as Record<string, unknown>).location) &&
  (value as Record<string, unknown>).bytes_hex === "";

const exactObjectSentinel = (node: object): boolean => {
  const object = node as Record<string, unknown>;
  const unknown = object.unknown as Record<string, unknown> | undefined;
  return (
    zeroLength(object.location) &&
    arrayItems(node, "children").length === 0 &&
    arrayItems(node, "properties").length === 0 &&
    Array.isArray(object.flags) &&
    object.flags.length === 0 &&
    object.child_position === null &&
    object.class_name === null &&
    object.component_name === null &&
    typeof unknown === "object" &&
    unknown !== null &&
    zeroLength(unknown.location) &&
    unknown.bytes_hex === "" &&
    unknown.truncated === false
  );
};

/** A depth- or budget-overflow node is the decoder's explicit stop. */
const terminalStoppedNode = (
  frame: Extract<FormTreeFrame, { depth: number }>,
  node: object,
): boolean => {
  if (frame.kind === "object") return exactObjectSentinel(node);
  if (frame.kind === "property")
    return stoppedUnknownValue((node as Record<string, unknown>).value);
  if (frame.kind === "value") return stoppedUnknownValue(node);
  return false;
};

type FormCounters = {
  properties: number;
  values: number;
  text: number;
  bytes: number;
};

/** `spendText` charges the same projected size to text and bytes. */
const chargeText = (counters: FormCounters, bytes: number): void => {
  const charge = delphiFormTextCharge(bytes);
  counters.text += charge;
  counters.bytes += charge;
};

/** A short-string projection retains one length byte plus its body. */
const addText = (counters: FormCounters, item: unknown): void => {
  if (typeof item !== "object" || item === null) return;
  const record = item as Record<string, unknown>;
  if (typeof record.text !== "string" || typeof record.bytes_hex !== "string")
    return;
  chargeText(counters, record.bytes_hex.length / 2);
};

const addPositionBytes = (counters: FormCounters, item: unknown): void => {
  if (typeof item !== "object" || item === null) return;
  counters.bytes += DELPHI_FORM_BYTE_CHARGES.position;
};

/**
 * Decoder diagnostics (`unknown.reason`, float `note`, prefix `note`) are
 * published text too. The producer only emits short constants, but a provider
 * can send arbitrary strings, so charge their projection before Evidence
 * creation instead of hashing an unbounded value.
 */
const addDiagnostic = (counters: FormCounters, item: unknown): void => {
  if (typeof item !== "string") return;
  chargeText(counters, Buffer.byteLength(item, "utf8"));
};

/**
 * Zod follows the lazy form schema before the producer invariants run, so a
 * cyclic or over-deep provider tree would exhaust the call stack instead of
 * returning an output error. Walk the decoder's recursive edges first with an
 * explicit stack and the same depth and budget limits the native decoder
 * applies.
 */
const formTreeWithinDepth = (report: unknown): boolean => {
  if (typeof report !== "object" || report === null) return true;
  const forms = (report as Record<string, unknown>).delphi_forms;
  if (!Array.isArray(forms)) return true;
  for (const form of forms) {
    if (typeof form !== "object" || form === null) continue;
    const ancestors = new WeakSet<object>();
    const stack: FormTreeFrame[] = [
      {
        kind: "object",
        value: (form as Record<string, unknown>).root,
        depth: 0,
      },
    ];
    let objects = 0;
    // Object frames pushed but not popped yet. The initial frame is the root.
    let queuedObjects = 1;
    let sentinels = 0;
    let valueSentinels = 0;
    const counters: FormCounters = {
      properties: 0,
      values: 0,
      text: 0,
      bytes: 0,
    };
    const formPrefix = (form as Record<string, unknown>).prefix;
    if (typeof formPrefix === "object" && formPrefix !== null)
      addDiagnostic(counters, (formPrefix as Record<string, unknown>).note);
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === "leave") {
        ancestors.delete(frame.value);
        continue;
      }
      if (frame.kind === "object") queuedObjects -= 1;
      const node = frame.value;
      if (typeof node !== "object" || node === null) continue;
      if (frame.kind === "object") {
        objects += 1;
        if (terminalStoppedNode(frame, node)) sentinels += 1;
      }
      if (frame.depth > MAX_DELPHI_FORM_DEPTH) {
        // The decoder refuses to enter the next level but its caller retains a
        // zero-length stop node there. Allow that terminal sentinel, without
        // following it, and reject anything deeper.
        if (
          frame.depth > MAX_DELPHI_FORM_DEPTH + 1 ||
          !terminalStoppedNode(frame, node)
        )
          return false;
        continue;
      }
      if (ancestors.has(node)) return false;
      ancestors.add(node);
      stack.push({ kind: "leave", value: node });
      if (frame.kind === "object") {
        const object = node as Record<string, unknown>;
        const properties = arrayItems(node, "properties").length;
        counters.properties += properties;
        counters.bytes +=
          DELPHI_FORM_BYTE_CHARGES.object +
          properties * DELPHI_FORM_BYTE_CHARGES.property;
        addText(counters, object.class_name);
        addText(counters, object.component_name);
        addPositionBytes(counters, object.child_position);
        const unknown = object.unknown;
        if (typeof unknown === "object" && unknown !== null)
          addDiagnostic(counters, (unknown as Record<string, unknown>).reason);
        if (
          counters.properties > MAX_DELPHI_FORM_PROPERTIES ||
          counters.bytes > MAX_DELPHI_FORM_RETAINED_BYTES ||
          counters.text > MAX_DELPHI_FORM_TEXT_BYTES
        )
          return false;
        const children = arrayItems(node, "children");
        // Count every scheduled child before pushing: a malformed provider
        // could otherwise stack millions of frames before the object limit is
        // checked when they are popped.
        if (
          objects + queuedObjects + children.length >
          MAX_DELPHI_FORM_OBJECTS + 1
        )
          return false;
        // Nested components recurse one level deeper; property values share
        // the object's depth, exactly as readObject passes it to readValue.
        for (const child of children) {
          stack.push({ kind: "object", value: child, depth: frame.depth + 1 });
          queuedObjects += 1;
        }
        for (const property of arrayItems(node, "properties"))
          stack.push({ kind: "property", value: property, depth: frame.depth });
        continue;
      }
      if (frame.kind === "property") {
        const property = node as Record<string, unknown>;
        addText(counters, property.name);
        stack.push({
          kind: "value",
          value: property.value,
          depth: frame.depth,
          ...(typeof property.value_type === "string"
            ? { valueType: property.value_type }
            : {}),
        });
        continue;
      }
      if (frame.kind === "collection-item") {
        const item = node as Record<string, unknown>;
        const properties = arrayItems(node, "properties").length;
        counters.properties += properties;
        counters.bytes +=
          DELPHI_FORM_BYTE_CHARGES.item +
          properties * DELPHI_FORM_BYTE_CHARGES.property;
        addPositionBytes(counters, item.position);
        if (
          counters.properties > MAX_DELPHI_FORM_PROPERTIES ||
          counters.bytes > MAX_DELPHI_FORM_RETAINED_BYTES ||
          counters.text > MAX_DELPHI_FORM_TEXT_BYTES
        )
          return false;
        // A collection item's property values are read one level below the
        // collection value.
        for (const property of arrayItems(node, "properties"))
          stack.push({
            kind: "property",
            value: property,
            depth: frame.depth + 1,
          });
        continue;
      }
      const value = node as Record<string, unknown>;
      counters.values += 1;
      if (stoppedUnknownValue(node)) valueSentinels += 1;
      else counters.bytes += DELPHI_FORM_BYTE_CHARGES.value;
      const location = value.location as Record<string, unknown> | undefined;
      const locationBytes =
        typeof location?.bytes === "number" ? location.bytes : 0;
      if (value.kind === "unknown") addDiagnostic(counters, value.reason);
      else if (value.kind === "float") addDiagnostic(counters, value.note);
      if (value.kind === "string") {
        // spendText uses the available body bytes, one prefix byte for
        // vaString and four for the sized string types.
        const bodyPrefix = frame.valueType === "vaString" ? 1 : 4;
        const available = Math.max(0, locationBytes - bodyPrefix);
        const declared =
          typeof value.declared_bytes === "number" &&
          Number.isFinite(value.declared_bytes)
            ? value.declared_bytes
            : available;
        // The short-string reader charges its declared length before taking
        // any body bytes, so a retained body only fits under the same charge.
        // The zero-body budget stop retains just the length byte and keeps
        // its reduced charge.
        chargeText(
          counters,
          frame.valueType === "vaString" && available > 0
            ? declared
            : available,
        );
      } else if (value.kind === "identifier") {
        addText(counters, value);
      } else if (value.kind === "binary") {
        const charge = delphiFormBinaryCharge(Math.max(0, locationBytes - 4));
        counters.text += charge;
        counters.bytes += charge;
      } else if (value.kind === "set") {
        const names = arrayItems(value, "names");
        // The closing zero-length name is read through the same value charge.
        counters.values += names.length + (value.terminated === true ? 1 : 0);
        // Reject before walking: a malformed provider can supply an unbounded
        // name array even though the decoder could never retain it.
        if (counters.values > MAX_DELPHI_FORM_VALUES + 1) return false;
        for (const name of names) addText(counters, name);
        if (value.terminated === true) chargeText(counters, 0);
      } else if (value.kind === "collection")
        counters.values += arrayItems(value, "items").length;
      if (
        counters.values > MAX_DELPHI_FORM_VALUES + 1 ||
        counters.bytes > MAX_DELPHI_FORM_RETAINED_BYTES ||
        counters.text > MAX_DELPHI_FORM_TEXT_BYTES
      )
        return false;
      if (value.kind === "list") {
        const entries = arrayItems(value, "items");
        if (counters.values + entries.length > MAX_DELPHI_FORM_VALUES + 1)
          return false;
        counters.bytes += entries.length * DELPHI_FORM_BYTE_CHARGES.listEntry;
        if (counters.bytes > MAX_DELPHI_FORM_RETAINED_BYTES) return false;
        for (const entry of entries) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as Record<string, unknown>;
          stack.push({
            kind: "value",
            value: record.value,
            depth: frame.depth + 1,
            ...(typeof record.value_type === "string"
              ? { valueType: record.value_type }
              : {}),
          });
        }
      }
      if (value.kind === "collection") {
        const items = arrayItems(value, "items");
        // The item values were already added to the counter above.
        if (counters.values > MAX_DELPHI_FORM_VALUES + 1) return false;
        for (const item of items)
          stack.push({
            kind: "collection-item",
            value: item,
            depth: frame.depth,
          });
      }
    }
    // A budget-exhausted read retains one terminal sentinel after the last
    // retained object; anything beyond that cannot come from the decoder.
    if (
      objects > MAX_DELPHI_FORM_OBJECTS &&
      !(objects === MAX_DELPHI_FORM_OBJECTS + 1 && sentinels === 1)
    )
      return false;
    // A value-budget stop retains one zero-length unknown without spending the
    // budget, so that terminal sentinel may follow exactly MAX_VALUES values.
    if (
      counters.values > MAX_DELPHI_FORM_VALUES &&
      !(counters.values === MAX_DELPHI_FORM_VALUES + 1 && valueSentinels === 1)
    )
      return false;
    if (
      counters.properties > MAX_DELPHI_FORM_PROPERTIES ||
      counters.text > MAX_DELPHI_FORM_TEXT_BYTES ||
      counters.bytes > MAX_DELPHI_FORM_RETAINED_BYTES
    )
      return false;
  }
  return true;
};

/** Check cross-field invariants before provider output becomes public Evidence. */
const validReport = (
  report: PeResources,
  maxEntries: number,
  maxBytes: number,
): boolean => {
  const inside = ({ offset, bytes }: { offset: number; bytes: number }) =>
    offset <= report.artifact.bytes - bytes;
  const identityInside = (identity: PeResourceIdentity): boolean =>
    identity.kind === "id" || inside(identity.location);
  if (
    report.artifact.bytes > maxBytes ||
    report.coverage.resources !== report.resources.length ||
    report.coverage.examined_entries > maxEntries ||
    report.coverage.examined_entries !==
      report.directories.reduce(
        (sum, item) => sum + item.named_entries + item.id_entries,
        0,
      )
  )
    return false;
  if (
    report.directory === null &&
    (report.directories.length > 0 || report.resources.length > 0)
  )
    return false;
  if (
    report.directory !== null &&
    (!inside(report.directory.location) ||
      !inside(report.directory.data_directory_location))
  )
    return false;
  if (
    !report.directories.every(
      (item) =>
        inside(item.location) &&
        item.path.length === item.entry_locations.length &&
        item.entry_locations.every(inside) &&
        item.path.every(identityInside),
    )
  )
    return false;
  if (
    !report.resources.every(
      (item, index) =>
        item.index === index &&
        inside(item.data_entry_location) &&
        inside(item.payload.location) &&
        item.entry_locations.every(inside) &&
        [item.type, item.name, item.language].every(identityInside),
    )
  )
    return false;
  return (
    // The parser visits each resource once, so one payload cannot produce two
    // decoded forms.
    new Set(report.delphi_forms.map((form) => form.resource_index)).size ===
      report.delphi_forms.length &&
    report.icon_groups.every((group) => {
      const resource = report.resources[group.resource_index];
      if (
        resource === undefined ||
        resource.type.kind !== "id" ||
        resource.type.id !== 14
      )
        return false;
      return group.images.every(
        (image) =>
          inside(image.location) &&
          image.location.offset >= resource.payload.location.offset &&
          image.location.offset + image.location.bytes <=
            resource.payload.location.offset +
              resource.payload.location.bytes &&
          image.candidate_resource_indices.every((index) => {
            const icon = report.resources[index];
            return (
              icon !== undefined &&
              icon.type.kind === "id" &&
              icon.type.id === 3 &&
              icon.name.kind === "id" &&
              icon.name.id === image.resource_id
            );
          }) &&
          (image.same_language_resource_index === null
            ? image.size_matches === null
            : image.candidate_resource_indices.includes(
                image.same_language_resource_index,
              ) &&
              sameIdentity(
                report.resources[image.same_language_resource_index]?.language,
                resource.language,
              ) &&
              image.size_matches ===
                (report.resources[image.same_language_resource_index]?.payload
                  .location.bytes ===
                  image.declared_bytes)),
      );
    }) &&
    // A decoded form must come from an RT_RCDATA payload and stay inside it,
    // so a provider result cannot point a form at another resource's bytes.
    report.delphi_forms.every((form) => {
      const resource = report.resources[form.resource_index];
      if (
        resource === undefined ||
        resource.type.kind !== "id" ||
        resource.type.id !== 10
      )
        return false;
      const payload = resource.payload.location;
      const within = ({ offset, bytes }: { offset: number; bytes: number }) =>
        offset >= payload.offset &&
        offset + bytes <= payload.offset + payload.bytes;
      const signature = form.signature_location;
      const signatureEnd = signature.offset + signature.bytes;
      // A null prefix starts the payload; a present prefix covers every byte
      // before the signature. Either way the root starts right after it.
      const prefixMatches =
        form.prefix === null
          ? signature.offset === payload.offset
          : form.prefix.location.offset === payload.offset &&
            form.prefix.location.bytes === signature.offset - payload.offset &&
            form.prefix.location.bytes > 0 &&
            // The decoder probes offsets 0 through 16 only; a longer prefix
            // describes a signature the producer can never have matched.
            form.prefix.location.bytes <=
              MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES &&
            // The producer retains the full prefix, so an empty or partial
            // preview cannot be the source of these bytes.
            form.prefix.bytes_hex.length === form.prefix.location.bytes * 2;
      const rootEnd = form.root.location.offset + form.root.location.bytes;
      const payloadEnd = payload.offset + payload.bytes;
      // A complete root reaches the payload end; a stopped root records the
      // unread suffix on its unknown instead of silently dropping those bytes.
      const rootCoversPayload =
        form.root.unknown === null
          ? rootEnd === payloadEnd
          : form.root.unknown.location.offset === rootEnd &&
            form.root.unknown.location.offset +
              form.root.unknown.location.bytes ===
              payloadEnd;
      return (
        // The declared page must be the resource's own declaration, and the
        // source classification must agree with it, so published Evidence
        // cannot claim a declaration the artifact did not make.
        form.declared_code_page === resource.code_page &&
        signatureMatchesVersion(form) &&
        codePageSourceMatches(form) &&
        signature.bytes === 4 &&
        within(signature) &&
        prefixMatches &&
        form.root.location.offset === signatureEnd &&
        within(form.root.location) &&
        rootCoversPayload &&
        insideLocations(
          form.root,
          within,
          form.code_page,
          within,
          true,
          payloadEnd,
        )
      );
    })
  );
};

const withinRange = (
  child: { offset: number; bytes: number },
  parent: { offset: number; bytes: number },
): boolean =>
  child.offset >= parent.offset &&
  child.offset + child.bytes <= parent.offset + parent.bytes;

/** A stopped value must also stop every object that owns it. */
const valueHasStop = (value: DelphiFormValue): boolean => {
  if (value.kind === "unknown") return true;
  if (value.kind === "string" || value.kind === "binary")
    return value.decode_truncated;
  if (value.kind === "list")
    return (
      !value.terminated ||
      value.items.some((entry) => valueHasStop(entry.value))
    );
  if (value.kind === "set") return !value.terminated;
  if (value.kind === "collection")
    return (
      !value.terminated ||
      value.items.some((item) =>
        item.properties.some((property) => valueHasStop(property.value)),
      )
    );
  return false;
};

const objectHasStop = (object: DelphiFormObject): boolean =>
  object.unknown !== null ||
  object.properties.some((property) => valueHasStop(property.value)) ||
  object.children.some(objectHasStop);

/**
 * A short Pascal label retains one length byte plus its source bytes, so its
 * text must be exactly the decode of those retained bytes under the form page.
 */
const nonEmptyTextMatchesBytes = (
  item: DelphiFormText,
  codePage: string,
): boolean => item.bytes_hex.length > 0 && textMatchesBytes(item, codePage);

const textMatchesBytes = (item: DelphiFormText, codePage: string): boolean => {
  const raw = Buffer.from(item.bytes_hex, "hex");
  return (
    item.code_page === codePage &&
    // A short string declares its content with one byte, so 255 is the most
    // it can retain.
    raw.length <= 0xff &&
    item.location.bytes === 1 + raw.length &&
    decodeDelphiText(raw, codePage) === item.text
  );
};

/**
 * The decoder reads a short name, one type byte, then the value, back to back.
 * Marker-only values cover the type byte; payload values start after it. A
 * stopped value records the same end as its owning property.
 */
const valueFollowsName = (property: DelphiFormProperty): boolean => {
  const nameEnd = property.name.location.offset + property.name.location.bytes;
  const valueEnd =
    property.value.location.offset + property.value.location.bytes;
  if (property.location.offset !== property.name.location.offset) return false;
  if (valueEnd !== property.location.offset + property.location.bytes)
    return false;
  const kind = property.value.kind;
  if (kind === "unknown")
    // `unknown` means the type marker itself could not be read; any declared
    // ordinal means it was consumed.
    return property.value_type === "unknown"
      ? property.value.location.offset === nameEnd &&
          property.value.location.bytes === 0
      : property.value.location.offset === nameEnd + 1;
  if (kind === "null" || kind === "nil" || kind === "boolean")
    return property.value.location.offset === nameEnd;
  return property.value.location.offset === nameEnd + 1;
};

/** Properties are retained in source order with no overlap or gap. */
const propertiesFollowSource = (
  properties: readonly DelphiFormProperty[],
): boolean =>
  properties.every((property, index) => {
    const previous = index === 0 ? undefined : properties[index - 1];
    return (
      valueFollowsName(property) &&
      // A stopped value ends the property loop; nothing can follow it.
      (!valueHasStop(property.value) || index === properties.length - 1) &&
      (previous === undefined ||
        previous.location.offset + previous.location.bytes ===
          property.location.offset)
    );
  });

/** A stopped child ends the child loop; its cursor is the object end. */
const childrenFollowSource = (object: DelphiFormObject): boolean => {
  let previous: DelphiFormObject | undefined;
  for (const [index, child] of object.children.entries()) {
    if (
      previous !== undefined &&
      previous.location.offset + previous.location.bytes !==
        child.location.offset
    )
      return false;
    if (objectHasStop(child) && index !== object.children.length - 1)
      return false;
    previous = child;
  }
  const last = object.children.at(-1);
  return (
    last === undefined ||
    !objectHasStop(last) ||
    last.location.offset + last.location.bytes ===
      object.location.offset + object.location.bytes
  );
};

/**
 * The decoder reads the optional flag byte and position, both names, the
 * property terminator, the children and the object terminator in order. Tie
 * the section edges to that source layout instead of checking containment only.
 */
const objectSectionsFollowSource = (
  object: DelphiFormObject,
  isRoot: boolean,
): boolean => {
  const objectEnd = object.location.offset + object.location.bytes;
  let cursor = object.location.offset;
  const flagged = object.flags.length > 0 || object.child_position !== null;
  if (flagged) cursor += 1;
  if (object.child_position !== null) {
    // The tag byte precedes the retained position payload.
    if (object.child_position.location.offset !== cursor + 1) return false;
    cursor =
      object.child_position.location.offset +
      object.child_position.location.bytes;
  }
  const headerEnd = cursor;
  // A prefix byte of 0xF0 declares no flag, so an empty flag list cannot
  // distinguish its presence from an unprefixed header.
  const optionalFlagByte =
    object.flags.length === 0 && object.child_position === null ? 1 : 0;
  // The decoder reads the position immediately after setting ffChildPos; a
  // missing position stops the object before either name is read.
  if (
    object.class_name !== null &&
    object.flags.includes("ffChildPos") &&
    object.child_position === null
  )
    return false;
  if (object.class_name !== null) {
    const classOffset = object.class_name.location.offset;
    if (
      classOffset !== headerEnd &&
      classOffset !== headerEnd + optionalFlagByte
    )
      return false;
    // A class name starting where the header ended begins with its length
    // byte. The decoder treats byte 0 as the parent's child-list terminator
    // and 0xF0-0xFF as a filer prefix, so it can only emit 1-239 there for a
    // child and 0-239 for the root. After an explicit prefix byte every
    // short-string length is reachable.
    const prefixed = flagged || classOffset === headerEnd + optionalFlagByte;
    const length = object.class_name.location.bytes - 1;
    if (!prefixed && (length > 0xef || (!isRoot && length === 0))) return false;
    cursor = classOffset + object.class_name.location.bytes;
  } else if (object.component_name !== null) return false;
  if (object.component_name !== null) {
    if (object.component_name.location.offset !== cursor) return false;
    cursor =
      object.component_name.location.offset +
      object.component_name.location.bytes;
  }
  const namesEnd = cursor;
  if (object.properties.length > 0) {
    if (object.properties[0]!.location.offset !== namesEnd) return false;
    const last = object.properties.at(-1)!;
    cursor = last.location.offset + last.location.bytes;
  }
  const propertiesEnd = cursor;
  if (object.unknown === null) {
    // Complete: property-list terminator, children, object terminator.
    cursor = propertiesEnd + 1;
    if (object.children.length > 0) {
      if (object.children[0]!.location.offset !== cursor) return false;
      const last = object.children.at(-1)!;
      cursor = last.location.offset + last.location.bytes;
    }
    return objectEnd === cursor + 1;
  }
  if (object.children.length > 0) {
    // A stopped property rethrows before the property terminator or child loop.
    if (object.properties.some((property) => valueHasStop(property.value)))
      return false;
    // The property terminator was consumed before the child list starts.
    if (object.children[0]!.location.offset !== propertiesEnd + 1) return false;
    const last = object.children.at(-1)!;
    const lastEnd = last.location.offset + last.location.bytes;
    if (objectHasStop(last)) return objectEnd === lastEnd;
    // With complete children, a nonempty suffix would have invoked another
    // child read; only EOF may end the object at the last child.
    if (objectEnd === lastEnd) return object.unknown.location.bytes === 0;
    // A root may have consumed the object terminator before keeping the
    // remaining payload bytes as an unknown suffix. At EOF the decoder would
    // have reported a complete root instead, so the suffix cannot be empty.
    return (
      isRoot && objectEnd === lastEnd + 1 && object.unknown.location.bytes > 0
    );
  }
  if (object.properties.length > 0) {
    if (object.component_name === null) return false;
    // A stopped value ends the object before the property terminator.
    if (object.properties.some((property) => valueHasStop(property.value)))
      return objectEnd === propertiesEnd;
    return (
      objectEnd === propertiesEnd ||
      objectEnd === propertiesEnd + 1 ||
      (isRoot &&
        objectEnd === propertiesEnd + 2 &&
        object.unknown.location.bytes > 0)
    );
  }
  if (object.class_name === null)
    return (
      objectEnd === headerEnd ||
      (optionalFlagByte === 1 && objectEnd === headerEnd + 1)
    );
  if (object.component_name === null) return objectEnd === namesEnd;
  return (
    objectEnd === namesEnd ||
    objectEnd === namesEnd + 1 ||
    (isRoot && objectEnd === namesEnd + 2 && object.unknown.location.bytes > 0)
  );
};

/** Every nested location of a decoded form must stay inside its owner. */
const insideLocations = (
  object: DelphiFormObject,
  within: (range: { offset: number; bytes: number }) => boolean,
  codePage: string,
  payloadWithin: (range: { offset: number; bytes: number }) => boolean = within,
  isRoot = true,
  payloadEnd = 0,
): boolean => {
  if (!within(object.location)) return false;
  if (
    object.unknown !== null &&
    // The producer stops an object at the point its unknown starts, so a gap
    // between them would leave bytes claimed by neither. The unknown preview
    // retains the first up-to-128 bytes of that exact range, with `truncated`
    // marking the cap.
    (!payloadWithin(object.unknown.location) ||
      object.unknown.location.offset !==
        object.location.offset + object.location.bytes ||
      object.unknown.bytes_hex.length / 2 !==
        Math.min(object.unknown.location.bytes, MAX_DELPHI_FORM_HEX_BYTES) ||
      object.unknown.truncated !==
        object.unknown.location.bytes > MAX_DELPHI_FORM_HEX_BYTES ||
      // Ordinary stopped objects retain the suffix through the payload end;
      // only the exact depth/budget sentinel may keep an empty child unknown.
      (!exactObjectSentinel(object) &&
        object.unknown.location.offset + object.unknown.location.bytes !==
          payloadEnd))
  )
    return false;
  const text = (
    item: DelphiFormText | null,
    owner: { offset: number; bytes: number },
  ): boolean =>
    item === null ||
    (withinRange(item.location, owner) && textMatchesBytes(item, codePage));
  if (
    !text(object.class_name, object.location) ||
    !text(object.component_name, object.location)
  )
    return false;
  // A nested stop must propagate: the producer rethrows a stopped child
  // through every ancestor, so an ancestor without an unknown is not a shape
  // this decoder can produce.
  if (
    object.unknown === null &&
    (object.class_name === null ||
      object.component_name === null ||
      (object.flags.includes("ffChildPos") && object.child_position === null) ||
      object.properties.some((property) => valueHasStop(property.value)) ||
      object.children.some(objectHasStop))
  )
    return false;
  if (
    object.child_position !== null &&
    (!object.flags.includes("ffChildPos") ||
      !positionMatches(object.child_position, object.location))
  )
    return false;
  if (!objectSectionsFollowSource(object, isRoot)) return false;
  if (!propertiesFollowSource(object.properties)) return false;
  if (!childrenFollowSource(object)) return false;
  return (
    object.properties.every(
      (property) =>
        withinRange(property.location, object.location) &&
        text(property.name, property.location) &&
        property.name.bytes_hex.length > 0 &&
        insideValue(
          property.value,
          (range) => withinRange(range, property.location),
          codePage,
          property.value_type,
          payloadEnd,
        ),
    ) &&
    object.children.every((child) =>
      insideLocations(
        child,
        (range) => withinRange(range, object.location),
        codePage,
        payloadWithin,
        false,
        payloadEnd,
      ),
    )
  );
};

/** The filer signature and the version it derives are a one-to-one pair. */
const signatureMatchesVersion = (form: DelphiFormResource): boolean =>
  form.signature === "TPF0"
    ? form.version === "boVersion0"
    : form.version === "boVersion1";

/** The source classification and label must agree with the declared page. */
const codePageSourceMatches = (form: DelphiFormResource): boolean => {
  if (form.declared_code_page === 0)
    return (
      form.code_page_source === "default" &&
      form.code_page === DEFAULT_CODE_PAGE
    );
  const label = RESOURCE_CODE_PAGES[form.declared_code_page];
  if (label !== undefined)
    return form.code_page_source === "resource" && form.code_page === label;
  return (
    form.code_page_source === "unsupported" &&
    form.code_page === BYTE_PRESERVING_CODE_PAGE
  );
};

/** The decoder derives a string's label from its value type and resource page. */
const valuePageMatchesType = (
  valueType: string | null,
  label: string,
  codePage: string,
): boolean => {
  if (valueType === null)
    return label === codePage || label === "utf-8" || label === "utf-16le";
  if (valueType === "vaString" || valueType === "vaLString")
    return label === codePage;
  if (valueType === "vaWString" || valueType === "vaUString")
    return label === "utf-16le";
  return valueType === "vaUTF8String" && label === "utf-8";
};

const integerMatches = (
  value: DelphiFormValue,
  width: 8 | 16 | 32 | 64,
  signed: boolean,
): boolean => {
  if (
    value.kind !== "integer" ||
    value.width !== width ||
    value.signed !== signed ||
    value.location.bytes !== width / 8
  )
    return false;
  if (!/^(?:0|-?[1-9]\d*)$/u.test(value.text)) return false;
  // The retained bytes are the source of the text projection; a provider
  // cannot pair a decimal string with bytes that decode to another value.
  if (value.bytes_hex.length !== width / 4) return false;
  let raw = 0n;
  for (let index = value.bytes_hex.length - 2; index >= 0; index -= 2)
    raw =
      (raw << 8n) |
      BigInt(Number.parseInt(value.bytes_hex.slice(index, index + 2), 16));
  const decoded = signed ? BigInt.asIntN(width, raw) : raw;
  return decoded === BigInt(value.text);
};

/** A positional integer must match its own bytes and stay inside its owner. */
const positionMatches = (
  position: DelphiFormPosition,
  owner: { offset: number; bytes: number },
): boolean =>
  integerMatches(position, position.width, true) &&
  withinRange(position.location, owner);

const FLOAT_WIDTH_BYTES: Readonly<Record<string, number>> = {
  vaSingle: 4,
  vaDouble: 8,
  vaDate: 8,
  vaCurrency: 8,
  vaExtended: 10,
};

const floatMatches = (
  valueType: string,
  value: Extract<DelphiFormValue, { kind: "float" }>,
): boolean => {
  const width = FLOAT_WIDTH_BYTES[valueType];
  if (
    width === undefined ||
    value.location.bytes !== width ||
    value.bytes_hex.length !== width * 2 ||
    value.note !== DELPHI_FORM_FLOAT_NOTES[valueType]
  )
    return false;
  const raw = Buffer.from(value.bytes_hex, "hex");
  if (valueType === "vaCurrency")
    return value.text === formatDelphiCurrency(raw);
  if (valueType === "vaExtended") {
    const decoded = decodeDelphiExtended(raw);
    return value.text === (decoded === null ? null : String(decoded));
  }
  const decoded =
    valueType === "vaSingle" ? raw.readFloatLE(0) : raw.readDoubleLE(0);
  return value.text === (Number.isFinite(decoded) ? String(decoded) : null);
};

const STRING_PROJECTION: Readonly<
  Record<string, { prefixBytes: number; previewBytes: number; wide: boolean }>
> = {
  vaString: { prefixBytes: 1, previewBytes: 0xff, wide: false },
  vaLString: {
    prefixBytes: 4,
    previewBytes: MAX_DELPHI_FORM_HEX_BYTES,
    wide: false,
  },
  vaUTF8String: {
    prefixBytes: 4,
    previewBytes: MAX_DELPHI_FORM_HEX_BYTES,
    wide: false,
  },
  vaWString: {
    prefixBytes: 4,
    previewBytes: MAX_DELPHI_FORM_HEX_BYTES,
    wide: true,
  },
  vaUString: {
    prefixBytes: 4,
    previewBytes: MAX_DELPHI_FORM_HEX_BYTES,
    wide: true,
  },
};

/**
 * A capped preview retains a byte prefix of the value. Decode it in streaming
 * mode so an incomplete trailing sequence is not turned into a replacement
 * character that the full text cannot match.
 */
const previewMatchesText = (
  raw: Buffer,
  codePage: string,
  text: string,
): boolean => {
  if (codePage === BYTE_PRESERVING_CODE_PAGE)
    return text.startsWith(raw.toString("latin1"));
  try {
    // Match decodeDelphiText: the UTF-16LE path and Buffer's UTF-8 decode
    // keep a leading BOM; other TextDecoder paths remove it.
    const decoder = new TextDecoder(
      codePage,
      codePage === "utf-16le" || codePage === "utf-8"
        ? { ignoreBOM: true }
        : undefined,
    );
    return text.startsWith(decoder.decode(raw, { stream: true }));
  } catch {
    return text.startsWith(raw.toString("latin1"));
  }
};

const stringMatchesType = (
  valueType: string,
  value: Extract<DelphiFormValue, { kind: "string" }>,
): boolean => {
  const projection = STRING_PROJECTION[valueType];
  if (projection === undefined) return false;
  if (projection.wide && value.declared_bytes % 2 !== 0) return false;
  if (valueType === "vaString" && value.declared_bytes > 0xff) return false;
  const available = value.location.bytes - projection.prefixBytes;
  const retained = value.bytes_hex.length / 2;
  if (
    available < 0 ||
    (projection.wide && available % 2 !== 0) ||
    retained !== Math.min(available, projection.previewBytes)
  )
    return false;
  // A source range cannot decode to more characters than it contains bytes.
  if (value.text.length > available) return false;
  const raw = Buffer.from(value.bytes_hex, "hex");
  // When the preview covers every available byte the text must be its exact
  // decode; a capped preview must agree with the start of the text. The same
  // rule applies to a stopped decode that retained more than the preview cap.
  const textMatches =
    value.bytes_hex.length / 2 === available
      ? decodeDelphiText(raw, value.code_page) === value.text
      : previewMatchesText(raw, value.code_page, value.text);
  if (value.decode_truncated)
    return (
      value.truncated &&
      // A stopped decode is strictly short of its declaration. The decoder
      // charges the budget before taking any body bytes, so the only equality
      // it can produce is the valid zero-length budget stop.
      (available < value.declared_bytes ||
        (available === 0 && value.declared_bytes === 0)) &&
      textMatches
    );
  if (
    available !== value.declared_bytes ||
    value.truncated !== value.declared_bytes > projection.previewBytes
  )
    return false;
  return textMatches;
};

const binaryMatches = (
  value: Extract<DelphiFormValue, { kind: "binary" }>,
): boolean => {
  const available = value.location.bytes - 4;
  const retained = value.bytes_hex.length / 2;
  if (
    available < 0 ||
    retained !== Math.min(available, MAX_DELPHI_FORM_HEX_BYTES)
  )
    return false;
  if (value.decode_truncated)
    // See stringMatchesType: a stopped decode is strictly short unless the
    // valid zero-length budget stop retained nothing.
    return (
      value.truncated &&
      (available < value.declared_bytes ||
        (available === 0 && value.declared_bytes === 0))
    );
  return (
    available === value.declared_bytes &&
    value.truncated === value.declared_bytes > MAX_DELPHI_FORM_HEX_BYTES
  );
};

/** `vaIdent` is a short string: one length byte plus its retained bytes. */
const identifierMatches = (
  value: Extract<DelphiFormValue, { kind: "identifier" }>,
  codePage: string,
): boolean => {
  const raw = Buffer.from(value.bytes_hex, "hex");
  return (
    raw.length <= 0xff &&
    value.location.bytes === 1 + raw.length &&
    decodeDelphiText(raw, codePage) === value.text
  );
};

const valueMatchesType = (
  valueType: string,
  value: DelphiFormValue,
  codePage: string,
): boolean => {
  if (!isDelphiFormValueType(valueType)) return false;
  if (value.kind === "unknown")
    // Fixed-width and unsupported reads fail before advancing the cursor, and
    // partial strings/binary/containers stay typed. A generic unknown value is
    // therefore the empty range at the failed read.
    return value.location.bytes === 0 && value.bytes_hex === "";
  switch (valueType) {
    case "vaNull":
      return value.kind === "null" && value.location.bytes === 1;
    case "vaNil":
      return value.kind === "nil" && value.location.bytes === 1;
    case "vaFalse":
    case "vaTrue":
      return (
        value.kind === "boolean" &&
        value.value === (valueType === "vaTrue") &&
        value.location.bytes === 1
      );
    case "vaInt8":
      return integerMatches(value, 8, true);
    case "vaInt16":
      return integerMatches(value, 16, true);
    case "vaInt32":
      return integerMatches(value, 32, true);
    case "vaInt64":
      return integerMatches(value, 64, true);
    case "vaQWord":
      return integerMatches(value, 64, false);
    case "vaExtended":
    case "vaSingle":
    case "vaCurrency":
    case "vaDate":
    case "vaDouble":
      return value.kind === "float" && floatMatches(valueType, value);
    case "vaString":
    case "vaLString":
    case "vaWString":
    case "vaUTF8String":
    case "vaUString":
      return (
        value.kind === "string" &&
        stringMatchesType(valueType, value) &&
        valuePageMatchesType(valueType, value.code_page, codePage)
      );
    case "vaIdent":
      return value.kind === "identifier" && identifierMatches(value, codePage);
    case "vaBinary":
      return value.kind === "binary" && binaryMatches(value);
    case "vaList":
      return value.kind === "list";
    case "vaSet":
      return value.kind === "set";
    case "vaCollection":
      return value.kind === "collection";
    default:
      return false;
  }
};

/**
 * List entries are read sequentially. A complete list also owns its closing
 * terminator byte; a stopped list ends at the last entry or explicit stop.
 */
const listEntriesFollowSource = (
  value: Extract<DelphiFormValue, { kind: "list" }>,
): boolean => {
  let expected = value.location.offset;
  for (const [index, entry] of value.items.entries()) {
    // A stopped entry ends the list: the decoder rethrows the stop instead of
    // reading another marker or the closing terminator.
    if (
      valueHasStop(entry.value) &&
      (value.terminated || index !== value.items.length - 1)
    )
      return false;
    if (
      entry.marker_location.offset !== expected ||
      entry.marker_location.bytes !== 1
    )
      return false;
    const markerOnly =
      entry.value.kind === "null" ||
      entry.value.kind === "nil" ||
      entry.value.kind === "boolean";
    if (entry.value.location.offset !== expected + (markerOnly ? 0 : 1))
      return false;
    const entryEnd = entry.value.location.offset + entry.value.location.bytes;
    if (markerOnly && entryEnd !== expected + 1) return false;
    expected = entryEnd;
  }
  const listEnd = value.location.offset + value.location.bytes;
  return value.terminated ? listEnd === expected + 1 : listEnd === expected;
};

/**
 * Set names and collection items are read sequentially. A complete value also
 * owns its one-byte closing terminator.
 */
const setFollowsSource = (
  value: Extract<DelphiFormValue, { kind: "set" }>,
): boolean => {
  let expected = value.location.offset;
  for (const name of value.names) {
    if (name.location.offset !== expected) return false;
    expected = name.location.offset + name.location.bytes;
  }
  const end = value.location.offset + value.location.bytes;
  return value.terminated ? end === expected + 1 : end === expected;
};

/**
 * A collection item is an optional positional integer, the `vaList` marker the
 * reader consumes, its properties and one terminator byte. The last item of a
 * stopped collection may end anywhere after an observed prefix, but it still
 * has to start with the bytes the decoder actually consumed.
 */
const collectionItemFollowsSource = (
  item: DelphiFormCollectionItem,
  complete: boolean,
): boolean => {
  if (item.location.bytes === 0) return false;
  const itemEnd = item.location.offset + item.location.bytes;
  let cursor = item.location.offset;
  if (item.position !== null) {
    // The tag byte is structural and precedes the retained position payload.
    if (item.position.location.offset !== cursor + 1) return false;
    cursor = item.position.location.offset + item.position.location.bytes;
  }
  // A stopped item can end after a complete position but before its marker.
  if (itemEnd < cursor + 1)
    return !complete && item.properties.length === 0 && itemEnd === cursor;
  if (!propertiesFollowSource(item.properties)) return false;
  if (item.properties.length > 0) {
    // Properties start right after the marker and run to the item end.
    if (item.properties[0]!.location.offset !== cursor + 1) return false;
    const last = item.properties.at(-1)!;
    cursor = last.location.offset + last.location.bytes;
  } else {
    cursor += 1;
  }
  // A stop leaves the cursor exactly after the marker, after a property, or
  // after the item terminator; it cannot silently claim a gap. A stopped
  // property ends the item before its terminator is read.
  if (item.properties.some((property) => valueHasStop(property.value)))
    return !complete && itemEnd === cursor;
  return itemEnd === cursor + 1 || (!complete && itemEnd === cursor);
};

const collectionFollowsSource = (
  value: Extract<DelphiFormValue, { kind: "collection" }>,
): boolean => {
  let expected = value.location.offset;
  for (const [index, item] of value.items.entries()) {
    if (item.location.offset !== expected) return false;
    // A stopped property ends its item and the collection: the decoder
    // rethrows the stop instead of reading another item or the terminator.
    if (
      item.properties.some((property) => valueHasStop(property.value)) &&
      (value.terminated || index !== value.items.length - 1)
    )
      return false;
    // Every item of a terminated collection is complete; in a stopped
    // collection only the last item may carry an unfinished prefix.
    if (
      !collectionItemFollowsSource(
        item,
        value.terminated || index < value.items.length - 1,
      )
    )
      return false;
    expected = item.location.offset + item.location.bytes;
  }
  const end = value.location.offset + value.location.bytes;
  return value.terminated ? end === expected + 1 : end === expected;
};

const insideValue = (
  value: DelphiFormValue,
  within: (range: { offset: number; bytes: number }) => boolean,
  codePage: string,
  valueType: string | null = null,
  payloadEnd = 0,
): boolean => {
  if (valueType !== null && !valueMatchesType(valueType, value, codePage))
    return false;
  if (value.kind === "string")
    return (
      within(value.location) &&
      valuePageMatchesType(valueType, value.code_page, codePage)
    );
  if (value.kind === "list")
    return (
      within(value.location) &&
      listEntriesFollowSource(value) &&
      value.items.every(
        (entry) =>
          // A zero marker is the list terminator; every consumed nonzero
          // marker maps to a named type or unknown_value_type(n).
          entry.value_type !== "vaNull" &&
          entry.value_type !== "unknown" &&
          withinRange(entry.marker_location, value.location) &&
          entry.marker_location.bytes === 1 &&
          valueMatchesType(entry.value_type, entry.value, codePage) &&
          insideValue(
            entry.value,
            (range) => withinRange(range, value.location),
            codePage,
            null,
            payloadEnd,
          ),
      ) &&
      // A stopped list retains a final stopped entry unless it ended at EOF.
      (value.terminated ||
        value.items.some((entry) => valueHasStop(entry.value)) ||
        value.location.offset + value.location.bytes === payloadEnd)
    );
  if (value.kind === "set")
    return (
      within(value.location) &&
      setFollowsSource(value) &&
      value.names.every(
        (item) =>
          withinRange(item.location, value.location) &&
          nonEmptyTextMatchesBytes(item, codePage),
      )
    );
  if (value.kind === "collection")
    return (
      within(value.location) &&
      collectionFollowsSource(value) &&
      value.items.every(
        (item) =>
          withinRange(item.location, value.location) &&
          (item.position === null ||
            positionMatches(item.position, item.location)) &&
          propertiesFollowSource(item.properties) &&
          item.properties.every(
            (property) =>
              withinRange(property.location, item.location) &&
              withinRange(property.name.location, property.location) &&
              nonEmptyTextMatchesBytes(property.name, codePage) &&
              insideValue(
                property.value,
                (range) => withinRange(range, property.location),
                codePage,
                property.value_type,
                payloadEnd,
              ),
          ),
      )
    );
  return within(value.location);
};

const sameIdentity = (
  left: PeResourceIdentity | undefined,
  right: PeResourceIdentity,
): boolean =>
  left?.kind === "id" && right.kind === "id"
    ? left.id === right.id
    : left?.kind === "name" &&
      right.kind === "name" &&
      left.utf16le_hex === right.utf16le_hex;
