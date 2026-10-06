#include "authority.hpp"

namespace rea {

class Attributes {
  std::vector<unsigned char> storage_;
public:
  explicit Attributes(DWORD count) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    storage_.resize(size);
    require(InitializeProcThreadAttributeList(get(), count, 0, &size), "Initialize process attributes failed");
  }
  ~Attributes() { DeleteProcThreadAttributeList(get()); }
  LPPROC_THREAD_ATTRIBUTE_LIST get() { return reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data()); }
  void add(DWORD_PTR key, void* value, SIZE_T size) {
    require(UpdateProcThreadAttribute(get(), 0, key, value, size, nullptr, nullptr),
            "Windows atomic process attribute is unavailable");
  }
};

static Handle createJob() {
  Handle job(CreateJobObjectW(nullptr, nullptr));
  require(job.valid(), "Create owned Job Object failed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION policy{};
  policy.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &policy, sizeof(policy)),
          "Apply kill-on-owner-close Job Object policy failed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual{};
  require(QueryInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &actual, sizeof(actual), nullptr),
          "Read Job Object policy failed");
  require(actual.BasicLimitInformation.LimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
          "Job Object policy permits unexpected breakaway", L"", ERROR_ACCESS_DENIED);
  return job;
}

static void pipe(Handle& read, Handle& write) {
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE rawRead, rawWrite;
  require(CreatePipe(&rawRead, &rawWrite, &attributes, 0), "Create owned process output pipe failed");
  read.reset(rawRead); write.reset(rawWrite);
  require(SetHandleInformation(read.get(), HANDLE_FLAG_INHERIT, 0), "Protect process output handle inheritance failed");
}

std::unique_ptr<Process> spawnProcess(const std::wstring& command, const std::wstring& commandLine,
                                    const std::wstring& cwd, const std::vector<std::wstring>& environment) {
  const auto executable = ordinaryDriveSeparators(command);
  require(executable.size() >= 3 && executable[1] == L':' && executable[2] == L'\\',
          "Owned Windows process requires an absolute executable path", command, ERROR_INVALID_PARAMETER);
  auto result = std::make_unique<Process>();
  result->job = createJob();
  Handle stdoutWrite, stderrWrite;
  pipe(result->stdoutRead, stdoutWrite); pipe(result->stderrRead, stderrWrite);
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(input.valid(), "Open owned process null input failed");
  Attributes attributes(2);
  HANDLE job = result->job.get();
  attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job));
  std::array<HANDLE, 3> inherited{input.get(), stdoutWrite.get(), stderrWrite.get()};
  attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), sizeof(inherited));
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.get();
  startup.StartupInfo.hStdOutput = stdoutWrite.get();
  startup.StartupInfo.hStdError = stderrWrite.get();
  startup.lpAttributeList = attributes.get();
  // Windows environment names use ordinal case-insensitive comparison, not
  // locale collation or JavaScript's expanding Unicode uppercase conversion.
  auto orderedEnvironment = environment;
  auto keyLength = [&](const std::wstring& entry) {
    const auto end = entry.find(L'=', entry.front() == L'=' ? 1 : 0);
    require(end != std::wstring::npos && end > 0, "Invalid child environment name", command,
            ERROR_INVALID_PARAMETER);
    return static_cast<int>(end);
  };
  for (const auto& entry : orderedEnvironment) {
    require(!entry.empty(), "Empty child environment entry", command, ERROR_INVALID_PARAMETER);
    keyLength(entry);
  }
  auto compareNames = [&](const std::wstring& left, const std::wstring& right) {
    const auto result = CompareStringOrdinal(left.data(), keyLength(left), right.data(), keyLength(right), TRUE);
    require(result != 0, "Compare Windows environment names failed", command);
    return result;
  };
  std::stable_sort(orderedEnvironment.begin(), orderedEnvironment.end(),
                   [&](const std::wstring& left, const std::wstring& right) {
                     return compareNames(left, right) == CSTR_LESS_THAN;
                   });
  std::vector<std::wstring> uniqueEnvironment;
  for (auto& entry : orderedEnvironment) {
    if (!uniqueEnvironment.empty() && compareNames(uniqueEnvironment.back(), entry) == CSTR_EQUAL)
      uniqueEnvironment.back() = std::move(entry);
    else uniqueEnvironment.push_back(std::move(entry));
  }
  std::vector<wchar_t> variables;
  for (const auto& entry : uniqueEnvironment) {
    variables.insert(variables.end(), entry.begin(), entry.end()); variables.push_back(L'\0');
  }
  variables.push_back(L'\0');
  if (uniqueEnvironment.empty()) variables.push_back(L'\0');
  std::vector<wchar_t> line(commandLine.begin(), commandLine.end()); line.push_back(L'\0');
  PROCESS_INFORMATION process{};
  require(CreateProcessW(executable.c_str(), line.data(), nullptr, nullptr, TRUE,
                         CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                         variables.data(), cwd.empty() ? nullptr : cwd.c_str(), &startup.StartupInfo, &process),
          "Create process atomically inside owned Job Object failed", command);
  result->process.reset(process.hProcess);
  Handle thread(process.hThread);
  result->pid = process.dwProcessId;
  // An elevated token may default file ownership to Administrators. Normalize
  // only the suspended child's default owner so its runtime files belong to the
  // current user; the caller's token and privileges are not modified.
  HANDLE rawToken;
  require(OpenProcessToken(result->process.get(), TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &rawToken),
          "Open suspended process default-owner token failed", command);
  Handle token(rawToken);
  DWORD tokenSize = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &tokenSize);
  std::vector<unsigned char> tokenUser(tokenSize);
  require(GetTokenInformation(token.get(), TokenUser, tokenUser.data(), tokenSize, &tokenSize),
          "Read suspended process user identity failed", command);
  TOKEN_OWNER owner{reinterpret_cast<TOKEN_USER*>(tokenUser.data())->User.Sid};
  require(SetTokenInformation(token.get(), TokenOwner, &owner, sizeof(owner)),
          "Set suspended process file owner failed", command);
  DWORD_PTR affinity = 0, systemAffinity = 0;
  require(GetProcessAffinityMask(GetCurrentProcess(), &affinity, &systemAffinity),
          "Read caller process affinity failed", command);
  if (affinity != 0)
    require(SetProcessAffinityMask(result->process.get(), affinity), "Preserve caller process affinity failed", command);
  const DWORD priority = GetPriorityClass(GetCurrentProcess());
  require(priority != 0 && SetPriorityClass(result->process.get(), priority),
          "Preserve caller process priority failed", command);
  BOOL assigned = FALSE;
  if (!IsProcessInJob(result->process.get(), result->job.get(), &assigned) || !assigned) {
    TerminateJobObject(result->job.get(), 1);
    throw Failure("Suspended process has no owned Job Object membership", command, ERROR_ACCESS_DENIED);
  }
  require(ResumeThread(thread.get()) != MAXDWORD, "Resume job-owned process failed", command);
  return result;
}

static napi_value readOutput(napi_env env, Handle& read, bool& ended) {
  std::array<unsigned char, 65536> bytes;
  DWORD available = 0, count = 0;
  if (!read.valid()) ended = true;
  else if (!PeekNamedPipe(read.get(), nullptr, 0, nullptr, &available, nullptr)) {
    require(GetLastError() == ERROR_BROKEN_PIPE, "Observe owned process output failed");
    read.reset(); ended = true;
  } else if (available > 0) {
    require(ReadFile(read.get(), bytes.data(), std::min<DWORD>(available, bytes.size()), &count, nullptr),
            "Read owned process output failed");
  }
  napi_value result;
  check(napi_create_buffer_copy(env, count, bytes.data(), nullptr, &result));
  return result;
}

static DWORD activeProcesses(Process& process) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
  require(QueryInformationJobObject(process.job.get(), JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr),
          "Observe owned Job Object settlement failed");
  return state.ActiveProcesses;
}

static napi_value callerToken(napi_env env) {
  HANDLE raw;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &raw), "Read caller token failed");
  Handle token(raw);
  DWORD size;
  TOKEN_ELEVATION elevation{};
  require(GetTokenInformation(token.get(), TokenElevation, &elevation, sizeof(elevation), &size), "Read caller elevation failed");
  std::vector<unsigned char> user(4096), owner(4096), integrity(4096);
  require(GetTokenInformation(token.get(), TokenUser, user.data(), user.size(), &size) &&
          GetTokenInformation(token.get(), TokenOwner, owner.data(), owner.size(), &size) &&
          GetTokenInformation(token.get(), TokenIntegrityLevel, integrity.data(), integrity.size(), &size),
          "Read caller token observations failed");
  HANDLE rawImpersonation;
  require(DuplicateToken(token.get(), SecurityIdentification, &rawImpersonation), "Observe caller group membership failed");
  Handle impersonation(rawImpersonation);
  std::array<unsigned char, SECURITY_MAX_SID_SIZE> administrators;
  DWORD administratorSize = administrators.size();
  require(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators.data(), &administratorSize),
          "Create administrator group identity failed");
  BOOL administrator = FALSE, assigned = FALSE;
  require(CheckTokenMembership(impersonation.get(), administrators.data(), &administrator), "Read caller administrator membership failed");
  require(IsProcessInJob(GetCurrentProcess(), nullptr, &assigned), "Read caller job membership failed");
  const auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  auto result = object(env);
  set(env, result, "elevated", boolean(env, elevation.TokenIsElevated != 0));
  set(env, result, "administrator", boolean(env, administrator != FALSE));
  set(env, result, "integrityLevel", number(env, *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1)));
  set(env, result, "defaultOwnerIsUser", boolean(env, EqualSid(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,
                                                              reinterpret_cast<TOKEN_OWNER*>(owner.data())->Owner)));
  set(env, result, "inJob", boolean(env, assigned != FALSE));
  return result;
}

napi_value processCall(napi_env env, const std::wstring& operation, const std::vector<napi_value>& args) {
  if (operation == L"process_caller_token") {
    require(args.empty(), "Caller token observation takes no arguments", L"", ERROR_INVALID_PARAMETER);
    return callerToken(env);
  }
  if (operation == L"process_spawn") {
    require(args.size() == 4, "Wrong native process launch argument count", L"", ERROR_INVALID_PARAMETER);
    std::vector<std::wstring> environment;
    for (const auto& entry : array(env, args[3])) environment.push_back(wide(env, entry));
    auto process = spawnProcess(wide(env, args[0]), wide(env, args[1]), wide(env, args[2]), environment);
    auto result = object(env);
    set(env, result, "pid", number(env, process->pid));
    set(env, result, "jobAssigned", boolean(env, true));
    set(env, result, "killOnOwnerClose", boolean(env, true));
    set(env, result, "handle", wrap(env, std::move(process)));
    return result;
  }
  require(args.size() == 1, "Wrong native process handle argument count", L"", ERROR_INVALID_PARAMETER);
  auto& process = static_cast<Process&>(resource(env, args[0], Kind::Process));
  if (operation == L"process_poll") {
    auto result = object(env);
    bool stdoutEnded = false, stderrEnded = false;
    set(env, result, "stdout", readOutput(env, process.stdoutRead, stdoutEnded));
    set(env, result, "stderr", readOutput(env, process.stderrRead, stderrEnded));
    set(env, result, "stdoutEnded", boolean(env, stdoutEnded));
    set(env, result, "stderrEnded", boolean(env, stderrEnded));
    const auto exited = WaitForSingleObject(process.process.get(), 0);
    require(exited == WAIT_OBJECT_0 || exited == WAIT_TIMEOUT, "Observe owned process exit failed");
    DWORD code = 0;
    if (exited == WAIT_OBJECT_0) require(GetExitCodeProcess(process.process.get(), &code), "Read owned process exit code failed");
    set(env, result, "exitCode", exited == WAIT_OBJECT_0 ? number(env, code) : null(env));
    set(env, result, "activeProcesses", number(env, activeProcesses(process)));
    return result;
  }
  if (operation == L"process_alive") return number(env, activeProcesses(process));
  if (operation == L"process_terminate") {
    const auto active = activeProcesses(process);
    if (active > 0) require(TerminateJobObject(process.job.get(), 1), "Terminate owned Job Object failed");
    return boolean(env, active > 0);
  }
  if (operation == L"process_close") {
    // Closing the job is the crash-safe authority; no PID enumeration is used.
    process.job.reset(); process.process.reset(); process.stdoutRead.reset(); process.stderrRead.reset();
    process.closed = true;
    return null(env);
  }
  throw Failure("Unknown native process operation", L"", ERROR_INVALID_PARAMETER);
}

napi_value inspect(napi_env env) {
  wchar_t temp[32768];
  const auto length = GetTempPathW(32768, temp);
  require(length > 0 && length < 32768, "Read temporary directory coordinate failed");
  auto root = createRuntime(std::wstring(temp, length), L"rea-native-probe-");
  auto filesystem = identity(env, root->directory.get(), root->path);
  closeRuntime(*root);
  auto job = createJob();
  Attributes attributes(1);
  HANDLE raw = job.get();
  attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &raw, sizeof(raw));
  auto result = object(env);
  set(env, result, "abiVersion", number(env, 1));
  set(env, result, "nodeApiVersion", number(env, 8));
  set(env, result, "architecture", string(env, std::string("x64")));
  set(env, result, "filesystem", filesystem);
  set(env, result, "privateDacl", boolean(env, true));
  set(env, result, "atomicJobAssignment", boolean(env, true));
  set(env, result, "killOnOwnerClose", boolean(env, true));
  return result;
}

} // namespace rea
