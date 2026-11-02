volatile int rea_tail_sink;

__attribute__((noinline, used)) int rea_tail_leaf(int value) {
  return value + 7;
}

__attribute__((noinline, used)) int rea_tail_direct(int value) {
  return rea_tail_leaf(value);
}

__attribute__((noinline, used)) int rea_tail_indirect(int (*target)(int), int value) {
  return target(value);
}

__attribute__((noinline, used)) int rea_tail_internal(int value) {
  while (value > 0) {
    rea_tail_sink += value;
    --value;
  }
  return rea_tail_sink;
}

int main(int argc, char **argv) {
  (void)argv;
  return rea_tail_direct(argc) + rea_tail_indirect(rea_tail_leaf, argc) +
         rea_tail_internal(argc);
}
