# .NET static-analysis walkthrough
This walkthrough answers one question: **which native Windows API does this managed sample declare?** It uses a source-owned sample and REA's static inspection commands. The assembly is never loaded or executed.
## Prerequisites
- .NET 8 SDK
- A REA CLI build that includes the managed-code commands. No Windows host or native-analysis engine is needed.
## Build the sample
Create the project first:
```bash
dotnet new console --framework net8.0 --name ReaManagedDemo
```

Replace the contents of `ReaManagedDemo/Program.cs` with:
```csharp
using System.Runtime.InteropServices;
namespace ReaManagedDemo;
internal static class NativeMethods
{
    [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode)]
    internal static extern int ShowMessage(nint window, string text, string caption, uint type);
}
internal static class Program
{
    private static int Main() => 0;
}
```
Build the project without running the program:
```bash
dotnet build ReaManagedDemo --configuration Release
```

The assembly is at `ReaManagedDemo/bin/Release/net8.0/ReaManagedDemo.dll`. In Bash, set its absolute path with:
```bash
DLL="$PWD/ReaManagedDemo/bin/Release/net8.0/ReaManagedDemo.dll"
```
Then run:
```bash
rea inspect-managed-artifact "$DLL" --json
rea inspect-managed-members "$DLL" --type ReaManagedDemo.Program --json
rea inspect-managed-members "$DLL" --type ReaManagedDemo.NativeMethods --json
rea inspect-managed-native-boundaries "$DLL" --json
```
The source is the independent oracle: `NativeMethods.ShowMessage` declares `MessageBoxW` from `user32.dll`. The `Program.Main` inspection should include its CIL body; `NativeMethods.ShowMessage` is `extern` and should have no CIL body. Check the artifact identity, selected members and CIL, and declared native boundary. A declaration does not establish that the method ran, that Windows loaded the library, or that the import resolved at runtime.
## Limits
This is static inspection of the produced PE/CLI assembly. The source does not prove compiler output. REA does not load the assembly, call `MessageBoxW`, or recover original C# from it. Record the REA build, SDK version, host, and artifact SHA-256 alongside captured results.
