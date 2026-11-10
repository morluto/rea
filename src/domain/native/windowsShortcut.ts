import { z } from "zod";

import { digestSchema } from "../digests.js";
import { fixedTupleSchema } from "../fixedTupleSchema.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const uint16 = z.number().int().min(0).max(0xffff);
const int32 = z.number().int().min(-0x80000000).max(0x7fffffff);
const range = z.strictObject({ offset: uint, bytes: uint });
const decimalUint64 = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const guidSchema = z
  .string()
  .regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u);
const macSchema = z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/u);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_WINDOWS_SHORTCUT_FILE_BYTES = 16 * 1024 * 1024;
/** Hard ceiling on LinkTargetIDList items examined in one report. */
export const MAX_INSPECT_WINDOWS_SHORTCUT_ID_LIST_ITEMS = 4096;
/** Hard ceiling on ExtraData blocks examined in one report. */
export const MAX_INSPECT_WINDOWS_SHORTCUT_EXTRA_DATA_BLOCKS = 1024;
/** Hard ceiling on retained string payload bytes across StringData, LinkInfo, and ExtraData. */
export const MAX_INSPECT_WINDOWS_SHORTCUT_STRING_BYTES = 1024 * 1024;

/** Complete bounded inspection of one Windows Shell Link (.lnk) file. */
export const inspectWindowsShortcutInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a Windows Shell Link (.lnk) file",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(76)
    .max(MAX_INSPECT_WINDOWS_SHORTCUT_FILE_BYTES)
    .default(1048576)
    .describe("Maximum stable artifact bytes to read (default 1 MiB)"),
  max_id_list_items: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_WINDOWS_SHORTCUT_ID_LIST_ITEMS)
    .default(256)
    .describe(
      "Maximum LinkTargetIDList items to examine; exceeding the budget fails without partial success",
    ),
  max_extra_data_blocks: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_WINDOWS_SHORTCUT_EXTRA_DATA_BLOCKS)
    .default(64)
    .describe(
      "Maximum ExtraData blocks to examine; exceeding the budget fails without partial success",
    ),
  max_string_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_WINDOWS_SHORTCUT_STRING_BYTES)
    .default(65536)
    .describe(
      "Maximum retained string payload bytes across StringData, LinkInfo, and ExtraData (default 64 KiB)",
    ),
});
export type InspectWindowsShortcutInput = z.infer<
  typeof inspectWindowsShortcutInputSchema
>;

const fileTimeSchema = z.strictObject({
  raw: decimalUint64,
  iso8601: z.string().nullable(),
});

const namedBitsSchema = z.strictObject({
  raw: uint,
  decoded: z.array(z.string().min(1)),
});

const showCommandSchema = z.strictObject({
  raw: uint,
  decoded: z.enum(["normal", "maximized", "minimized"]),
});

const hotKeySchema = z.strictObject({
  raw: uint16,
  modifiers: z.array(z.enum(["shift", "control", "alt"])),
  virtual_key: uint16.nullable(),
  virtual_key_name: z.string().min(1).nullable(),
});

const stringFieldSchema = z.strictObject({
  encoding: z.enum(["ansi", "unicode"]),
  count_characters: uint16,
  byte_length: uint,
  value: z.string(),
  location: range,
});

const idListRootSchema = z.strictObject({
  kind: z.literal("root_folder"),
  offset: uint,
  size: uint,
  type_byte: uint,
  sort_index: uint,
  folder_id: guidSchema,
});

const idListVolumeSchema = z.strictObject({
  kind: z.literal("volume"),
  offset: uint,
  size: uint,
  type_byte: uint,
  name: z.string(),
});

const idListFileSchema = z.strictObject({
  kind: z.literal("file_entry"),
  offset: uint,
  size: uint,
  type_byte: uint,
  entry_class: z.enum(["file", "directory"]),
  file_size: uint,
  short_name: z.string(),
});

const idListRawSchema = z.strictObject({
  kind: z.literal("raw"),
  offset: uint,
  size: uint,
  type_byte: uint,
  sha256: digestSchema,
});

const idListItemSchema = z.discriminatedUnion("kind", [
  idListRootSchema,
  idListVolumeSchema,
  idListFileSchema,
  idListRawSchema,
]);

const driveTypeSchema = z.strictObject({
  raw: uint,
  name: z
    .enum([
      "unknown",
      "no_root_dir",
      "removable",
      "fixed",
      "remote",
      "cdrom",
      "ramdisk",
    ])
    .nullable(),
});

const volumeSchema = z.strictObject({
  drive_type: driveTypeSchema,
  serial: z.string().regex(/^[0-9A-F]{8}$/u),
  label: z.string().nullable(),
  label_unicode: z.string().nullable(),
});

const networkLinkSchema = z.strictObject({
  net_name: z.string().nullable(),
  net_name_unicode: z.string().nullable(),
  device_name: z.string().nullable(),
  device_name_unicode: z.string().nullable(),
  network_provider_type: uint.nullable(),
});

const linkInfoSchema = z.strictObject({
  location: range,
  header_size: uint,
  flags: z.strictObject({
    raw: uint,
    volume_id_and_local_base_path: z.boolean(),
    common_network_relative_link_and_path_suffix: z.boolean(),
  }),
  volume: volumeSchema.nullable(),
  local_base_path: z.string().nullable(),
  local_base_path_unicode: z.string().nullable(),
  common_network_relative_link: networkLinkSchema.nullable(),
  common_path_suffix: z.string().nullable(),
  common_path_suffix_unicode: z.string().nullable(),
});

const uuidV1DerivedSchema = z.strictObject({
  evidence_kind: z.literal("derived"),
  version: z.literal(1),
  mac: macSchema,
  timestamp_iso8601: z.string().nullable(),
  timestamp_100ns: decimalUint64,
});

const guidPairSchema = fixedTupleSchema([guidSchema, guidSchema]);
const uuidV1PairSchema = fixedTupleSchema([
  uuidV1DerivedSchema.nullable(),
  uuidV1DerivedSchema.nullable(),
]);

const extraDecodedSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("environment_variable"),
    target_ansi: z.string(),
    target_unicode: z.string(),
  }),
  z.strictObject({
    kind: z.literal("icon_environment"),
    target_ansi: z.string(),
    target_unicode: z.string(),
  }),
  z.strictObject({
    kind: z.literal("tracker"),
    machine_id: z.string(),
    droid: guidPairSchema,
    birth_droid: guidPairSchema,
    droid_uuid_v1: uuidV1PairSchema,
    birth_droid_uuid_v1: uuidV1PairSchema,
  }),
  z.strictObject({
    kind: z.literal("known_folder"),
    folder_id: guidSchema,
    item_offset: uint,
  }),
  z.strictObject({
    kind: z.literal("special_folder"),
    folder_id: uint,
    item_offset: uint,
  }),
  z.strictObject({
    kind: z.literal("console_fe"),
    code_page: uint,
  }),
  z.strictObject({
    kind: z.literal("property_store"),
    bytes: uint,
    sha256: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("raw"),
    bytes: uint,
    sha256: digestSchema,
  }),
]);

const extraDataBlockSchema = z.strictObject({
  offset: uint,
  size: uint,
  signature: uint,
  signature_name: z.string().min(1).nullable(),
  decoded: extraDecodedSchema,
});

const argumentsPresentObservationSchema = z.strictObject({
  kind: z.literal("arguments_present"),
  evidence_kind: z.literal("derived"),
  value: z.boolean().nullable(),
});
const argumentLengthObservationSchema = z.strictObject({
  kind: z.literal("argument_length"),
  evidence_kind: z.literal("derived"),
  characters: uint.nullable(),
});
const targetExtensionObservationSchema = z.strictObject({
  kind: z.literal("target_extension"),
  evidence_kind: z.literal("derived"),
  extension: z.string().nullable(),
});
const showCommandMinimizedObservationSchema = z.strictObject({
  kind: z.literal("show_command_minimized"),
  evidence_kind: z.literal("derived"),
  value: z.boolean(),
});
const iconLocationDiffersObservationSchema = z.strictObject({
  kind: z.literal("icon_location_differs_from_target"),
  evidence_kind: z.literal("derived"),
  value: z.boolean().nullable(),
});

const issueSchema = z.strictObject({
  code: z.enum([
    "truncated",
    "block_size_overrun",
    "odd_unicode_length",
    "malformed_structure",
    "missing_extra_data_block",
  ]),
  offset: uint,
  message: z.string().min(1),
});

const coverageSchema = z.strictObject({
  status: z.enum(["complete", "partial"]),
  reason: z.string().min(1).nullable(),
  examined_id_list_items: uint,
  examined_extra_data_blocks: uint,
  failing_offset: uint.nullable(),
});

/** Static Shell Link inventory of one .lnk file, read without resolving the target. */
export const windowsShortcutSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  header: z.strictObject({
    location: range,
    header_size: uint,
    clsid: guidSchema,
    link_flags: namedBitsSchema,
    file_attributes: namedBitsSchema,
    creation_time: fileTimeSchema,
    access_time: fileTimeSchema,
    write_time: fileTimeSchema,
    file_size: uint,
    icon_index: int32,
    show_command: showCommandSchema,
    hotkey: hotKeySchema,
  }),
  id_list: z
    .strictObject({
      location: range,
      byte_size: uint16,
      item_count: uint,
      items: z.array(idListItemSchema),
    })
    .nullable(),
  link_info: linkInfoSchema.nullable(),
  string_data: z.strictObject({
    name: stringFieldSchema.nullable(),
    relative_path: stringFieldSchema.nullable(),
    working_dir: stringFieldSchema.nullable(),
    arguments: stringFieldSchema.nullable(),
    icon_location: stringFieldSchema.nullable(),
  }),
  extra_data: z.strictObject({
    blocks: z.array(extraDataBlockSchema),
    terminal_offset: uint.nullable(),
  }),
  observations: fixedTupleSchema([
    argumentsPresentObservationSchema,
    argumentLengthObservationSchema,
    targetExtensionObservationSchema,
    showCommandMinimizedObservationSchema,
    iconLocationDiffersObservationSchema,
  ]),
  coverage: coverageSchema,
  issues: z.array(issueSchema),
  limitations: z.array(z.string().min(1)),
});
export type WindowsShortcut = z.infer<typeof windowsShortcutSchema>;
export type WindowsShortcutIdListItem = z.infer<typeof idListItemSchema>;
export type WindowsShortcutExtraDataBlock = z.infer<
  typeof extraDataBlockSchema
>;
export type WindowsShortcutIssue = z.infer<typeof issueSchema>;
export type WindowsShortcutStringField = z.infer<typeof stringFieldSchema>;
export type WindowsShortcutUuidV1 = z.infer<typeof uuidV1DerivedSchema>;
