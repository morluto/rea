# Implementation plan

Register the shared snapshot selection flag on `trace-native-values`. The
existing direct-analysis options mapper already passes that flag to snapshot
admission and publication. The trace's existing Evidence publication path
continues to collect the exact linked source records before closing the session.

Exercise the one-shot CLI with a deterministic snapshot-capable test provider.
Validate eligible replay and source identity with Ghidra where available.
