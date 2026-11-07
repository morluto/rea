#include <stdio.h>

static int twice(int value) {
  return value * 2;
}

struct aligned_record {
  char tag;
  int values[3];
  long long end;
};

static struct aligned_record record = {1, {2, 3, 4}, 9};

static int consume(struct aligned_record *value, int selector) {
  if (selector < 0) {
    return value->end;
  }
  return value->values[selector % 3];
}

int main(void) {
  puts("REA radare2 transport fixture");
  return twice(7) + consume(&record, 1);
}
