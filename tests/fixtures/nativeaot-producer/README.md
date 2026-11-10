# NativeAOT producer transaction probe

This compiles the shipped Java producer with controlled Ghidra and upstream API
doubles and real Gson. It checks late failures, success, partial recovery, and
cancellation against the transaction and report contract. It does not test the
real Ghidra APIs or engine. With JDK 21+ and a Gson jar already available:

```sh
JAVA_HOME=/path/to/jdk GSON_JAR=/path/to/gson.jar npm run test:local -- src/ghidra/extensions/nativeaot/NativeAotProducer.test.ts
```

The test is skipped without both variables. To run the Java probe directly,
use `python3 tests/fixtures/nativeaot-producer/run.py`. Add `--json` to emit the
four reports checked by the TypeScript validator. For a baseline comparison,
set `REA_NATIVEAOT_PRODUCER_SOURCE` to another `NativeAotExtension.java` and pass
`audit` or `types` to select one failure case. Subprocesses have 30-second limits.
