volatile int rea_project_global = 7;
__attribute__((noinline, used)) int rea_project_leaf(int x) {
  return x + rea_project_global;
}
__attribute__((noinline, used)) int rea_project_caller(int x) {
  return rea_project_leaf(x);
}
__attribute__((noinline, used)) int rea_project_other(int x) {
  return x - rea_project_global;
}
__attribute__((noinline, used)) int rea_project_callback(int (*fn)(int), int x) {
  return fn(x) + rea_project_global;
}
int main(void) { return rea_project_caller(rea_project_global); }
