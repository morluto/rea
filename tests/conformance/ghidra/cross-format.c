typedef int (*rea_cross_callback)(int);

volatile int rea_cross_global = 7;
const volatile char rea_cross_message[] = "REA_GHIDRA_CROSS_FORMAT";

__attribute__((noinline, used)) int rea_cross_leaf(int value) {
  return value + rea_cross_global + rea_cross_message[0] - 'R';
}

__attribute__((noinline, used)) int rea_cross_branch(int value) {
  if (value > 10) {
    return rea_cross_leaf(value);
  }
  return rea_cross_leaf(-value);
}

__attribute__((noinline, used)) int rea_cross_indirect(
    rea_cross_callback callback, int value) {
  return callback(value);
}

__attribute__((noinline, used, visibility("default"))) int rea_cross_entry(void) {
  return rea_cross_branch(35) + rea_cross_indirect(rea_cross_leaf, 0);
}

__attribute__((used, visibility("default"))) void rea_cross_start(void) {
  volatile int result = rea_cross_entry();
  (void)result;
  for (;;) {
  }
}
