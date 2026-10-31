/* Synthetic protocol faults only; never opens or executes the selected target. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int request(const char *method) {
  char line[4096];
  return fgets(line, sizeof(line), stdin) && strstr(line, method);
}

int main(void) {
  const char *mode = getenv("REA_FAULT_MODE");
  const char *transport = getenv("REA_FAULT_TRANSPORT");
  int pipe = !strcmp(transport, "r2pipe");
  int mcp = !strcmp(transport, "r2mcp");
  setbuf(stdout, NULL);
  if (pipe) putchar(0);
  FILE *ready = fopen(getenv("REA_FAULT_READY"), "w");
  if (!ready) return 1;
  fprintf(ready, "%d", getpid());
  fclose(ready);
  if (!strcmp(mode, "environment")) {
    const char *path = getenv("REA_FAULT_ENV_REPORT");
    FILE *report = fopen(path, "w");
    if (!report) return 4;
    fprintf(report, "%s\n%s\n", getenv("REA_FAULT_OMITTED") ? "inherited" : "absent",
        getenv("REA_FAULT_SELECTED"));
    fclose(report);
  }
  if (!strncmp(mode, "final-hash-", 11)) {
    const char *target = getenv("REA_FAULT_TARGET");
    if (!strcmp(mode, "final-hash-timeout")) {
      if (truncate(target, (off_t)4 * 1024 * 1024 * 1024)) return 2;
    } else if (!strcmp(mode, "final-hash-changed")) {
      FILE *changed = fopen(target, "a");
      if (!changed) return 3;
      fputs(" changed", changed);
      fclose(changed);
    } else if (unlink(target)) return 3;
    fputs("{\"error\":false,\"code\":0,\"res\":\"completed-native-reply\"}", stdout);
    fputs("completed-native-stderr\n", stderr);
    return 0;
  }
  if (!strcmp(mode, "blocked")) {
    for (;;) pause();
  }
  if (!strcmp(mode, "mcp-success")) {
    if (!request("initialize")) return 5;
    puts("{ \"jsonrpc\":\"2.0\",\"id\":1,\"extra\":\"preserved\",\"result\":{\"protocolVersion\":\"2024-11-05\",\"serverInfo\":{\"name\":\"fixture\",\"version\":\"1\"},\"capabilities\":{\"tools\":{}}}}");
    if (!request("notifications/initialized") || !request("tools/list")) return 6;
    puts("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{\"level\":\"info\",\"data\":\"retained notification\"}}");
    const char *catalog = getenv("REA_FAULT_CATALOG");
    fputs("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":", stdout);
    fputs(catalog ? catalog : "{\"tools\":[{\"name\":\"open_file\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"run_command\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}]}", stdout);
    puts("}");
    if (!request("open_file")) return 7;
    puts("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[]}}");
    if (!request("run_command")) return 8;
    puts("{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"error\\\":false,\\\"code\\\":0,\\\"res\\\":\\\"native reply\\\"}\"}]}}");
    while (getchar() != EOF) {}
    return 0;
  }
  if (pipe || mcp) {
    int c;
    while ((c = getchar()) != '\n' && c != EOF) {}
  }
  if (!strcmp(mode, "partial")) {
    fputs("{\"res\":\"partial-", stdout);
    putchar(0xff);
    for (;;) pause();
  }
  if (!strcmp(mode, "overflow")) {
    char chunk[65536];
    memset(chunk, 'x', sizeof(chunk));
    for (int i = 0; i < 17 * 16; i++) fwrite(chunk, 1, sizeof(chunk), stdout);
    if (pipe) putchar(0);
    return 0;
  }
  if (!strcmp(mode, "completed") || !strcmp(mode, "linger") || !strcmp(mode, "environment")) {
    fputs("{\"error\":false,\"code\":0,\"res\":\"completed-native-reply\"}", stdout);
    if (pipe) putchar(0);
    if (mcp) putchar('\n');
    if (!strcmp(mode, "linger")) for (;;) pause();
    while (getchar() != EOF) {}
    return 0;
  }
  if (mcp) fputs("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"", stdout);
  else fputs("{\"error\":false,\"code\":0,\"res\":\"", stdout);
  putchar(0xff);
  fputs("\"}", stdout);
  if (pipe) putchar(0);
  if (mcp) putchar('\n');
  if (pipe || mcp) {
    while (getchar() != EOF) {}
  }
  return 0;
}
