# Per-call EVM producer budgets

An analyst can raise or lower carrier, reply, diagnostic, address-space, file-output and CPU budgets without changing the selected artifact or restarting REA. Defaults stay 4 MiB carrier, 16 MiB reply/file, 1 MiB diagnostics, 3 GiB address space and 30 CPU seconds. `timeout_ms` remains the separate worker deadline.

Use the shared typed `producer_limits` contract, advertising only fields enforced by EVM. If `file_bytes` is omitted, it follows the selected `output_bytes`; an explicit file budget stays independent. Linux soft/hard limits retain the tighter inherited value, and failures distinguish configured from unknown effective limits and signal causes. Resource guidance identifies the exhausted field, its selected value and whether inherited restrictions can prevent repair. The 256 MiB worker heap stays explicit and independent.

Preserve carrier/decoded identities, metadata, target-free offline authority, cancellation, final cleanup and partial facts. Verify same-target recovery with a small selected allowance and narrower inherited-limit controls; report unavailable real Linux coverage.
