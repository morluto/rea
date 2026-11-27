/* Built with -fPIC -shared and GCC's default semantic interposition, the call
   from rea_ghidra_shared_entry reaches rea_ghidra_shared_leaf through a PLT
   thunk that Ghidra names after its target. */
__attribute__((noinline, visibility("default"))) int rea_ghidra_shared_leaf(
    int value) {
  return value * 3 + 1;
}

__attribute__((noinline, visibility("default"))) int rea_ghidra_shared_entry(
    int value) {
  return rea_ghidra_shared_leaf(value) + 2;
}
