#ifdef _WIN32
#define REA_EXPORT __declspec(dllexport)
#define REA_NOINLINE __declspec(noinline)
#else
#define REA_EXPORT __attribute__((visibility("default")))
#define REA_NOINLINE __attribute__((noinline))
#endif

REA_EXPORT REA_NOINLINE int rea_fixture_add(int left, int right) {
  return left + right + 7;
}

int main(void) {
  return rea_fixture_add(11, 24);
}
