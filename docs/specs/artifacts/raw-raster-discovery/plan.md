# Raw raster discovery implementation plan

1. Add pure sampled layout scoring in `src/domain/rawRasterDiscovery.ts`, reusing
   the explicit decoder's layout representation. Never allocate full RGBA during
   search; retain only the configured best candidates.
2. Use the existing local binary-diagnostics application and transport patterns,
   resource scopes, selected-source reads and Evidence envelope. Hash whole-file
   identity separately from the selected bytes. No new third-party provider.
3. Register one shared operation for CLI and MCP through canonical contracts.
   The proposal is technically callable but remains draft pending review of this
   explicit scope expansion. Do not mark the PR ready on the user's behalf.
4. Validate controls and measured behavior. Preserve false-positive and missed
   coverage limitations in every report, not only in documentation.

## Existing mechanisms

`inspect_firmware_regions` reports external signature candidates; reported lengths
are not independently validated. `inspect_byte_entropy` describes byte diversity,
not image identity. Neither supplies a reliable raw-image classifier. This work
adds bounded spatial-layout hypotheses, rather than another magic-signature list
or a profile-specific FordMap extractor. The latter's known descriptor tables and
palette addresses cannot establish general discovery quality.

## Preview continuation

A retained candidate's `layout` is the input to the branch's existing explicit
PNG workflow. Save that object as layout JSON, then run:

```sh
node --import tsx scripts/experiments/raw-raster-file.mjs INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY
```

Preview export is still an experimental adapter, not a production artifact
publisher. A candidate may be a subwindow or a false positive; inspect alternative
channel orders, row directions and neighbouring ranges rather than trusting rank.
