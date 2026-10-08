/** Native mapping facts retained when original-file coordinates cannot be verified. */
export interface FileOffsetPartialObservation {
  readonly operation: "address_to_file_offset";
  readonly address: string;
  readonly provider_file_offset: number;
  readonly provider_source_path: string | null;
  readonly provider_image_header_hex: string | null;
  readonly original_file_offset: {
    readonly available: false;
    readonly reason: string;
  };
}
