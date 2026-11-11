# Implementation plan

1. Declare caller budgets in the domain input and derive one immutable provider policy with existing defaults.
2. Carry that policy in private child requests and scope all parser/read/reply consumers to it without global mutable state.
3. Update exact recovery, CLI controls and Evidence parameters; verify selected-budget recovery and default regressions.
