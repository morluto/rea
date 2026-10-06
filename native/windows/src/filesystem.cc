#include "authority.hpp"
#include <sddl.h>
#include <winternl.h>

namespace rea {

static std::wstring hex(const unsigned char* bytes, size_t count) {
  constexpr wchar_t digits[] = L"0123456789abcdef";
  std::wstring result;
  for (size_t index = 0; index < count; ++index) {
    result += digits[bytes[index] >> 4]; result += digits[bytes[index] & 15];
  }
  return result;
}

static std::wstring localPath(std::wstring path) {
  path = ordinaryDriveSeparators(std::move(path));
  if (path.rfind(L"\\\\?\\", 0) == 0) path.erase(0, 4);
  require(path.size() >= 3 && path[1] == L':' && path[2] == L'\\' &&
          ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')),
          "Only absolute local NTFS drive paths are supported", path, ERROR_NOT_SUPPORTED);
  require(path.find(L'/', 0) == std::wstring::npos && path.find(L':', 2) == std::wstring::npos,
          "Alternate streams and non-local path syntax are unsupported", path, ERROR_NOT_SUPPORTED);
  require(GetDriveTypeW(path.substr(0, 3).c_str()) == DRIVE_FIXED,
          "Only fixed local NTFS volumes are supported", path, ERROR_NOT_SUPPORTED);
  if (path.size() > 3 && path.back() == L'\\') path.pop_back();
  require(path.size() == 3 || path.back() != L'\\', "Repeated path separators are unsupported", path, ERROR_NOT_SUPPORTED);
  size_t begin = 3;
  while (begin < path.size()) {
    const auto end = path.find(L'\\', begin);
    const auto component = path.substr(begin, end == std::wstring::npos ? end : end - begin);
    require(!component.empty() && component != L"." && component != L".." &&
            component.back() != L'.' && component.back() != L' ',
            "Ambiguous Windows path component is unsupported", path, ERROR_NOT_SUPPORTED);
    if (end == std::wstring::npos) break;
    begin = end + 1;
  }
  return path;
}

static Handle openComponent(const std::wstring& path, DWORD access, bool directory, DWORD sharing = FILE_SHARE_READ) {
  // Attribute-only opens do not participate in Windows share-access checks.
  // Directory guards need FILE_LIST_DIRECTORY to prevent replacement and
  // in-place reparse conversion while descendant paths are being consumed.
  Handle handle(CreateFileW((L"\\\\?\\" + path).c_str(), access | FILE_READ_ATTRIBUTES | READ_CONTROL |
                           (directory ? FILE_LIST_DIRECTORY : 0),
                           sharing, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  require(handle.valid(), "Open Windows path component failed", path);
  FILE_ATTRIBUTE_TAG_INFO info{};
  require(GetFileInformationByHandleEx(handle.get(), FileAttributeTagInfo, &info, sizeof(info)),
          "Read Windows path attributes failed", path);
  if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
    throw Failure("Reparse path component is unsupported (tag " + std::to_string(info.ReparseTag) + ")",
                  path, ERROR_NOT_SUPPORTED);
  require(((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory,
          directory ? "Expected a directory path component" : "Target is not a regular file", path,
          directory ? ERROR_PATH_NOT_FOUND : ERROR_DIRECTORY);
  require(GetFileType(handle.get()) == FILE_TYPE_DISK, "Windows object is not a disk file", path, ERROR_NOT_SUPPORTED);
  return handle;
}

std::unique_ptr<File> openFile(const std::wstring& requested, DWORD access, bool directory) {
  auto result = std::make_unique<File>(localPath(requested));
  result->requestedPath = requested;
  const auto& path = result->path;
  require(directory || path.size() > 3, "Target is not a regular file", requested, ERROR_DIRECTORY);
  result->handles.push_back(openComponent(path.substr(0, 3), 0, true));
  wchar_t filesystem[64]{};
  DWORD flags = 0;
  require(GetVolumeInformationByHandleW(result->handles.front().get(), nullptr, 0, nullptr, nullptr,
                                       &flags, filesystem, 64), "Read volume semantics failed", path);
  require(std::wstring(filesystem) == L"NTFS" && (flags & FILE_PERSISTENT_ACLS) != 0,
          "Backing volume must be NTFS with persistent ACLs", path, ERROR_NOT_SUPPORTED);
  size_t offset = 3;
  while (offset < path.size()) {
    auto end = path.find(L'\\', offset);
    const bool final = end == std::wstring::npos;
    auto child = openComponent(path.substr(0, end), final ? access : 0, !final || directory);
    // Once the next component is pinned against deletion, its parent cannot
    // become empty and NTFS cannot convert that parent into a reparse point.
    // Relax only ancestor write sharing so unrelated child renames can proceed.
    // Independent evidence: tests/fixtures/windows/processBoundary.cc attempts
    // FSCTL_SET_REPARSE_POINT on the nonempty pinned ancestor and observes denial.
    // SUBST aliases and mounted-folder/reparse namespace variants are outside
    // the admitted P0 evidence; requested and final handle paths remain distinct.
    const auto parentPath = offset == 3 ? path.substr(0, 3) : path.substr(0, offset - 1);
    result->handles.back() = openComponent(parentPath, 0, true, FILE_SHARE_READ | FILE_SHARE_WRITE);
    result->handles.push_back(std::move(child));
    if (final) break;
    offset = end + 1;
  }
  return result;
}

napi_value identity(napi_env env, HANDLE handle, const std::wstring& path) {
  FILE_ID_INFO info{};
  require(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)),
          "Stable 128-bit Windows file identity is unavailable", path);
  std::array<wchar_t, 32768> finalPath;
  const auto length = GetFinalPathNameByHandleW(handle, finalPath.data(), finalPath.size(), FILE_NAME_NORMALIZED);
  require(length > 0 && length < finalPath.size(), "Read final handle path failed", path);
  LARGE_INTEGER size{};
  FILE_STANDARD_INFO standard{};
  require(GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)),
          "Read handle metadata failed", path);
  size = standard.EndOfFile;
  require(size.QuadPart >= 0 && size.QuadPart <= 9007199254740991LL, "File size exceeds exact numeric representation", path,
          ERROR_NOT_SUPPORTED);
  auto result = object(env);
  set(env, result, "requestedPath", string(env, path));
  set(env, result, "finalPath", string(env, std::wstring(finalPath.data(), length)));
  set(env, result, "filesystem", string(env, std::string("NTFS")));
  std::array<unsigned char, 8> serial;
  for (size_t index = 0; index < serial.size(); ++index)
    serial[index] = static_cast<unsigned char>(info.VolumeSerialNumber >> ((7 - index) * 8));
  set(env, result, "volumeSerial", string(env, hex(serial.data(), serial.size())));
  set(env, result, "fileId", string(env, hex(info.FileId.Identifier, 16)));
  set(env, result, "size", number(env, static_cast<double>(size.QuadPart)));
  set(env, result, "directory", boolean(env, standard.Directory != FALSE));
  return result;
}

struct Security {
  std::vector<unsigned char> user;
  std::array<unsigned char, SECURITY_MAX_SID_SIZE> system{};
  std::vector<unsigned char> acl;
  SECURITY_DESCRIPTOR descriptor{};
  PSID userSid() const { return reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid; }
  Security() {
    Handle token;
    HANDLE raw;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), "Read current user token failed");
    token.reset(raw);
    DWORD size = 0;
    GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
    user.resize(size);
    require(GetTokenInformation(token.get(), TokenUser, user.data(), size, &size), "Read current user SID failed");
    DWORD systemSize = system.size();
    require(CreateWellKnownSid(WinLocalSystemSid, nullptr, system.data(), &systemSize), "Create SYSTEM SID failed");
    acl.resize(sizeof(ACL) + 2 * (sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD)) + GetLengthSid(userSid()) + systemSize);
    auto access = reinterpret_cast<PACL>(acl.data());
    require(InitializeAcl(access, acl.size(), ACL_REVISION), "Initialize private DACL failed");
    for (PSID sid : {userSid(), static_cast<PSID>(system.data())})
      require(AddAccessAllowedAceEx(access, ACL_REVISION, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                                   FILE_ALL_ACCESS, sid), "Populate private DACL failed");
    require(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
            SetSecurityDescriptorOwner(&descriptor, userSid(), FALSE) &&
            SetSecurityDescriptorDacl(&descriptor, TRUE, access, FALSE) &&
            SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED),
            "Create protected security descriptor failed");
  }
};

static Handle createRelative(HANDLE parent, const std::wstring& name, DWORD access, bool directory,
                             Security& security, const std::wstring& path) {
  require(!name.empty() && name.find_first_of(L"\\/:\"<>|?*") == std::wstring::npos && name.size() < 32768,
          "Private object requires one filename component", path, ERROR_INVALID_PARAMETER);
  UNICODE_STRING coordinate{};
  coordinate.Buffer = const_cast<wchar_t*>(name.data());
  coordinate.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  coordinate.MaximumLength = coordinate.Length;
  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &coordinate, OBJ_CASE_INSENSITIVE, parent, &security.descriptor);
  IO_STATUS_BLOCK observation{};
  HANDLE raw = INVALID_HANDLE_VALUE;
  const auto status = NtCreateFile(&raw, access | SYNCHRONIZE, &attributes, &observation, nullptr,
                                   FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_CREATE,
                                   FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
                                   (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), nullptr, 0);
  if (status < 0) throw Failure("Create private object relative to its admitted parent failed", path,
                                RtlNtStatusToDosError(status));
  Handle result(raw);
  require(result.valid() && observation.Information == FILE_CREATED,
          "Private creation did not return a new object handle", path, ERROR_ACCESS_DENIED);
  return result;
}

static void verifyPrivate(HANDLE handle, const std::wstring& path, bool root) {
  Security expected;
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR raw = nullptr;
  const DWORD code = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                                     &owner, nullptr, &acl, nullptr, &raw);
  if (code != ERROR_SUCCESS) throw Failure("Read private DACL by handle failed", path, code);
  const auto descriptor = std::unique_ptr<void, decltype(&LocalFree)>(raw, LocalFree);
  require(owner != nullptr && EqualSid(owner, expected.userSid()), "Private object owner is not the current user", path,
          ERROR_ACCESS_DENIED);
  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision;
  require(GetSecurityDescriptorControl(raw, &control, &revision), "Read DACL control flags failed", path);
  require(acl != nullptr && (control & SE_DACL_PRESENT) != 0 && (!root || (control & SE_DACL_PROTECTED) != 0),
          "Private object requires a present protected DACL", path, ERROR_ACCESS_DENIED);
  require(acl->AceCount == 2, "Private DACL contains unexpected trustees", path, ERROR_ACCESS_DENIED);
  bool user = false, system = false;
  for (DWORD index = 0; index < acl->AceCount; ++index) {
    void* rawAce;
    require(GetAce(acl, index, &rawAce), "Read private DACL entry failed", path);
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
    require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Mask == FILE_ALL_ACCESS &&
            (ace->Header.AceFlags & INHERIT_ONLY_ACE) == 0 &&
            (!root || (ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) ==
                      (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)),
            "Private DACL contains unsupported rights or ACE type", path, ERROR_ACCESS_DENIED);
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (EqualSid(sid, expected.userSid())) user = true;
    else if (EqualSid(sid, expected.system.data())) system = true;
    else throw Failure("Private DACL permits an unrelated principal", path, ERROR_ACCESS_DENIED);
  }
  require(user && system, "Private DACL must allow only current user and SYSTEM", path, ERROR_ACCESS_DENIED);
}

std::unique_ptr<Runtime> createRuntime(const std::wstring& parentPath, const std::wstring& prefix) {
  auto parent = openFile(parentPath, 0, true);
  require(!prefix.empty() && prefix.find_first_of(L"\\/:\"<>|?*") == std::wstring::npos,
          "Runtime prefix must be one filename component", parentPath, ERROR_INVALID_PARAMETER);
  std::array<unsigned char, 16> random;
  require(BCryptGenRandom(nullptr, random.data(), random.size(), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
          "Generate runtime identity failed", parentPath, ERROR_GEN_FAILURE);
  auto result = std::make_unique<Runtime>();
  result->path = parent->path + L"\\" + prefix + hex(random.data(), random.size());
  Security security;
  result->directory = createRelative(parent->get(), prefix + hex(random.data(), random.size()),
                                     DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                     true, security, result->path);
  try {
    verifyPrivate(result->directory.get(), result->path, true);
    // The owned child pins the parent nonempty before write sharing is relaxed.
    parent->handles.back() = openComponent(parent->path, 0, true, FILE_SHARE_READ | FILE_SHARE_WRITE);
    result->parents = std::move(parent->handles);
  } catch (...) {
    FILE_DISPOSITION_INFO deletion{TRUE};
    SetFileInformationByHandle(result->directory.get(), FileDispositionInfo, &deletion, sizeof(deletion));
    throw;
  }
  return result;
}

static std::wstring relativePath(Runtime& root, const std::wstring& relative) {
  require(!relative.empty() && relative[0] != L'\\' && relative.find(L':') == std::wstring::npos,
          "Runtime coordinate must be a relative path", relative, ERROR_INVALID_PARAMETER);
  return localPath(root.path + L"\\" + relative);
}

static std::unique_ptr<File> runtimeDirectory(Runtime& root, const std::wstring& path) {
  auto result = std::make_unique<File>(path);
  HANDLE duplicate;
  require(DuplicateHandle(GetCurrentProcess(), root.directory.get(), GetCurrentProcess(), &duplicate, 0, FALSE,
                          DUPLICATE_SAME_ACCESS), "Duplicate private directory handle failed", path);
  result->handles.emplace_back(duplicate);
  size_t offset = root.path.size() + 1;
  while (offset < path.size()) {
    const auto end = path.find(L'\\', offset);
    result->handles.push_back(openComponent(path.substr(0, end), 0, true));
    if (end == std::wstring::npos) break;
    offset = end + 1;
  }
  return result;
}

static void directory(Runtime& root, const std::wstring& relative) {
  const auto path = relativePath(root, relative);
  const auto parentPath = path.substr(0, path.find_last_of(L'\\'));
  auto parent = runtimeDirectory(root, parentPath);
  verifyPrivate(parent->get(), parentPath, parentPath == root.path);
  Security security;
  try {
    auto created = createRelative(parent->get(), path.substr(path.find_last_of(L'\\') + 1),
                                  FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                  true, security, path);
    verifyPrivate(created.get(), path, false);
  } catch (const Failure& failure) {
    if (failure.win32 != ERROR_ALREADY_EXISTS && failure.win32 != ERROR_FILE_EXISTS) throw;
    auto existing = runtimeDirectory(root, path);
    verifyPrivate(existing->get(), path, false);
  }
}

static Handle createPrivateFile(Runtime& root, const std::wstring& relative) {
  const auto path = relativePath(root, relative);
  const auto parentPath = path.substr(0, path.find_last_of(L'\\'));
  auto parent = runtimeDirectory(root, parentPath);
  verifyPrivate(parent->get(), parentPath, parentPath == root.path);
  Security security;
  auto file = createRelative(parent->get(), path.substr(path.find_last_of(L'\\') + 1),
                             GENERIC_WRITE | GENERIC_READ | READ_CONTROL, false, security, path);
  verifyPrivate(file.get(), path, false);
  return file;
}

static void writeBytes(HANDLE file, const void* bytes, DWORD count, const std::wstring& path) {
  DWORD written;
  require(WriteFile(file, bytes, count, &written, nullptr) && written == count, "Write private file failed", path);
}

static void dispose(HANDLE handle, const std::wstring& path) {
  FILE_BASIC_INFO info{};
  require(GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info)), "Read cleanup attributes failed", path);
  if ((info.FileAttributes & FILE_ATTRIBUTE_READONLY) != 0) {
    info.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
    require(SetFileInformationByHandle(handle, FileBasicInfo, &info, sizeof(info)), "Clear owned readonly attribute failed", path);
  }
  FILE_DISPOSITION_INFO deletion{TRUE};
  require(SetFileInformationByHandle(handle, FileDispositionInfo, &deletion, sizeof(deletion)), "Delete owned object by handle failed", path);
}

void closeRuntime(Runtime& root) {
  if (root.closed) return;
  // Windows keeps the bearer descriptor and snapshot leases until this owner
  // cleanup. POSIX removes its consumed descriptor earlier. Abrupt owner death
  // closes process jobs but cannot run this walk, so private files can remain.
  root.immutableFiles.clear();
  struct ReleaseRuntime {
    Runtime& root;
    ~ReleaseRuntime() { root.directory.reset(); root.parents.clear(); root.closed = true; }
  } release{root};
  // Each traversed directory stays locked against replacement. Reparse entries
  // are unlinked as objects; their targets are never enumerated or deleted.
  struct Frame {
    Handle directory;
    HANDLE search = INVALID_HANDLE_VALUE;
    std::wstring path;
    WIN32_FIND_DATAW next{};
    bool pending = false;
    Frame(Handle handle, std::wstring path) : directory(std::move(handle)), path(std::move(path)) {
      search = FindFirstFileExW((L"\\\\?\\" + this->path + L"\\*").c_str(), FindExInfoBasic, &next,
                               FindExSearchNameMatch, nullptr, 0);
      pending = search != INVALID_HANDLE_VALUE;
      require(pending || GetLastError() == ERROR_FILE_NOT_FOUND, "Enumerate runtime cleanup failed", this->path);
    }
    ~Frame() { if (search != INVALID_HANDLE_VALUE) FindClose(search); }
  };
  std::vector<std::unique_ptr<Frame>> frames;
  HANDLE duplicate;
  require(DuplicateHandle(GetCurrentProcess(), root.directory.get(), GetCurrentProcess(), &duplicate, 0, FALSE,
                          DUPLICATE_SAME_ACCESS), "Duplicate runtime cleanup handle failed", root.path);
  frames.push_back(std::make_unique<Frame>(Handle(duplicate), root.path));
  while (!frames.empty()) {
    auto& frame = *frames.back();
    if (!frame.pending) {
      if (frame.search != INVALID_HANDLE_VALUE) { FindClose(frame.search); frame.search = INVALID_HANDLE_VALUE; }
      dispose(frame.directory.get(), frame.path);
      frames.pop_back();
      continue;
    }
    const auto name = std::wstring(frame.next.cFileName);
    frame.pending = FindNextFileW(frame.search, &frame.next) != FALSE;
    require(frame.pending || GetLastError() == ERROR_NO_MORE_FILES, "Continue runtime cleanup enumeration failed", frame.path);
    if (name == L"." || name == L"..") continue;
    const auto path = frame.path + L"\\" + name;
    Handle child(CreateFileW((L"\\\\?\\" + path).c_str(), DELETE | GENERIC_READ | FILE_WRITE_ATTRIBUTES,
                            FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    require(child.valid(), "Open owned cleanup object failed", path);
    FILE_ATTRIBUTE_TAG_INFO info{};
    require(GetFileInformationByHandleEx(child.get(), FileAttributeTagInfo, &info, sizeof(info)), "Read cleanup object tag failed", path);
    if ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 && (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0)
      frames.push_back(std::make_unique<Frame>(std::move(child), path));
    else dispose(child.get(), path);
  }
}

struct SnapshotWork {
  napi_env env;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref rootReference = nullptr;
  Runtime* root;
  std::unique_ptr<File> source;
  Handle destination;
  std::wstring path;
  std::wstring digest;
  std::unique_ptr<Failure> failure;
  SnapshotWork(napi_env env, Runtime& root) : env(env), root(&root) {}
};

static void copySnapshot(napi_env, void* pointer) {
  auto& work = *static_cast<SnapshotWork*>(pointer);
  try {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0,
            "Initialize snapshot SHA-256 failed", work.source->path, ERROR_GEN_FAILURE);
    struct Algorithm { BCRYPT_ALG_HANDLE handle; ~Algorithm() { BCryptCloseAlgorithmProvider(handle, 0); } } owner{algorithm};
    BCRYPT_HASH_HANDLE hash = nullptr;
    require(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0,
            "Create snapshot SHA-256 state failed", work.source->path, ERROR_GEN_FAILURE);
    struct Hash { BCRYPT_HASH_HANDLE handle; ~Hash() { BCryptDestroyHash(handle); } } hashOwner{hash};
    std::array<unsigned char, 65536> buffer;
    while (true) {
      require(!work.root->snapshotCancelled.load(), "Admitted snapshot was cancelled", work.path, ERROR_OPERATION_ABORTED);
      DWORD count;
      require(ReadFile(work.source->get(), buffer.data(), buffer.size(), &count, nullptr),
              "Read admitted source handle failed", work.source->path);
      if (count == 0) break;
      writeBytes(work.destination.get(), buffer.data(), count, work.path);
      require(BCryptHashData(hash, buffer.data(), count, 0) == 0,
              "Hash admitted snapshot bytes failed", work.source->path, ERROR_GEN_FAILURE);
    }
    std::array<unsigned char, 32> digest;
    require(BCryptFinishHash(hash, digest.data(), digest.size(), 0) == 0,
            "Finish snapshot SHA-256 failed", work.source->path, ERROR_GEN_FAILURE);
    require(FlushFileBuffers(work.destination.get()), "Flush private snapshot failed", work.path);
    work.digest = hex(digest.data(), digest.size());
  } catch (const Failure& failure) {
    work.failure = std::make_unique<Failure>(failure);
  } catch (const std::exception& failure) {
    work.failure = std::make_unique<Failure>(failure.what(), work.path, ERROR_GEN_FAILURE);
  }
}

static void completeSnapshot(napi_env env, napi_status status, void* pointer) {
  std::unique_ptr<SnapshotWork> work(static_cast<SnapshotWork*>(pointer));
  work->root->snapshotPending = false;
  try {
    if (work->failure) throw *work->failure;
    require(status == napi_ok && !work->root->snapshotCancelled.load(), "Native snapshot worker was cancelled", work->path, ERROR_OPERATION_ABORTED);
    auto result = object(env);
    set(env, result, "sha256", string(env, work->digest));
    set(env, result, "source", identity(env, work->source->get(), work->source->requestedPath));
    set(env, result, "snapshot", identity(env, work->destination.get(), work->path));
    work->root->immutableFiles.push_back(std::move(work->destination));
    check(napi_resolve_deferred(env, work->deferred, result));
  } catch (const Failure& failure) {
    napi_reject_deferred(env, work->deferred, failureValue(env, failure));
  } catch (const std::exception& failure) {
    napi_reject_deferred(env, work->deferred,
                         failureValue(env, Failure(failure.what(), work->path, ERROR_GEN_FAILURE)));
  }
  napi_delete_reference(env, work->rootReference);
  napi_delete_async_work(env, work->work);
}

static napi_value snapshot(napi_env env, napi_value rootValue, Runtime& root,
                           const std::wstring& sourcePath, const std::wstring& relative) {
  auto work = std::make_unique<SnapshotWork>(env, root);
  work->source = openFile(sourcePath);
  work->path = relativePath(root, relative);
  work->destination = createPrivateFile(root, relative);
  napi_value promise;
  check(napi_create_promise(env, &work->deferred, &promise));
  check(napi_create_reference(env, rootValue, 1, &work->rootReference));
  const auto label = string(env, std::string("REA admitted Windows snapshot"));
  root.snapshotCancelled.store(false);
  try {
    check(napi_create_async_work(env, nullptr, label, copySnapshot, completeSnapshot, work.get(), &work->work));
    check(napi_queue_async_work(env, work->work));
  } catch (...) {
    if (work->work) napi_delete_async_work(env, work->work);
    napi_delete_reference(env, work->rootReference);
    throw;
  }
  root.snapshotPending = true;
  work.release();
  return promise;
}

napi_value filesystemCall(napi_env env, const std::wstring& operation, const std::vector<napi_value>& args) {
  const auto expected = operation == L"open" || operation == L"close" || operation == L"runtime_close" || operation == L"runtime_snapshot_cancel" ? 1
                      : operation == L"runtime_create" || operation == L"runtime_mkdir" || operation == L"runtime_open" ? 2 : 3;
  require(args.size() == static_cast<size_t>(expected), "Wrong native filesystem argument count", L"", ERROR_INVALID_PARAMETER);
  if (operation == L"open") {
    auto file = openFile(wide(env, args[0]));
    auto result = identity(env, file->get(), file->requestedPath);
    set(env, result, "handle", wrap(env, std::move(file)));
    return result;
  }
  if (operation == L"close") {
    auto& file = static_cast<File&>(resource(env, args[0], Kind::File));
    file.handles.clear(); file.closed = true;
    return null(env);
  }
  if (operation == L"read") {
    auto& file = static_cast<File&>(resource(env, args[0], Kind::File));
    const auto position = numeric(env, args[1]);
    const auto length = numeric(env, args[2]);
    require(position >= 0 && position <= 9007199254740991.0 && position == static_cast<int64_t>(position) &&
            length >= 0 && length <= 65536 && length == static_cast<DWORD>(length),
            "Read coordinates exceed the native chunk boundary", file.path, ERROR_INVALID_PARAMETER);
    LARGE_INTEGER offset; offset.QuadPart = static_cast<int64_t>(position);
    require(SetFilePointerEx(file.get(), offset, nullptr, FILE_BEGIN), "Seek admitted file handle failed", file.path);
    std::array<unsigned char, 65536> buffer;
    DWORD count;
    require(ReadFile(file.get(), buffer.data(), static_cast<DWORD>(length), &count, nullptr), "Read admitted file handle failed", file.path);
    napi_value result;
    check(napi_create_buffer_copy(env, count, buffer.data(), nullptr, &result));
    return result;
  }
  if (operation == L"runtime_create") {
    auto root = createRuntime(wide(env, args[0]), wide(env, args[1]));
    auto result = identity(env, root->directory.get(), root->path);
    set(env, result, "path", string(env, root->path));
    set(env, result, "privateDacl", boolean(env, true));
    set(env, result, "handle", wrap(env, std::move(root)));
    return result;
  }
  auto& root = static_cast<Runtime&>(resource(env, args[0], Kind::Runtime));
  if (operation == L"runtime_snapshot_cancel") { root.snapshotCancelled.store(true); return null(env); }
  require(!root.snapshotPending, "Runtime snapshot is still pending", root.path, ERROR_BUSY);
  // Reject overlapping operations before snapshot() resets cancellation. The
  // one accepted worker and WindowsPrivateRuntime retain the same root lease.
  if (operation == L"runtime_close") { closeRuntime(root); return null(env); }
  if (operation == L"runtime_mkdir") { directory(root, wide(env, args[1])); return null(env); }
  if (operation == L"runtime_open") {
    const auto path = relativePath(root, wide(env, args[1]));
    auto file = runtimeDirectory(root, path.substr(0, path.find_last_of(L'\\')));
    file->path = path;
    file->requestedPath = path;
    file->handles.push_back(openComponent(path, GENERIC_READ, false));
    verifyPrivate(file->get(), path, false);
    auto result = identity(env, file->get(), path);
    set(env, result, "handle", wrap(env, std::move(file)));
    return result;
  }
  if (operation == L"runtime_write") {
    bool isBuffer; check(napi_is_buffer(env, args[2], &isBuffer));
    require(isBuffer, "Private write requires a byte buffer", root.path, ERROR_INVALID_PARAMETER);
    void* bytes; size_t length; check(napi_get_buffer_info(env, args[2], &bytes, &length));
    require(length <= MAXDWORD, "Private write exceeds Win32 byte representation", root.path, ERROR_INVALID_PARAMETER);
    auto file = createPrivateFile(root, wide(env, args[1]));
    writeBytes(file.get(), bytes, static_cast<DWORD>(length), root.path);
    require(FlushFileBuffers(file.get()), "Flush private runtime file failed", root.path);
    root.immutableFiles.push_back(std::move(file));
    return null(env);
  }
  if (operation == L"runtime_snapshot") {
    return snapshot(env, args[0], root, wide(env, args[1]), wide(env, args[2]));
  }
  throw Failure("Unknown native filesystem operation", L"", ERROR_INVALID_PARAMETER);
}

} // namespace rea
