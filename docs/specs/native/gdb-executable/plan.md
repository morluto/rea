# Implementation plan

The contract owns the optional input. MCP bindings and the one-shot CLI forward
it to `GdbSessionManager`; the manager owns path admission, file observation,
protocol startup and publication.

Extract Rizin's existing stable launch-file observation into one shared debugger
helper. Each manager retains failed file handles in its existing resource scope
or an equivalent startup scope drained by shutdown and cleanup retry. Preserve
Rizin's current outcome policy and caller-path semantics.
Completed hash facts also survive cancellation or failed final descriptor close
in both managers; startup still fails, retaining the exact failed cleanup owner.

Observe the file once per admitted GDB start, before dialect negotiation. Pass
the same observation into each protocol attempt. The adapter quotes the load
path using its MI string owner and requires a complete successful reply. A
refused file load is a semantic startup failure, not a reason to repeat it with
another MI dialect.

One GDB Evidence producer attaches the session's immutable initial selection and
its provenance to ordinary and partial observations. Native and simulated tests
exercise the public adapters and the startup lifecycle boundaries. Update the
owning CLI/Evidence documentation and regenerate ignored catalogs as required.
