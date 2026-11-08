# Analysis snapshot selection for native value traces

[Design discussion](https://github.com/morluto/rea/issues/8781)

The one-shot `trace-native-values` command can export the source Evidence it
cites. Let callers also select a prior analysis snapshot so eligible source
observations can be reused with their original Evidence IDs.

Use the existing `--snapshot <path>` load and update semantics. The shared
snapshot workflow checks compatibility with the selected target and provider.
An eligible replay keeps its original source ID and replay limitation.
The optional Evidence bundle still contains the source records cited by the
trace. The snapshot and the Evidence bundle serve separate purposes and use
separate paths.

Acceptance covers a fresh snapshot, an eligible replay with portable Evidence,
and a snapshot from a different target. Providers retain their own replay
policies.
