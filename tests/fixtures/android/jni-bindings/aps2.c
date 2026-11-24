/* Freestanding static-layout witness: never loaded, registered or invoked. */
struct NativeMethod { const char *name; const char *signature; void (*function)(void); };
static void first(void) {}
static void second(void) {}
static void third(void) {}
static void fourth(void) {}
extern void external(void);
__attribute__((visibility("hidden"), used)) const struct NativeMethod methods[] = {
    {"first", "()V", first}, {"second", "(I)V", second},
    {"third", "(J)V", third}, {"fourth", "([B)V", fourth},
    {"externalA", "()V", external}, {"externalB", "()V", external},
    {"externalC", "()V", external},
};
__attribute__((constructor)) static void initialize(void) {}
