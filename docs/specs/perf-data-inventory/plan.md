# Plan

1. Read the `perf.data` header, derive byte order from the magic, and report the
   declared attribute and data extents with `within_file` rather than clamping.
2. Walk the attribute section by the declared stride: decode each
   `perf_event_attr` group's type, config, sample type, read format, declared
   period or frequency, and the `freq` bit for the recording's byte order.
3. Resolve each entry's `perf_file_section` ids extent, reject extents that are
   not whole identifiers or leave the file, and retain identifiers under a
   bounded allowance.
4. Derive coverage and the identifier inventory from what was actually read:
   an unreadable, truncated or over-allowance extent marks the inventory
   incomplete and raises a diagnostic instead of shortening it silently.
5. Bind event, diagnostic and recording ids to the artifact digest, and
   diagnostic ids additionally to the allowance they were produced under.
6. Register the CLI/MCP operation with complete-only delivery and document the
   returned inventory and its limitations.
7. Validate malformed, truncated, big-endian and allowance-exhausted recordings
   against the producer contract before requesting maintainer review.
