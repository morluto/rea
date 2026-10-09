#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <node_api.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace rea {

// Translate ordinary DOS drive separators without resolving components or
// changing extended, device, UNC, relative, or drive-relative namespaces.
inline std::wstring ordinaryDriveSeparators(std::wstring path) {
  if (path.size() >= 3 && path[1] == L':' &&
      ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
      (path[2] == L'\\' || path[2] == L'/'))
    std::replace(path.begin(), path.end(), L'/', L'\\');
  return path;
}

struct Failure : std::runtime_error {
  DWORD win32;
  std::wstring path;
  std::string constraint;
  Failure(std::string constraint, std::wstring path = L"", DWORD code = GetLastError())
      : std::runtime_error(constraint), win32(code), path(std::move(path)),
        constraint(std::move(constraint)) {}
};

inline void require(bool condition, const char* constraint, const std::wstring& path = L"") {
  if (!condition) {
    const auto code = GetLastError();
    throw Failure(constraint, path, code);
  }
}
inline void require(bool condition, const char* constraint, const std::wstring& path, DWORD code) {
  if (!condition) throw Failure(constraint, path, code);
}

class Handle {
  HANDLE value_ = INVALID_HANDLE_VALUE;
public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept { reset(other.release()); return *this; }
  HANDLE get() const { return value_; }
  bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE release() { return std::exchange(value_, INVALID_HANDLE_VALUE); }
  void reset(HANDLE next = INVALID_HANDLE_VALUE) {
    if (valid()) CloseHandle(value_);
    value_ = next;
  }
};

enum class Kind { File, Runtime, Process };
struct Resource {
  const Kind kind;
  bool closed = false;
  explicit Resource(Kind value) : kind(value) {}
  virtual ~Resource() = default;
};
struct File : Resource {
  std::wstring requestedPath;
  std::wstring path;
  std::vector<Handle> handles;
  explicit File(std::wstring path) : Resource(Kind::File), requestedPath(path), path(std::move(path)) {}
  HANDLE get() const { return handles.back().get(); }
};
struct Runtime : Resource {
  std::wstring path;
  std::vector<Handle> parents;
  Handle directory;
  std::vector<Handle> immutableFiles;
  // Main-thread admission is single-flight; only the accepted copy owns the
  // atomic cancellation flag consumed by its async worker. ERROR_BUSY rejects
  // another copy before it can reset that flag or replace pending ownership.
  bool snapshotPending = false;
  std::atomic_bool snapshotCancelled{false};
  Runtime() : Resource(Kind::Runtime) {}
};
struct Process : Resource {
  Handle job, process, stdoutRead, stderrRead, stdinWrite;
  bool inputPending = false;
  DWORD pid = 0;
  Process() : Resource(Kind::Process) {}
};

void check(napi_status status);
napi_value failureValue(napi_env env, const Failure& failure);
napi_value object(napi_env env);
napi_value string(napi_env env, const std::string& value);
napi_value string(napi_env env, const std::wstring& value);
napi_value number(napi_env env, double value);
napi_value boolean(napi_env env, bool value);
napi_value null(napi_env env);
void set(napi_env env, napi_value object, const char* key, napi_value value);
std::wstring wide(napi_env env, napi_value value);
double numeric(napi_env env, napi_value value);
std::vector<napi_value> array(napi_env env, napi_value value);
napi_value wrap(napi_env env, std::unique_ptr<Resource> resource);
Resource& resource(napi_env env, napi_value value, Kind kind);

std::unique_ptr<File> openFile(const std::wstring& path, DWORD access = GENERIC_READ,
                             bool directory = false);
napi_value identity(napi_env env, HANDLE handle, const std::wstring& path);
std::unique_ptr<Runtime> createRuntime(const std::wstring& parent, const std::wstring& prefix);
void closeRuntime(Runtime& runtime);
napi_value filesystemCall(napi_env env, const std::wstring& operation,
                          const std::vector<napi_value>& args);
std::unique_ptr<Process> spawnProcess(const std::wstring& command, const std::wstring& commandLine,
                                    const std::wstring& cwd, const std::vector<std::wstring>& environment,
                                    bool protocolStdin = false);
napi_value processCall(napi_env env, const std::wstring& operation,
                       const std::vector<napi_value>& args);
napi_value inspect(napi_env env);

} // namespace rea
