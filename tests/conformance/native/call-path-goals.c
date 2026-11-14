/* Direct-call graph oracle: two exported candidates and an indirect-only caller.
 * Compile without optimization/inlining. No target execution is required. */
#if defined(__GNUC__)
#define NOINLINE __attribute__((noinline, used))
#define EXPORT __attribute__((visibility("default")))
#else
#define NOINLINE
#define EXPORT
#endif
NOINLINE int rea_path_sink(int value) { return value + 1; }
NOINLINE static int rea_path_second(int value) { return rea_path_sink(value); }
NOINLINE static int rea_path_first(int value) { return rea_path_second(value); }
EXPORT NOINLINE int rea_path_export_reaches(int value) { return rea_path_first(value); }
EXPORT NOINLINE int rea_path_export_other(int value) { return value - 1; }
/* A caller may supply rea_path_sink, but this static graph cannot know the callback. */
NOINLINE static int rea_path_indirect(int value, int (*callback)(int)) {
  return callback(value);
}
