inline int process_value = 7;
inline thread_local int thread_value = 11;
extern "C" int *process_address() { return &process_value; }
extern "C" int *thread_address() { return &thread_value; }
