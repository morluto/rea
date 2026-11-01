/**
 * Direct inventory operations admitted by the Ghidra adapter. All are reads
 * except the naming operations, which edit the ephemeral session database.
 */
export const GHIDRA_INVENTORY_OPERATIONS = [
  "read_binary_inventory_summary",
  "inspect_native_load_image",
  "read_bytes",
  "search_bytes",
  "address_to_file_offset",
  "address_name",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "procedure_address",
  "resolve_containing_procedure",
  "search_procedures",
  "search_strings",
  "set_address_name",
  "set_addresses_names",
] as const;
