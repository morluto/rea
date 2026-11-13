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
  DELPHI_FORM_FLOAT_NOTES,
  decodeDelphiExtended,
  decodeDelphiText,
  formatDelphiCurrency,
  isDelphiFormValueType,
  MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES,
  RESOURCE_CODE_PAGES,
  type DelphiFormObject,
  type DelphiFormPosition,
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
              MAX_DELPHI_FORM_SIGNATURE_PREFIX_BYTES;
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
        insideLocations(form.root, within, form.code_page)
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
    return value.items.some((entry) => valueHasStop(entry.value));
  if (value.kind === "collection")
    return value.items.some((item) =>
      item.properties.some((property) => valueHasStop(property.value)),
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
const textMatchesBytes = (item: DelphiFormText, codePage: string): boolean => {
  const raw = Buffer.from(item.bytes_hex, "hex");
  return (
    item.code_page === codePage &&
    item.location.bytes === 1 + raw.length &&
    decodeDelphiText(raw, codePage) === item.text
  );
};

/** Every nested location of a decoded form must stay inside its owner. */
const insideLocations = (
  object: DelphiFormObject,
  within: (range: { offset: number; bytes: number }) => boolean,
  codePage: string,
  payloadWithin: (range: { offset: number; bytes: number }) => boolean = within,
): boolean => {
  if (!within(object.location)) return false;
  if (
    object.unknown !== null &&
    // The producer stops an object at the point its unknown starts, so a gap
    // between them would leave bytes claimed by neither.
    (!payloadWithin(object.unknown.location) ||
      object.unknown.location.offset !==
        object.location.offset + object.location.bytes)
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
  return (
    object.properties.every(
      (property) =>
        withinRange(property.location, object.location) &&
        text(property.name, property.location) &&
        insideValue(
          property.value,
          (range) => withinRange(range, property.location),
          codePage,
          property.value_type,
        ),
    ) &&
    object.children.every((child) =>
      insideLocations(
        child,
        (range) => withinRange(range, object.location),
        codePage,
        payloadWithin,
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
  vaLString: { prefixBytes: 4, previewBytes: 128, wide: false },
  vaUTF8String: { prefixBytes: 4, previewBytes: 128, wide: false },
  vaWString: { prefixBytes: 4, previewBytes: 128, wide: true },
  vaUString: { prefixBytes: 4, previewBytes: 128, wide: true },
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
  if (value.decode_truncated)
    return value.truncated && available <= value.declared_bytes;
  if (
    available !== value.declared_bytes ||
    value.truncated !== value.declared_bytes > projection.previewBytes
  )
    return false;
  // A complete projection retains every source byte, so its published text
  // must be exactly what those bytes decode to under the reported page.
  return (
    value.truncated ||
    decodeDelphiText(Buffer.from(value.bytes_hex, "hex"), value.code_page) ===
      value.text
  );
};

const binaryMatches = (
  value: Extract<DelphiFormValue, { kind: "binary" }>,
): boolean => {
  const available = value.location.bytes - 4;
  const retained = value.bytes_hex.length / 2;
  if (available < 0 || retained !== Math.min(available, 128)) return false;
  if (value.decode_truncated)
    return value.truncated && available <= value.declared_bytes;
  return (
    available === value.declared_bytes &&
    value.truncated === value.declared_bytes > 128
  );
};

/** `vaIdent` is a short string: one length byte plus its retained bytes. */
const identifierMatches = (
  value: Extract<DelphiFormValue, { kind: "identifier" }>,
  codePage: string,
): boolean => {
  const raw = Buffer.from(value.bytes_hex, "hex");
  return (
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
  if (value.kind === "unknown") return true;
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

const insideValue = (
  value: DelphiFormValue,
  within: (range: { offset: number; bytes: number }) => boolean,
  codePage: string,
  valueType: string | null = null,
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
      value.items.every(
        (entry) =>
          withinRange(entry.marker_location, value.location) &&
          entry.marker_location.bytes === 1 &&
          valueMatchesType(entry.value_type, entry.value, codePage) &&
          insideValue(
            entry.value,
            (range) => withinRange(range, value.location),
            codePage,
          ),
      )
    );
  if (value.kind === "set")
    return (
      within(value.location) &&
      value.names.every(
        (item) =>
          withinRange(item.location, value.location) &&
          textMatchesBytes(item, codePage),
      )
    );
  if (value.kind === "collection")
    return (
      within(value.location) &&
      value.items.every(
        (item) =>
          withinRange(item.location, value.location) &&
          (item.position === null ||
            positionMatches(item.position, item.location)) &&
          item.properties.every(
            (property) =>
              withinRange(property.location, item.location) &&
              withinRange(property.name.location, property.location) &&
              textMatchesBytes(property.name, codePage) &&
              insideValue(
                property.value,
                (range) => withinRange(range, property.location),
                codePage,
                property.value_type,
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
