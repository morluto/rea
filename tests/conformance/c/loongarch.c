/* Source-owned LoongArch fixture; the verifier never executes this code. */
int rea_loongarch_global = 42;

int rea_loongarch_add(int a, int b) {
  return a + b + rea_loongarch_global;
}

int rea_loongarch_entry(int value) { return rea_loongarch_add(value, 3); }
