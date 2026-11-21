package dev.rea.uiautomator;

import android.Manifest;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.AccessibilityNodeInfoExt;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.ByWindowSelector;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.UiWindow;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Operator-owned UI Automator service. The wire protocol accepts typed UI operations only. */
public final class ReaUiRunner extends Instrumentation {
  // Base64 is transported in a Binder String (UTF-16). 256 KiB of JSON expands
  // to at most 699,056 bytes there, leaving room in Binder's 1 MiB transaction.
  private static final int RESPONSE_BYTES = 256 * 1024;
  // A retained completion travels inside a status or cancel envelope, so it
  // keeps room for that envelope. An untransportable completion would collapse
  // every later reply into a capacity error and keep its request slot occupied.
  private static final int COMPLETION_BYTES = RESPONSE_BYTES - 16384;
  private static final int REQUEST_BYTES = 16 * 1024;
  private final String instance = UUID.randomUUID().toString();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final AtomicReference<Call> active = new AtomicReference<>();
  // Completed replies remain owned until their caller acknowledges them.
  // Sixteen bounded replies reserve at most 4 MiB of wire data.
  private final Map<String, Call> calls = new ConcurrentHashMap<>();
  private UiDevice device;
  private Snapshot latest;
  private final Set<String> sensitiveText = new LinkedHashSet<>();
  private int sensitiveCodeUnits;
  private ReaUiSocket socket;

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    start();
  }

  // UI Automator's modern Kotlin helpers obtain Instrumentation.uiAutomation
  // directly. Keep that path aligned with UiDevice's Configurator flags so
  // initializing the helpers cannot reconnect and invalidate captured nodes.
  @Override
  public UiAutomation getUiAutomation() {
    return super.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
  }

  @Override
  public void onStart() {
    InstrumentationRegistry.registerInstance(this, new Bundle());
    Configurator.getInstance()
        .setWaitForIdleTimeout(0)
        .setWaitForSelectorTimeout(0)
        .setUiAutomationFlags(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    device = UiDevice.getInstance(this);
    Context context = getTargetContext();
    socket =
        new ReaUiSocket(
            context.getFilesDir(),
            instance,
            ((REQUEST_BYTES + 2) / 3) * 4,
            encoded -> exchange(encoded, true));
    BroadcastReceiver receiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context ignored, Intent intent) {
            setResultData(exchange(intent.getStringExtra("request"), false));
            setResultCode(0);
          }
        };
    IntentFilter filter = new IntentFilter(context.getPackageName() + ".REQUEST");
    boolean registered = false;
    try {
      if ((context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)
          == 0)
        throw new java.io.IOException(
            "The private UI transport requires the operator-built debug runner");
      socket.start();
      if (Build.VERSION.SDK_INT >= 33)
        context.registerReceiver(
            receiver, filter, Manifest.permission.DUMP, null, Context.RECEIVER_EXPORTED);
      else context.registerReceiver(receiver, filter, Manifest.permission.DUMP, null);
      registered = true;
    } catch (Exception cause) {
      // A failed setup must not leave the socket node behind: the next launch
      // refuses a pre-existing path until the operator removes it.
      try {
        socket.close();
      } catch (Exception cleanup) {
        cause.addSuppressed(cleanup);
      }
      Bundle failure = new Bundle();
      failure.putString("stream", "REA_UI_SETUP_FAILED " + reason(cause) + "\n");
      finish(-1, failure);
      return;
    }
    Bundle ready = new Bundle();
    ready.putString("stream", "REA_UI_READY " + instance + "\n");
    sendStatus(0, ready);
    try {
      new CountDownLatch(1).await();
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
    } finally {
      if (registered) context.unregisterReceiver(receiver);
      try {
        socket.close();
      } catch (java.io.IOException cleanup) {
        Bundle retained = new Bundle();
        retained.putString("stream", "REA_UI_CLEANUP_INCOMPLETE " + reason(cleanup) + "\n");
        sendStatus(-1, retained);
      }
      worker.shutdownNow();
      if (latest != null) latest.recycle();
      finish(0, new Bundle());
    }
  }

  private String exchange(String encoded, boolean privateStream) {
    JSONObject request = null;
    try {
      if (encoded == null || encoded.length() > ((REQUEST_BYTES + 2) / 3) * 4)
        throw new Refusal("invalid_request", "Request exceeds the protocol budget");
      byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
      if (bytes.length > REQUEST_BYTES)
        throw new Refusal("invalid_request", "Request exceeds the protocol budget");
      request =
          new JSONObject(
              StandardCharsets.UTF_8
                  .newDecoder()
                  .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                  .decode(java.nio.ByteBuffer.wrap(bytes))
                  .toString());
      UUID.fromString(request.getString("request_id"));
      if (request.getInt("protocol") != 2)
        throw new Refusal("invalid_request", "Unsupported protocol; rebuild the matching runner");
      return encodeResponse(response(request, dispatch(request, privateStream), null));
    } catch (Throwable cause) {
      try {
        return encodeResponse(response(request, null, cause));
      } catch (JSONException malformed) {
        return "REA_UI_V2:invalid-response";
      }
    }
  }

  /** Both channels share admission, cancellation and retained-result ownership. */
  private synchronized JSONObject dispatch(JSONObject request, boolean privateStream)
      throws Exception {
    String operation = request.getString("operation");
    if (operation.equals("ping"))
      return object("runner", runner(), "socket_path", socket.relativePath());
    if (!instance.equals(request.getString("instance_id")))
      throw new Refusal("runner_changed", "The selected runner instance changed");
    if (operation.equals("prepare")) {
      if (privateStream)
        throw new Refusal("invalid_request", "Preparation uses the control channel");
      String target = request.getString("target_operation");
      if (!target.equals("inspect_adb_ui")
          && !target.equals("find_adb_ui_elements")
          && !target.equals("wait_for_adb_ui")
          && !target.equals("perform_adb_ui_action"))
        throw new Refusal("invalid_request", "Unknown UI operation");
      String id = request.getString("request_id");
      Call existing = calls.get(id);
      if (existing != null && !existing.operation.equals(target))
        throw new Refusal("invalid_request", "Request ID already belongs to a different operation");
      if (existing == null) {
        if (calls.size() >= 16)
          throw new Refusal("capacity", "Unacknowledged UI request capacity exhausted");
        calls.put(id, new Call(id, target));
      }
      return object("state", "prepared");
    }
    if (operation.equals("cancel")) {
      Call call = calls.get(request.getString("cancel_request_id"));
      if (call != null && !call.done) {
        call.cancelled = true;
        if (call.request == null) {
          call.response =
              response(
                  object("request_id", call.id),
                  null,
                  new Refusal("cancelled", "Request cancelled before input submission"));
          call.done = true;
        }
      }
      return object(
          "state",
          call == null ? "missing" : call.done ? "settled" : "cancelling",
          "response",
          call == null || !call.done ? null : call.response);
    }
    if (operation.equals("status")) {
      Call call = calls.get(request.getString("target_request_id"));
      return object(
          "state",
          call == null ? "missing" : call.done ? "settled" : "running",
          "response",
          call == null || !call.done ? null : call.response);
    }
    if (operation.equals("forget")) {
      String id = request.getString("target_request_id");
      Call call = calls.get(id);
      if (call != null && !call.done) throw new Refusal("busy", "Cannot release an active request");
      if (call != null) calls.remove(id, call);
      return object("state", "forgotten");
    }
    if (!privateStream)
      throw new Refusal("invalid_request", "UI input must use the private stdin transport");
    Call call = calls.get(request.getString("request_id"));
    if (call == null || !call.operation.equals(operation))
      throw new Refusal("invalid_request", "UI request has no matching preparation");
    if (call.done || call.cancelled) throw new Refusal("cancelled", "UI request already settled");
    if (call.request != null) {
      if (!call.request.equals(request.toString()))
        throw new Refusal("invalid_request", "Request ID already belongs to different input");
      return object("state", "accepted");
    }
    JSONObject input = request.getJSONObject("input");
    int timeout = input.getInt("timeout_ms");
    if (timeout < 1 || timeout > 30000)
      throw new Refusal("invalid_request", "Invalid operation deadline");
    if (!active.compareAndSet(null, call))
      throw new Refusal("busy", "Another UI request is active");
    call.request = request.toString();
    call.deadline = SystemClock.uptimeMillis() + timeout;
    worker.execute(
        () -> {
          JSONObject result = null;
          Throwable failure = null;
          try {
            result = execute(operation, input, call);
          } catch (Throwable cause) {
            failure = cause;
          } finally {
            try {
              // The retained completion must stay transportable, because the
              // status and cancel replies carry it inside their own envelope.
              call.response = boundedResponse(response(request, result, failure), COMPLETION_BYTES);
            } catch (JSONException malformed) {
              call.response = null;
            }
            call.done = true;
            active.compareAndSet(call, null);
          }
        });
    return object("state", "accepted");
  }

  private JSONObject execute(String operation, JSONObject input, Call call) throws Exception {
    call.check();
    return switch (operation) {
      case "inspect_adb_ui" ->
          object("runner", runner(), "snapshot", capture(input, call).json(true));
      case "find_adb_ui_elements" -> find(input, call, false);
      case "wait_for_adb_ui" -> find(input, call, true);
      case "perform_adb_ui_action" -> action(input, call);
      default -> throw new Refusal("invalid_request", "Unknown UI operation");
    };
  }

  private Snapshot capture(JSONObject input, Call call) throws Exception {
    return capture(input, call, RESPONSE_BYTES - 16384);
  }

  private Snapshot capture(JSONObject input, Call call, int captureBytes) throws Exception {
    if (latest != null) {
      latest.recycle();
      latest = null;
    }
    String packageName = input.getString("package");
    int display = input.optInt("display_id", 0);
    int maximum = input.optInt("max_nodes", 500);
    if (maximum < 1) throw new Refusal("invalid_request", "Node budget must be positive");
    // A retained node reserves at least 1024 bytes of the response budget.
    // Apply the same bound to pending native node handles before allocation.
    int heldNodes = Math.min(maximum, Math.max(0, (captureBytes - 4096) / 1024));
    if (Build.VERSION.SDK_INT < 30 && display != 0)
      throw new Refusal("unsupported", "Secondary display inspection requires Android 11");
    Snapshot snapshot =
        new Snapshot(
            packageName, display, input.has("window_id") ? input.getInt("window_id") : null);
    try {
      ByWindowSelector selector = By.Window.pkg(packageName).displayId(display);
      if (input.has("window_id")) selector.id(input.getInt("window_id"));
      List<UiWindow> windows = device.findWindows(selector);
      ArrayDeque<PendingNode> pending = new ArrayDeque<>();
      try {
        long budget = 4096;
        for (UiWindow window : windows) {
          call.checkCancelled();
          if (call.expired()) {
            snapshot.gaps.put("Observation deadline elapsed");
            break;
          }
          if (pending.size() >= heldNodes) {
            snapshot.gaps.put("Window/root budget exhausted");
            break;
          }
          if (budget + 512 > captureBytes) {
            snapshot.gaps.put("Window response budget exhausted");
            break;
          }
          UiObject2 root = window.getRootObject();
          if (root == null) {
            snapshot.gaps.put("A selected window has no accessible root");
            continue;
          }
          try {
            AccessibilityNodeInfo rootNode = root.getAccessibilityNodeInfo();
            Rect bounds = new Rect();
            android.view.accessibility.AccessibilityWindowInfo info = rootNode.getWindow();
            if (info == null) {
              snapshot.gaps.put("A selected window became unavailable");
              continue;
            }
            try {
              int windowDisplay = Build.VERSION.SDK_INT >= 30 ? info.getDisplayId() : 0;
              if (windowDisplay != display
                  || !packageName.equals(text(rootNode.getPackageName()))) {
                snapshot.gaps.put("A selected window changed package or display");
                continue;
              }
              info.getBoundsInScreen(bounds);
              int windowId = info.getId();
              boolean active = info.isActive();
              boolean focused = info.isFocused();
              // Foreground provenance belongs to the selected windows, not the
              // device-wide active root returned by getCurrentPackageName().
              if (active || focused) snapshot.foregroundPackage = packageName;
              snapshot.windows.put(
                  object(
                      "id",
                      windowId,
                      "display_id",
                      windowDisplay,
                      "active",
                      active,
                      "focused",
                      focused,
                      "bounds",
                      bounds(bounds)));
              budget += 512;
              pending.addLast(
                  new PendingNode(AccessibilityNodeInfo.obtain(rootNode), null, windowId));
            } finally {
              info.recycle();
            }
          } finally {
            root.recycle();
          }
        }
        while (!pending.isEmpty()) {
          call.checkCancelled();
          if (call.expired()) {
            snapshot.gaps.put("Observation deadline elapsed");
            break;
          }
          if (snapshot.nodes.size() >= heldNodes) {
            snapshot.gaps.put("Node budget exhausted");
            break;
          }
          PendingNode next = pending.removeFirst();
          boolean retained = false;
          try {
            AccessibilityNodeInfo node = next.node;
            // The modern API wraps this exact, already selected node.
            // Matching the root avoids an unbounded descendant search.
            UiObject2 element =
                AccessibilityNodeInfoExt.onElement(node, 0L, 100L, candidate -> true);
            snapshot.examined++;
            if (!packageName.equals(text(node.getPackageName()))) {
              snapshot.gaps.put("A foreign-package subtree was not examined");
              continue;
            }
            String id = Integer.toString(snapshot.nodes.size());
            JSONObject facts = facts(element, node, id, next.parent, next.windowId);
            // Worst-case JSON escaping is six UTF-16 code units per
            // source code unit. Bound expansion before final encoding.
            long estimate =
                1024
                    + 6L
                        * (nullableLength(facts, "text")
                            + nullableLength(facts, "content_description")
                            + nullableLength(facts, "resource_id")
                            + nullableLength(facts, "class_name")
                            + packageName.length());
            if (estimate > captureBytes - budget) {
              snapshot.gaps.put("Response budget exhausted");
              break;
            }
            budget += estimate;
            snapshot.nodes.put(id, new Node(element, facts));
            retained = true;
            int children = node.getChildCount();
            int examinedChildren =
                Math.min(children, heldNodes - snapshot.nodes.size() - pending.size());
            if (examinedChildren < children) snapshot.gaps.put("Child traversal budget exhausted");
            for (int i = 0; i < examinedChildren; i++) {
              call.checkCancelled();
              if (call.expired()) {
                snapshot.gaps.put("Observation deadline elapsed");
                break;
              }
              AccessibilityNodeInfo child = node.getChild(i);
              if (child == null) snapshot.gaps.put("An accessibility child was unavailable");
              else pending.addLast(new PendingNode(child, id, next.windowId));
            }
          } finally {
            if (!retained) next.node.recycle();
          }
        }
      } finally {
        for (PendingNode remaining : pending) remaining.node.recycle();
      }
      snapshot.linkClickTargets();
      latest = snapshot;
      return snapshot;
    } catch (StaleObjectException stale) {
      snapshot.gaps.put("Accessibility state changed during capture; examined facts are partial");
      snapshot.linkClickTargets();
      latest = snapshot;
      return snapshot;
    } catch (Refusal stopped) {
      if (stopped.kind.equals("cancelled") || stopped.kind.equals("timeout")) {
        snapshot.gaps.put("Capture stopped: " + stopped.kind);
        snapshot.linkClickTargets();
        latest = snapshot;
        return snapshot;
      }
      snapshot.recycle();
      throw stopped;
    } catch (Throwable cause) {
      snapshot.recycle();
      throw cause;
    }
  }

  private JSONObject find(JSONObject input, Call call, boolean wait) throws Exception {
    JSONObject selector = input.getJSONObject("selector");
    String condition = input.optString("condition", "present");
    Snapshot snapshot = null;
    List<Node> matches = new ArrayList<>();
    boolean satisfied = false;
    boolean queryComplete = false;
    do {
      if (call.cancelled && snapshot != null) break;
      call.checkCancelled();
      if (!wait && input.has("snapshot_id")) snapshot = selectedSnapshot(input);
      else snapshot = capture(input, call);
      matches = new ArrayList<>();
      queryComplete = snapshot.gaps.length() == 0;
      for (Node node : snapshot.nodes.values()) {
        JSONObject visible = maskNode(node.facts);
        boolean hidden =
            (selector.has("text") && visible.getBoolean("text_redacted"))
                || (selector.has("content_description")
                    && visible.getBoolean("content_description_redacted"));
        if (hidden) queryComplete = false;
        else if (matches(visible, selector, snapshot)) matches.add(node);
      }
      satisfied =
          condition.equals("absent") ? matches.isEmpty() && queryComplete : !matches.isEmpty();
      if (!wait || satisfied || call.expired() || call.cancelled) break;
      Thread.sleep(Math.min(100, Math.max(1, call.deadline - SystemClock.uptimeMillis())));
    } while (true);
    int offset = input.optInt("offset", 0);
    int limit = input.optInt("limit", 50);
    if (offset < 0 || limit < 1) throw new Refusal("invalid_request", "Invalid match page");
    JSONArray rows = new JSONArray();
    LinkedHashMap<String, JSONObject> related = new LinkedHashMap<>();
    int end = (int) Math.min(matches.size(), (long) offset + limit);
    for (int i = offset; i < end; i++) {
      Node node = matches.get(i);
      rows.put(node.facts);
      String target = nullable(node.facts, "click_target_id");
      if (target != null && !target.equals(node.facts.getString("id")))
        related.put(target, snapshot.nodes.get(target).facts);
    }
    // Return each node at most once; parent facts already in the page do not
    // consume a second copy of the snapshot's bounded response budget.
    for (int i = offset; i < end; i++) related.remove(matches.get(i).facts.getString("id"));
    JSONObject result =
        object(
            "runner",
            runner(),
            "snapshot",
            snapshot.json(false),
            "matches",
            rows,
            "related_nodes",
            new JSONArray(related.values()),
            "total_matches",
            matches.size(),
            "offset",
            offset,
            "next_offset",
            end < matches.size() ? end : JSONObject.NULL,
            "coverage",
            queryComplete ? "complete" : "partial",
            "freshness",
            input.has("snapshot_id") && !wait ? "retained_snapshot" : "captured");
    if (wait) {
      result.put("satisfied", satisfied);
      result.put("timed_out", !satisfied && !call.cancelled);
      result.put("cancelled", call.cancelled);
    }
    return result;
  }

  private JSONObject action(JSONObject input, Call call) throws Exception {
    Snapshot snapshot = selectedSnapshot(input);
    JSONObject action = input.getJSONObject("action");
    String kind = action.getString("kind");
    Node selected =
        kind.equals("key_event") ? null : snapshot.nodes.get(input.getString("element_id"));
    if (!kind.equals("key_event") && selected == null)
      throw new Refusal("stale_element", "Element does not belong to the selected snapshot");
    ValidatedNode selectedNode =
        selected == null ? null : refreshNode(selected, snapshot, NodeValidation.SNAPSHOT);
    call.check();
    JSONObject before = snapshot.json(false);
    JSONObject selectedFacts = selected == null ? null : selected.facts;
    Boolean verifiedText = null;
    Boolean canScrollMore = null;
    boolean attempted = false;
    boolean completed = false;
    JSONObject actionFailure = null;
    latest = null;
    try {
      switch (kind) {
        case "tap":
          call.check();
          attempted = true;
          selected.object.click();
          break;
        case "double_tap":
          call.check();
          attempted = true;
          selected.object.click();
          call.check();
          refreshNode(selected, snapshot, NodeValidation.CLICK_CONTINUATION);
          call.check();
          selected.object.click();
          break;
        case "long_press":
          call.check();
          attempted = true;
          selected.object.longClick();
          break;
        case "set_text":
          {
            // Consume the node validated at the action boundary. A second,
            // unvalidated refresh could change its password classification
            // while selected_element still describes the admitted selection.
            AccessibilityNodeInfo node = selectedNode.node;
            if (!node.isEditable())
              throw new Refusal("unusable_element", "Selected element is not editable");
            Bundle value = new Bundle();
            String text = action.getString("text");
            if (action.optBoolean("sensitive", false) || node.isPassword()) rememberSensitive(text);
            value.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            // Equivalent to UiObject2.setText, while preserving its actual
            // acknowledgement and avoiding the upstream plaintext log entry.
            call.check();
            attempted = true;
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, value))
              throw new Refusal("action_refused", "Accessibility text entry was refused");
            verifiedText = node.refresh() && text.equals(text(node.getText()));
            break;
          }
        case "scroll":
          if (!selected.facts.getBoolean("scrollable"))
            throw new Refusal("unusable_element", "Selected element is not scrollable");
          call.check();
          attempted = true;
          canScrollMore =
              selected.object.scroll(direction(action), (float) action.getDouble("percent"));
          break;
        case "swipe":
          call.check();
          attempted = true;
          selected.object.swipe(direction(action), (float) action.getDouble("percent"));
          break;
        case "drag":
          {
            Node destination = snapshot.nodes.get(action.getString("destination_id"));
            if (destination == null
                || destination.facts.getInt("window_id") != selected.facts.getInt("window_id"))
              throw new Refusal(
                  "stale_element", "Drag destination must belong to the same captured window");
            ValidatedNode destinationState =
                refreshNode(destination, snapshot, NodeValidation.SNAPSHOT);
            Rect bounds = destinationState.visibleBounds;
            Point center = new Point(bounds.centerX(), bounds.centerY());
            call.check();
            attempted = true;
            selected.object.drag(center);
            break;
          }
        case "key_event":
          int code = action.getInt("key_code");
          int maximumKeyCode = KeyEvent.getMaxKeyCode();
          if (code < 0 || code > maximumKeyCode)
            throw new Refusal(
                "unsupported_key_code",
                "Key code "
                    + code
                    + " is unsupported by this Android version; supported range is 0.."
                    + maximumKeyCode);
          if (snapshot.display != 0)
            throw new Refusal("unsupported", "UI Automator key events target the default display");
          // Accessibility activity does not establish keyboard input routing.
          boolean inputFocused = false;
          ByWindowSelector keyScope =
              By.Window.pkg(snapshot.packageName).displayId(snapshot.display);
          if (snapshot.windowFilter != null) keyScope.id(snapshot.windowFilter);
          for (UiWindow window : device.findWindows(keyScope)) {
            if (!window.isFocused()) continue;
            for (int i = 0; i < snapshot.windows.length(); i++)
              if (snapshot.windows.getJSONObject(i).getInt("id") == window.getId())
                inputFocused = true;
          }
          if (!inputFocused)
            throw new Refusal(
                "focus_changed", "No captured window in the requested scope still has input focus");
          call.check();
          attempted = true;
          if (!device.pressKeyCode(code, action.optInt("meta_state", 0)))
            throw new Refusal("action_refused", "Key event was refused");
          break;
        default:
          throw new Refusal("invalid_request", "Unsupported UI action");
      }
      completed = true;
    } catch (Throwable cause) {
      if (!attempted) {
        snapshot.recycle();
        throw cause;
      }
      actionFailure =
          object(
              "kind",
              cause instanceof Refusal ? ((Refusal) cause).kind : "uiautomator_error",
              "reason",
              reason(cause));
    }
    JSONObject after = null;
    String observationFailure = null;
    try {
      if (call.cancelled) observationFailure = "After-state capture was cancelled";
      else {
        // Include the selected element and before-header in the same
        // Binder budget as the after-capture, before retaining nodes.
        int remaining =
            RESPONSE_BYTES
                - 16384
                - asciiJson(before).length()
                - (selectedFacts == null ? 0 : asciiJson(selectedFacts).length());
        if (remaining < 4096)
          observationFailure = "After-state capture exceeds the remaining response budget";
        else after = capture(input, call, remaining).json(true);
      }
    } catch (Throwable cause) {
      observationFailure = reason(cause);
    }
    try {
      return object(
          "runner",
          runner(),
          "before",
          before,
          "selected_element",
          selectedFacts,
          "dispatch_attempted",
          attempted,
          "action_completed",
          completed,
          "action_error",
          actionFailure,
          "text_verified",
          verifiedText,
          "can_scroll_more",
          canScrollMore,
          "after",
          after,
          "observation_failure",
          observationFailure);
    } finally {
      snapshot.recycle();
    }
  }

  private enum NodeValidation {
    SNAPSHOT,
    CLICK_CONTINUATION
  }

  private static ValidatedNode refreshNode(
      Node selected, Snapshot snapshot, NodeValidation validation) throws Exception {
    // UI Automator 2.4.0 refreshes here and throws StaleObjectException if the
    // retained node cannot be refreshed. Keep freshness owned by that API.
    AccessibilityNodeInfo current = selected.object.getAccessibilityNodeInfo();
    JSONObject fresh =
        facts(
            selected.object,
            current,
            selected.facts.getString("id"),
            nullable(selected.facts, "parent_id"),
            selected.facts.getInt("window_id"));
    // Admission compares every captured fact. Between clicks, presentation and
    // control state can have changed; identity, geometry and capabilities must
    // still match. Never replace the original facts returned in selected_element.
    // Snapshot-derived click targets are added by linkClickTargets, not here.
    java.util.Iterator<String> keys = fresh.keys();
    while (keys.hasNext()) {
      String key = keys.next();
      if (validation == NodeValidation.CLICK_CONTINUATION && mayChangeAfterClick(key)) continue;
      if (!sameFact(fresh.get(key), selected.facts.get(key)))
        throw new Refusal("stale_element", "Selected element changed: " + key);
    }
    android.view.accessibility.AccessibilityWindowInfo window = current.getWindow();
    try {
      if (window == null || (!window.isActive() && !window.isFocused()))
        throw new Refusal("focus_changed", "Selected window is not active or focused");
      if (Build.VERSION.SDK_INT >= 30 && window.getDisplayId() != snapshot.display)
        throw new Refusal("stale_element", "Selected window moved to another display");
    } finally {
      if (window != null) window.recycle();
    }
    // Use the facts just validated; getVisibleBounds() would implicitly refresh
    // again after comparison, creating another unvalidated state transition.
    JSONObject visible = fresh.getJSONObject("visible_bounds");
    Rect bounds =
        new Rect(
            visible.getInt("left"), visible.getInt("top"),
            visible.getInt("right"), visible.getInt("bottom"));
    if (!fresh.getBoolean("enabled") || !fresh.getBoolean("visible") || bounds.isEmpty())
      throw new Refusal("unusable_element", "Selected element is disabled or not visible");
    return new ValidatedNode(current, bounds);
  }

  /** Borrowed node and geometry from the same validated read; the snapshot owns the node. */
  private static final class ValidatedNode {
    final AccessibilityNodeInfo node;
    final Rect visibleBounds;

    ValidatedNode(AccessibilityNodeInfo node, Rect visibleBounds) {
      this.node = node;
      this.visibleBounds = visibleBounds;
    }
  }

  private static boolean mayChangeAfterClick(String fact) {
    switch (fact) {
      case "checked":
      case "selected":
      case "focused":
      case "text":
      case "content_description":
        return true;
      default:
        return false;
    }
  }

  /** Compare producer-owned scalar/rectangle facts without conflating null and "null". */
  private static boolean sameFact(Object first, Object second) throws JSONException {
    if (first instanceof JSONObject && second instanceof JSONObject) {
      JSONObject left = (JSONObject) first;
      JSONObject right = (JSONObject) second;
      if (left.length() != right.length()) return false;
      java.util.Iterator<String> keys = left.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        if (!right.has(key) || !sameFact(left.get(key), right.get(key))) return false;
      }
      return true;
    }
    return java.util.Objects.equals(first, second);
  }

  private Snapshot selectedSnapshot(JSONObject input) throws Exception {
    if (latest == null
        || !latest.id.equals(input.getString("snapshot_id"))
        || !latest.packageName.equals(input.getString("package"))
        || latest.display != input.optInt("display_id", 0)
        || !java.util.Objects.equals(
            latest.windowFilter, input.has("window_id") ? input.getInt("window_id") : null))
      throw new Refusal(
          "stale_snapshot", "The selected snapshot is no longer retained by this runner");
    return latest;
  }

  private static boolean matches(JSONObject node, JSONObject selector, Snapshot snapshot)
      throws Exception {
    for (String field : new String[] {"text", "content_description"})
      if (selector.has(field)) {
        JSONObject rule = selector.getJSONObject(field);
        String value = nullable(node, field);
        if (value == null
            || !(rule.optString("match", "exact").equals("contains")
                ? value.contains(rule.getString("value"))
                : value.equals(rule.getString("value")))) return false;
      }
    for (String field : new String[] {"resource_id", "class_name"})
      if (selector.has(field) && !selector.getString(field).equals(nullable(node, field)))
        return false;
    for (String field :
        new String[] {
          "clickable",
          "enabled",
          "editable",
          "scrollable",
          "focused",
          "selected",
          "checked",
          "visible"
        })
      if (selector.has(field) && selector.getBoolean(field) != node.getBoolean(field)) return false;
    if (selector.has("ancestor_resource_id")) {
      String id = nullable(node, "parent_id");
      while (id != null) {
        Node parent = snapshot.nodes.get(id);
        if (selector
            .getString("ancestor_resource_id")
            .equals(nullable(parent.facts, "resource_id"))) return true;
        id = nullable(parent.facts, "parent_id");
      }
      return false;
    }
    return true;
  }

  private static JSONObject facts(
      UiObject2 object, AccessibilityNodeInfo node, String id, String parent, int window)
      throws Exception {
    Rect visibleBounds = object.getVisibleBounds();
    if (node.getWindowId() != window)
      throw new Refusal("stale_element", "Window changed during observation");
    Rect declaredBounds = new Rect();
    node.getBoundsInScreen(declaredBounds);
    return object(
        "id",
        id,
        "parent_id",
        parent,
        "window_id",
        window,
        "package_name",
        text(node.getPackageName()),
        "class_name",
        text(node.getClassName()),
        "resource_id",
        node.getViewIdResourceName(),
        "text",
        node.isPassword() ? null : text(node.getText()),
        // A password field can carry the entered value in its description
        // instead of its text, so both textual fields are redacted together.
        "content_description",
        node.isPassword() ? null : text(node.getContentDescription()),
        "bounds",
        bounds(declaredBounds),
        "visible_bounds",
        bounds(visibleBounds),
        "enabled",
        node.isEnabled(),
        "clickable",
        node.isClickable(),
        "long_clickable",
        node.isLongClickable(),
        "editable",
        node.isEditable(),
        "scrollable",
        node.isScrollable(),
        "focused",
        node.isFocused(),
        "selected",
        node.isSelected(),
        "checked",
        node.isChecked(),
        "checkable",
        node.isCheckable(),
        "password",
        node.isPassword(),
        "text_redacted",
        node.isPassword(),
        "content_description_redacted",
        node.isPassword(),
        "visible",
        node.isVisibleToUser());
  }

  private static Direction direction(JSONObject action) throws JSONException {
    return Direction.valueOf(action.getString("direction").toUpperCase(Locale.ROOT));
  }

  private JSONObject runner() throws JSONException {
    return object(
        "package_name",
        getTargetContext().getPackageName(),
        "instance_id",
        instance,
        "version",
        BuildConfig.VERSION_NAME,
        "ui_automator_version",
        BuildConfig.UI_AUTOMATOR_VERSION,
        "sdk_int",
        Build.VERSION.SDK_INT);
  }

  private static JSONObject bounds(Rect r) throws JSONException {
    return object("left", r.left, "top", r.top, "right", r.right, "bottom", r.bottom);
  }

  private static String text(CharSequence value) {
    return value == null ? null : value.toString();
  }

  private static String nullable(JSONObject value, String key) throws JSONException {
    return value.isNull(key) ? null : value.getString(key);
  }

  private static int nullableLength(JSONObject value, String key) throws JSONException {
    String s = nullable(value, key);
    return s == null ? 0 : s.length();
  }

  private static String reason(Throwable cause) {
    return cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
  }

  private synchronized void rememberSensitive(String value) throws Refusal {
    if (value.isEmpty() || sensitiveText.contains(value)) return;
    if (value.length() > 65536 - sensitiveCodeUnits)
      throw new Refusal(
          "sensitive_capacity",
          "Runner sensitive-text retention budget exhausted; existing redactions are retained");
    sensitiveText.add(value);
    sensitiveCodeUnits += value.length();
  }

  private synchronized JSONObject maskNode(JSONObject node) throws JSONException {
    JSONObject copy = new JSONObject();
    java.util.Iterator<String> keys = node.keys();
    while (keys.hasNext()) {
      String key = keys.next();
      copy.put(key, node.get(key));
    }
    for (String key : new String[] {"text", "content_description"}) {
      if (copy.isNull(key)) continue;
      String original = copy.getString(key);
      for (String value : sensitiveText) {
        if (original.contains(value)) {
          // Field omission cannot recursively expand placeholders or
          // accidentally expose a literal equal to the placeholder.
          copy.put(key, JSONObject.NULL);
          copy.put(key + "_redacted", true);
          break;
        }
      }
    }
    return copy;
  }

  private Object maskResult(Object value) throws JSONException {
    if (value instanceof JSONArray) {
      JSONArray source = (JSONArray) value;
      JSONArray result = new JSONArray();
      for (int i = 0; i < source.length(); i++) result.put(maskResult(source.get(i)));
      return result;
    }
    if (value instanceof JSONObject) {
      JSONObject source = (JSONObject) value;
      if (source.has("text_redacted") && source.has("package_name")) return maskNode(source);
      JSONObject result = new JSONObject();
      java.util.Iterator<String> keys = source.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        result.put(key, maskResult(source.get(key)));
      }
      return result;
    }
    return value;
  }

  private static JSONObject object(Object... pairs) throws JSONException {
    JSONObject object = new JSONObject();
    for (int i = 0; i < pairs.length; i += 2)
      object.put((String) pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]);
    return object;
  }

  private String encodeResponse(JSONObject message) throws JSONException {
    JSONObject response = boundedResponse(message, RESPONSE_BYTES);
    byte[] bytes = asciiJson(response).getBytes(StandardCharsets.UTF_8);
    return "REA_UI_V2:" + Base64.encodeToString(bytes, Base64.NO_WRAP);
  }

  /**
   * Bound one terminal response to the transport budget. A response that cannot travel is reported
   * as a missing-result capacity envelope instead of being carried silently, so the owning request
   * can still be released.
   */
  private JSONObject boundedResponse(JSONObject message, int limit) throws JSONException {
    JSONObject response = (JSONObject) maskResult(message);
    byte[] bytes = asciiJson(response).getBytes(StandardCharsets.UTF_8);
    if (bytes.length <= limit) return response;
    return object(
        "protocol",
        2,
        "request_id",
        message.optString("request_id", null),
        "instance_id",
        instance,
        "ok",
        false,
        "result",
        null,
        "error",
        object("kind", "capacity", "reason", "Response exceeds the Binder transport budget"));
  }

  private JSONObject response(JSONObject request, JSONObject result, Throwable failure)
      throws JSONException {
    return object(
        "protocol",
        2,
        "request_id",
        request == null ? null : request.optString("request_id", null),
        "instance_id",
        instance,
        "ok",
        failure == null,
        "result",
        result,
        "error",
        failure == null
            ? null
            : object(
                "kind",
                failure instanceof Refusal
                    ? ((Refusal) failure).kind
                    : failure instanceof StaleObjectException ? "stale_element" : "runner_error",
                "reason",
                reason(failure)));
  }

  private static String asciiJson(JSONObject value) {
    String source = value.toString();
    StringBuilder out = new StringBuilder(source.length());
    for (int i = 0; i < source.length(); i++) {
      char c = source.charAt(i);
      if (c < 128) out.append(c);
      else {
        out.append("\\u");
        String hex = Integer.toHexString(c);
        out.append("0000", 0, 4 - hex.length()).append(hex);
      }
    }
    return out.toString();
  }

  private static final class Refusal extends Exception {
    final String kind;

    Refusal(String kind, String message) {
      super(message);
      this.kind = kind;
    }
  }

  private static final class Call {
    final String id;
    volatile long deadline = Long.MAX_VALUE;
    final String operation;
    String request;
    volatile boolean cancelled;
    volatile boolean done;
    volatile JSONObject response;

    Call(String id, String operation) {
      this.id = id;
      this.operation = operation;
    }

    boolean expired() {
      return SystemClock.uptimeMillis() >= deadline;
    }

    void checkCancelled() throws Refusal {
      if (cancelled || Thread.currentThread().isInterrupted())
        throw new Refusal("cancelled", "UI request cancelled");
    }

    void check() throws Refusal {
      checkCancelled();
      if (expired()) throw new Refusal("timeout", "UI request deadline elapsed");
    }
  }

  private static final class PendingNode {
    final AccessibilityNodeInfo node;
    final String parent;
    final int windowId;

    PendingNode(AccessibilityNodeInfo node, String parent, int windowId) {
      this.node = node;
      this.parent = parent;
      this.windowId = windowId;
    }
  }

  private static final class Node {
    final UiObject2 object;
    final JSONObject facts;

    Node(UiObject2 object, JSONObject facts) {
      this.object = object;
      this.facts = facts;
    }
  }

  private static final class Snapshot {
    final String id = UUID.randomUUID().toString();
    final long capturedAt = System.currentTimeMillis();
    final String packageName;
    final int display;
    final Integer windowFilter;
    // Null means no selected window was observed active or focused. It does
    // not substitute a package observed on another display or outside the filter.
    String foregroundPackage;
    final JSONArray windows = new JSONArray();
    final Gaps gaps = new Gaps();
    final LinkedHashMap<String, Node> nodes = new LinkedHashMap<>();
    int examined;

    Snapshot(String packageName, int display, Integer windowFilter) {
      this.packageName = packageName;
      this.display = display;
      this.windowFilter = windowFilter;
    }

    JSONObject json(boolean includeNodes) throws JSONException {
      JSONObject value =
          object(
              "id",
              id,
              "captured_at_ms",
              capturedAt,
              "package_name",
              packageName,
              "display_id",
              display,
              "window_id_filter",
              windowFilter,
              "foreground_package",
              foregroundPackage,
              "windows",
              windows,
              "examined_nodes",
              examined,
              "retained_nodes",
              nodes.size(),
              "coverage",
              gaps.length() == 0 ? "complete" : "partial",
              "limitations",
              new JSONArray(gaps.values));
      if (includeNodes) {
        JSONArray values = new JSONArray();
        for (Node node : nodes.values()) values.put(node.facts);
        value.put("nodes", values);
      }
      return value;
    }

    void recycle() {
      for (Node node : nodes.values()) node.object.recycle();
      nodes.clear();
    }

    void linkClickTargets() throws JSONException {
      for (Node node : nodes.values()) {
        Node candidate = node;
        while (candidate != null && !candidate.facts.getBoolean("clickable")) {
          String parent = nullable(candidate.facts, "parent_id");
          candidate = parent == null ? null : nodes.get(parent);
        }
        node.facts.put(
            "click_target_id",
            candidate == null ? JSONObject.NULL : candidate.facts.getString("id"));
      }
    }
  }

  /** A repeated missing-child diagnostic must not grow with every skipped node. */
  private static final class Gaps {
    final Set<String> values = new LinkedHashSet<>();

    void put(String reason) {
      values.add(reason);
    }

    int length() {
      return values.size();
    }
  }
}
