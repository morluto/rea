/* A static layout witness, compiled and inspected but never loaded or run. */
struct NativeMethod {
    const char *name;
    const char *signature;
    void (*function)(void);
};
static void first(void) {}
static void second(void) {}
__attribute__((visibility("hidden"), used)) const struct NativeMethod methods[] = {
    {"first", "()V", first},
    {"second", "(I)V", second},
};
__attribute__((constructor)) static void initialize(void) {}
