using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

internal static class ReaWindowsProcess
{
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_READ = 0x0010;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(
        IntPtr process,
        int informationClass,
        ref ProcessBasicInformation information,
        int length,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(
        IntPtr process,
        IntPtr address,
        byte[] buffer,
        int size,
        out IntPtr read);

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] == "snapshot")
            {
                Console.Out.Write(Snapshot());
                return 0;
            }
            if (args[0] == "run-id" && args.Length == 2)
            {
                var pid = uint.Parse(args[1], CultureInfo.InvariantCulture);
                Console.Out.Write(ReadRunId(pid) ?? "");
                return 0;
            }
            Console.Error.WriteLine("usage: snapshot | run-id <pid>");
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    static string Snapshot()
    {
        var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
            throw new InvalidOperationException(
                "CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
        try
        {
            var entry = new ProcessEntry();
            entry.dwSize = (uint)Marshal.SizeOf(entry);
            if (!Process32First(snapshot, ref entry))
                throw new InvalidOperationException(
                    "Process32First failed: " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            var rows = new StringBuilder();
            rows.Append('[');
            var first = true;
            do
            {
                if (!first) rows.Append(',');
                first = false;
                rows.Append("{\"pid\":");
                rows.Append(entry.th32ProcessID.ToString(CultureInfo.InvariantCulture));
                rows.Append(",\"parent\":");
                rows.Append(entry.th32ParentProcessID.ToString(CultureInfo.InvariantCulture));
                rows.Append(",\"command\":");
                rows.Append(Quote(entry.szExeFile ?? ""));
                rows.Append(",\"start\":null");
                rows.Append('}');
            }
            while (Process32Next(snapshot, ref entry));
            rows.Append(']');
            return rows.ToString();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    static string ReadRunId(uint pid)
    {
        var process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            var information = new ProcessBasicInformation();
            int returned;
            if (NtQueryInformationProcess(
                    process,
                    0,
                    ref information,
                    Marshal.SizeOf(information),
                    out returned) != 0)
                return null;
            if (IntPtr.Size != 8) return null;
            var parameters = ReadPointer(process, information.PebBaseAddress, 0x20);
            if (parameters == IntPtr.Zero) return null;
            var environment = ReadPointer(process, parameters, 0x80);
            if (environment == IntPtr.Zero) return null;
            var raw = ReadEnvironment(process, environment);
            if (raw == null) return null;
            var text = Encoding.Unicode.GetString(raw);
            const string prefix = "REA_PROCESS_RUN_ID=";
            foreach (var item in text.Split('\0'))
            {
                if (item.StartsWith(prefix, StringComparison.Ordinal))
                    return item.Substring(prefix.Length);
            }
            return null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    static byte[] ReadEnvironment(IntPtr process, IntPtr address)
    {
        const int page = 4096;
        const int cap = 256 * 1024;
        var collected = new List<byte>();
        var offset = 0;
        while (offset < cap)
        {
            var buffer = new byte[page];
            IntPtr read;
            var target = new IntPtr(address.ToInt64() + offset);
            if (!ReadProcessMemory(process, target, buffer, buffer.Length, out read) || (int)read < 2)
                break;
            var count = (int)read;
            collected.AddRange(new ArraySegment<byte>(buffer, 0, count));
            for (var index = 0; index + 3 < collected.Count; index += 2)
            {
                if (collected[index] == 0 && collected[index + 1] == 0 &&
                    collected[index + 2] == 0 && collected[index + 3] == 0)
                {
                    var exact = new byte[index + 4];
                    collected.CopyTo(0, exact, 0, exact.Length);
                    return exact;
                }
            }
            if (count < page) break;
            offset += count;
        }
        return collected.Count == 0 ? null : collected.ToArray();
    }

    static IntPtr ReadPointer(IntPtr process, IntPtr address, int offset)
    {
        var buffer = new byte[IntPtr.Size];
        IntPtr read;
        var target = new IntPtr(address.ToInt64() + offset);
        if (!ReadProcessMemory(process, target, buffer, buffer.Length, out read) || (int)read != buffer.Length)
            return IntPtr.Zero;
        return new IntPtr(BitConverter.ToInt64(buffer, 0));
    }

    static string Quote(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (var character in value)
        {
            if (character == '\\' || character == '"') builder.Append('\\');
            if (character < ' ') continue;
            builder.Append(character);
        }
        builder.Append('"');
        return builder.ToString();
    }
}
