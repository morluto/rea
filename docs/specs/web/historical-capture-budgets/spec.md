# Historical capture admission budgets

Allow an analyst to inspect the same retained HAR, SAZ, qlog or native mitmproxy capture after explicitly increasing an exhausted input, reply or nesting budget. Keep existing defaults, producer identity, sensitive-value handling and complete-or-failure semantics.

The public contract accepts positive safe-integer `max_input_bytes` and `max_reply_bytes`, and `max_nesting_depth` up to REA's JSON representation depth minus the four enclosing record/reply/Evidence levels (996). Selected values apply to the admitted operation and its child decoder, source and reply readers, archive expansion and protobuf interpretation. They do not raise the separately owned worker heap, CPU or client transport limits.

Failures name the exhausted parameter and value and the next-call repair. Omitted values retain 32 MiB input, 96 MiB reply and 64 nesting levels. Evidence preserves explicit selections and omission.

Acceptance: the same valid capture rejected by a deliberately small selected budget succeeds after changing only that budget. A malformed control remains malformed. The child and parent enforce the same selected facts, and parallel operations keep distinct policies.
