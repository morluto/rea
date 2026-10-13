import com.atxx.jhmcp.*;
import com.android.tools.smali.smali.Smali;
import com.android.tools.smali.smali.SmaliOptions;
import com.google.gson.*;
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult;
import io.modelcontextprotocol.kotlin.sdk.types.TextContent;
import jadx.api.*;
import jadx.core.dex.nodes.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;

/** Real audited-JAR regression; synthetic protocol fixtures cannot prove absence of code generation. */
public class ReaJadxMetadataRegression {
  private static void require(boolean condition, String reason) {
    if (!condition) throw new AssertionError(reason);
  }

  private static JsonObject call(Method handle, Object bridge, String operation, JsonObject arguments)
      throws Exception {
    var input = (kotlinx.serialization.json.JsonObject)
        kotlinx.serialization.json.Json.Default.parseToJsonElement(arguments.toString());
    CallToolResult response;
    try {
      response = (CallToolResult) handle.invoke(bridge, operation, input);
    } catch (InvocationTargetException failure) {
      throw new AssertionError(operation + " failed", failure.getCause());
    }
    require(!Boolean.TRUE.equals(response.isError()), operation + " returned an error");
    require(response.getContent().size() == 1 && response.getContent().get(0) instanceof TextContent,
        "Unsupported response envelope");
    return JsonParser.parseString(((TextContent) response.getContent().get(0)).getText()).getAsJsonObject();
  }

  private static JsonObject arguments(String className) {
    JsonObject value = new JsonObject();
    value.addProperty("class_name", className);
    return value;
  }

  private static Path initializerFixture(String sources, String output) throws Exception {
    Path directory = Path.of(output);
    SmaliOptions options = new SmaliOptions();
    options.apiLevel = 28;
    options.jobs = 1;
    options.outputDexFile = directory.resolve("initializers.dex").toString();
    require(Smali.assemble(options, List.of(
        Path.of(sources, "InitializationPolicy.smali").toString(),
        Path.of(sources, "MixedInitialization.smali").toString())), "Initializer fixture assembly failed");
    Path apk = directory.resolve("initializers.apk");
    try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(apk))) {
      zip.putNextEntry(new ZipEntry("classes.dex"));
      Files.copy(Path.of(options.outputDexFile), zip);
      zip.closeEntry();
    }
    return apk;
  }

  private static void verifyDirectInvokes(SessionHolder holder, SessionConfig config,
      Constructor<?> constructor, Method handle, Path sources, Path output) throws Exception {
    SmaliOptions options = new SmaliOptions();
    options.apiLevel = 28;
    options.jobs = 1;
    options.outputDexFile = output.resolve("direct-invokes.dex").toString();
    require(Smali.assemble(options, List.of(
        sources.resolve("Caller.smali").toString(), sources.resolve("Target.smali").toString())),
        "Direct-invoke fixture assembly failed");
    Path apk = output.resolve("direct-invokes.apk");
    try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(apk))) {
      zip.putNextEntry(new ZipEntry("classes.dex"));
      Files.copy(Path.of(options.outputDexFile), zip);
      zip.closeEntry();
    }
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.unload(continuation));
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.load(apk.toString(), config, continuation));
    JsonObject refs = call(handle, constructor.newInstance(holder), "get_xrefs_to_method",
        methodArguments("fixture.Target", "mark"));
    checkDirectInvokes(refs, "classes.dex");

    SmaliOptions targetOptions = new SmaliOptions();
    targetOptions.apiLevel = 28;
    targetOptions.jobs = 1;
    targetOptions.outputDexFile = output.resolve("direct-target.dex").toString();
    SmaliOptions callerOptions = new SmaliOptions();
    callerOptions.apiLevel = 28;
    callerOptions.jobs = 1;
    callerOptions.outputDexFile = output.resolve("direct-caller.dex").toString();
    require(Smali.assemble(targetOptions, List.of(sources.resolve("Target.smali").toString())),
        "Target DEX assembly failed");
    require(Smali.assemble(callerOptions, List.of(sources.resolve("Caller.smali").toString())),
        "Caller DEX assembly failed");
    Path splitApk = output.resolve("direct-invokes-multidex.apk");
    try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(splitApk))) {
      zip.putNextEntry(new ZipEntry("classes.dex"));
      Files.copy(Path.of(targetOptions.outputDexFile), zip);
      zip.closeEntry();
      zip.putNextEntry(new ZipEntry("classes2.dex"));
      Files.copy(Path.of(callerOptions.outputDexFile), zip);
      zip.closeEntry();
    }
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.unload(continuation));
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.load(splitApk.toString(), config, continuation));
    JsonObject crossDex = call(handle, constructor.newInstance(holder), "get_xrefs_to_method",
        methodArguments("fixture.Target", "mark"));
    checkDirectInvokes(crossDex, "classes2.dex");
    System.out.println("DIRECT_INVOKE_REGRESSION_PASS nodes=1 offsets=0,3 cross_dex=true");
  }

  private static void checkDirectInvokes(JsonObject refs, String dexEntry) {
    require(refs.get("total").getAsInt() == 1, "JADX using-node count changed");
    JsonArray sites = refs.getAsJsonArray("items").get(0).getAsJsonObject()
        .getAsJsonArray("direct_invokes");
    require(sites.size() == 2, "Raw DEX invoke count differs from the fixture: " + sites);
    for (int i = 0; i < sites.size(); i++) {
      JsonObject site = sites.get(i).getAsJsonObject();
      require(site.get("dex_entry").getAsString().equals(dexEntry), "Wrong DEX entry");
      require(site.get("source_raw_method_id").getAsString().equals("fixture.Caller.twice()V"),
          "Wrong raw source method");
      require(site.get("dex_code_unit_offset").getAsInt() == i * 3, "Wrong DEX offset");
      require(site.get("opcode").getAsString().equals("INVOKE_STATIC"), "Wrong opcode");
    }
    require(sites.get(0).getAsJsonObject().get("dex_method_index").getAsInt()
        == sites.get(1).getAsJsonObject().get("dex_method_index").getAsInt(),
        "Two invokes did not reference the same DEX method ID");
  }

  private static JsonObject methodArguments(String className, String methodName) {
    JsonObject value = arguments(className);
    value.addProperty("method_name", methodName);
    value.addProperty("overload_index", 0);
    return value;
  }

  private static void verifyInitializers(SessionHolder holder, SessionConfig config,
      Constructor<?> constructor, Method handle, Path apk) throws Exception {
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.unload(continuation));
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.load(apk.toString(), config, continuation));
    Object bridge = constructor.newInstance(holder);
    String[] classNames = { "fixture.InitializationPolicy", "fixture.MixedInitialization" };
    String[][] witnesses = {
        { "declared-policy", "->singletonList", "->POLICY:Ljava/util/List;" },
        { "field-value", "->LABEL:Ljava/lang/String;", "->touch()V" }
    };
    for (int index = 0; index < classNames.length; index++) {
      JsonObject summary = call(handle, bridge, "get_class_summary", arguments(classNames[index]));
      JsonObject input = methodArguments(classNames[index], "<clinit>");
      JsonObject body = call(handle, bridge, "get_method_body", input);
      String text = body.get("body").getAsString();
      for (String witness : witnesses[index]) require(text.contains(witness), "Missing initializer instruction: " + witness);
      require(body.get("mode").getAsString().equals("smali"), "Static initializer must preserve DEX instructions");
      require(body.get("fell_back").getAsBoolean(), "Disassembly fallback was not reported");
      require(body.getAsJsonArray("markers").contains(new JsonPrimitive("static_initializer_disassembly")),
          "Static initializer representation reason was not reported");
      require(text.contains(".method static constructor <clinit>()V") && text.contains(".end method"),
          "Initializer method boundaries missing");
      require(body.get("overload_index").getAsInt() == 0 && body.get("overload_count").getAsInt() == 1,
          "Initializer identity changed");
      require(body.equals(call(handle, bridge, "get_method_body", input)), "Repeated initializer body changed");
      require(summary.equals(call(handle, bridge, "get_class_summary", arguments(classNames[index]))),
          "Frozen initializer metadata changed after source generation");
    }
    for (String name : List.of("missing", "originalNative")) {
      JsonObject body = call(handle, bridge, "get_method_body", methodArguments(classNames[0], name));
      String text = body.get("body").getAsString();
      require(body.get("mode").getAsString().equals("java") && !text.contains("{") && !text.contains(".method"),
          "Executable body was fabricated for " + name + ": " + text);
    }
    JsonObject ordinary = call(handle, bridge, "get_method_body", methodArguments(classNames[1], "touch"));
    require(ordinary.get("mode").getAsString().equals("java") && ordinary.get("body").getAsString().contains("COUNT"),
        "Ordinary executable method no longer produces Java");

    SessionConfig bounded = new SessionConfig(96, 0, 90000L, 1, List.of(), List.of(), 64, ResourceMode.FULL);
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.unload(continuation));
    BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
        (scope, continuation) -> holder.load(apk.toString(), bounded, continuation));
    JsonObject partial = call(handle, constructor.newInstance(holder), "get_method_body",
        methodArguments(classNames[0], "<clinit>"));
    require(partial.get("mode").getAsString().equals("smali")
        && partial.get("body").getAsString().contains("[truncated: exceeds 96 bytes, total "),
        "Static initializer ignored the source byte limit or omitted its truncation marker");
    String prefix = partial.get("body").getAsString().split("\n\n\\.\\.\\. \\[truncated:", 2)[0];
    require(prefix.getBytes(StandardCharsets.UTF_8).length <= 96, "Initializer text exceeded its byte limit");
    System.out.println("INITIALIZER_REGRESSION_PASS folded=2 bounded=true");
  }

  public static void main(String[] args) throws Exception {
    SessionConfig config = new SessionConfig(1048576, 0, 90000L, 1, List.of(), List.of(), 64, ResourceMode.FULL);
    SessionHolder holder = new SessionHolder(config);
    try {
      BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> holder.load(args[0], config, continuation));
      JadxSession session = holder.current();
      require(session != null && !session.getClasses().isEmpty(), "Fixture did not load classes");
      JadxDecompiler decompiler = session.getClasses().get(0).getClassNode().root().getDecompiler();
      IdentityHashMap<ClassNode, ProcessState> states = new IdentityHashMap<>();
      for (ClassNode node : decompiler.getRoot().getClasses()) {
        require(node.getState() == ProcessState.NOT_LOADED, "Fixture unexpectedly generated source");
        states.put(node, node.getState());
      }
      Class<?> bridgeType = Class.forName("ReaJadxBridge");
      Constructor<?> constructor = bridgeType.getDeclaredConstructor(SessionHolder.class);
      constructor.setAccessible(true);
      Object bridge = constructor.newInstance(holder);
      Method handle = bridgeType.getDeclaredMethod("handle", String.class, kotlinx.serialization.json.JsonObject.class);
      handle.setAccessible(true);
      JsonObject apiArgs = arguments("io.appium.android.apis.ApiDemos");
      JsonObject apiSummary = call(handle, bridge, "get_class_summary", apiArgs);
      for (var entry : states.entrySet()) require(entry.getKey().getState() == entry.getValue(),
          "Metadata generated source: " + entry.getKey().getRawName());
      require(states.size() == decompiler.getRoot().getClasses().size(), "Metadata changed class inventory");
      require(apiSummary.getAsJsonArray("fields").get(0).getAsJsonObject().get("type").getAsString().contains("Comparator"),
          "Generic field type was truncated");
      JsonObject componentArgs = arguments("androidx.activity.ComponentActivity");
      JsonObject componentSummary = call(handle, bridge, "get_class_summary", componentArgs);
      List<String> signatures = new ArrayList<>();
      List<String> descriptors = new ArrayList<>();
      for (JsonElement entry : componentSummary.getAsJsonArray("methods")) {
        JsonObject method = entry.getAsJsonObject();
        if (method.get("name").getAsString().equals("setContentView")) {
          signatures.add(method.get("signature").getAsString());
          descriptors.add(method.get("dex_descriptor").getAsString());
        }
      }
      require(signatures.size() == 3, "Fixture must contain three setContentView overloads");
      require(descriptors.equals(List.of("(I)V", "(Landroid/view/View;)V",
          "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V")),
          "Frozen DEX prototypes did not identify the three overloads: " + descriptors);
      String[] declarations = { "setContentView(int ", "setContentView(View ", "setContentView(View view, ViewGroup.LayoutParams " };
      List<Integer> referenceCounts = new ArrayList<>();
      for (int index = 0; index < signatures.size(); index++) {
        JsonObject methodArgs = arguments("androidx.activity.ComponentActivity");
        methodArgs.addProperty("method_name", "setContentView");
        methodArgs.addProperty("overload_index", index);
        JsonObject first = call(handle, bridge, "get_method_body", methodArgs);
        require(first.equals(call(handle, bridge, "get_method_body", methodArgs)), "Repeated body changed");
        require(first.get("overload_index").getAsInt() == index && first.get("overload_count").getAsInt() == 3,
            "Overload envelope mismatch");
        require(first.get("mode").getAsString().equals("java"), "Fixture did not produce Java");
        require(first.get("body").getAsString().contains(declarations[index]), "Wrong overload: " + signatures.get(index));
        JsonObject references = call(handle, bridge, "get_xrefs_to_method", methodArgs);
        require(references.get("overload_index").getAsInt() == index,
            "Reference result did not preserve selected overload index");
        require(references.get("reported_signature").getAsString().equals(signatures.get(index)),
            "Reference result did not preserve selected overload signature");
        if (index == 0) {
          JsonArray invokes = references.getAsJsonArray("items").get(0).getAsJsonObject()
              .getAsJsonArray("direct_invokes");
          require(invokes.size() == 1, "Selected overload must have one raw direct invoke");
          JsonObject invoke = invokes.get(0).getAsJsonObject();
          require(invoke.get("source_raw_method_id").getAsString()
              .equals("androidx.activity.ComponentActivity.onCreate(Landroid/os/Bundle;)V"),
              "Wrong source method for overloaded target");
          require(invoke.get("dex_code_unit_offset").getAsInt() == 37
              && invoke.get("opcode").getAsString().equals("INVOKE_VIRTUAL"),
              "Wrong direct invoke for selected overloaded target");
        }
        referenceCounts.add(references.get("count").getAsInt());
      }
      require(referenceCounts.equals(List.of(1, 0, 0)),
          "Incoming references were not isolated to the selected overload: " + referenceCounts);
      require(componentSummary.equals(call(handle, bridge, "get_class_summary", componentArgs)),
          "Frozen summary changed after code generation");
      require(apiSummary.equals(call(handle, bridge, "get_class_summary", apiArgs)), "Unrelated frozen summary changed");
      System.out.println("METADATA_REGRESSION_PASS classes=" + states.size() + " overloads=" + signatures.size()
          + " reference_counts=" + referenceCounts);
      verifyInitializers(holder, config, constructor, handle, initializerFixture(args[1], args[2]));
      verifyDirectInvokes(holder, config, constructor, handle,
          Path.of(args[3]), Path.of(args[2]));
    } finally {
      BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> holder.unload(continuation));
    }
  }
}
