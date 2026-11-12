package com.rea.ui.probe;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.util.Base64;
import android.view.DragEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** Self-owned UI oracle; it requests no permissions and performs no network I/O. */
public final class Main extends Activity {
  private int taps = 0;
  private int toggleClicks = 0;
  private int inputTouchUps = 0;
  private String toggleClickMutation = "none";
  private boolean toggleCheckable = true;
  private int testKeys = 0;
  private int dragStarts = 0;
  private int drops = 0;
  private BroadcastReceiver mutations;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    EditText input = new EditText(this);
    input.setId(id("entry"));
    input.setSingleLine(true);
    input.setContentDescription("rea-input");
    String mirrored = getIntent().getStringExtra("mirror_text");
    if (mirrored != null) {
      input.setText(mirrored);
      input.setContentDescription("Mirrored: " + mirrored);
    }
    input.setOnTouchListener(
        (view, event) -> {
          if (event.getAction() == MotionEvent.ACTION_UP) inputTouchUps++;
          return false;
        });
    input.setAccessibilityDelegate(
        new View.AccessibilityDelegate() {
          @Override
          public void onInitializeAccessibilityNodeInfo(View view, AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(view, info);
            // Some controls expose empty text as null. Keep that case stable when
            // testing a password transition whose only distinguishing fact is its flag.
            if (input.length() == 0) info.setText(null);
          }
        });
    layout.addView(input);
    Button button = new Button(this);
    button.setId(id("sign_in"));
    button.setText("Sign in");
    button.setAllCaps(false);
    button.setContentDescription("rea-tap");
    layout.addView(button);
    TextView status = new TextView(this);
    status.setContentDescription("rea-status");
    status.setId(id("status"));
    status.setText("Tapped 0");
    layout.addView(status);
    button.setOnClickListener(view -> status.setText("Tapped " + (++taps)));
    button.setOnLongClickListener(
        view -> {
          status.setText("Long pressed");
          return true;
        });
    LinearLayout duplicates = new LinearLayout(this);
    for (int index = 0; index < 2; index++) {
      final int selected = index;
      Button duplicate = new Button(this);
      duplicate.setAllCaps(false);
      duplicate.setText("Duplicate");
      duplicate.setId(id(index == 0 ? "duplicate_one" : "duplicate_two"));
      duplicate.setOnClickListener(view -> status.setText("Duplicate " + selected));
      duplicates.addView(duplicate, new LinearLayout.LayoutParams(0, -2, 1));
    }
    layout.addView(duplicates);
    Button disabled = new Button(this);
    disabled.setText("Disabled");
    disabled.setAllCaps(false);
    disabled.setEnabled(false);
    disabled.setId(id("disabled"));
    layout.addView(disabled);
    LinearLayout composite = new LinearLayout(this);
    composite.setId(id("composite"));
    composite.setClickable(true);
    composite.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
    composite.setPadding(20, 20, 20, 20);
    composite.setOnClickListener(view -> status.setText("Continued"));
    TextView label = new TextView(this);
    label.setText("Continue");
    label.setId(id("continue_label"));
    label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
    composite.addView(label);
    layout.addView(composite);
    LinearLayout dragRow = new LinearLayout(this);
    Button source = new Button(this);
    source.setText("Drag");
    source.setAllCaps(false);
    source.setId(id("drag_source"));
    source.setOnLongClickListener(
        view -> {
          dragStarts++;
          return view.startDragAndDrop(
              ClipData.newPlainText("fixture", "drag"), new View.DragShadowBuilder(view), null, 0);
        });
    Button destination = new Button(this);
    destination.setText("Drop");
    destination.setAllCaps(false);
    destination.setId(id("drag_destination"));
    destination.setOnDragListener(
        (view, event) -> {
          if (event.getAction() == DragEvent.ACTION_DROP) {
            drops++;
            status.setText("Dropped");
          }
          return true;
        });
    dragRow.addView(source, new LinearLayout.LayoutParams(0, -2, 1));
    dragRow.addView(destination, new LinearLayout.LayoutParams(0, -2, 1));
    layout.addView(dragRow);
    CheckBox toggle = new CheckBox(this);
    toggle.setId(id("toggle"));
    toggle.setText("Toggle");
    toggle.setOnClickListener(
        view -> {
          toggleClicks++;
          switch (toggleClickMutation) {
            case "disable_on_click":
              toggle.setEnabled(false);
              break;
            case "move_on_click":
              toggle.setTranslationX(60);
              break;
            case "detach_on_click":
              layout.removeView(toggle);
              break;
            case "leave_on_click":
              startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME));
              break;
            case "relabel_on_click":
              toggle.setText("Toggled " + toggleClicks);
              toggle.setContentDescription("Toggle count " + toggleClicks);
              toggle.setSelected(toggle.isChecked());
              break;
          }
        });
    toggle.setAccessibilityDelegate(
        new View.AccessibilityDelegate() {
          @Override
          public void onInitializeAccessibilityNodeInfo(View view, AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(view, info);
            info.setCheckable(toggleCheckable);
          }
        });
    layout.addView(toggle);
    Button mirror = new Button(this);
    mirror.setId(id("mirror_input"));
    mirror.setText("Mirror input");
    mirror.setAllCaps(false);
    mirror.setOnClickListener(
        view ->
            startActivity(
                new Intent()
                    .setComponent(new ComponentName("com.rea.ui.mirror", Main.class.getName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra("mirror_text", input.getText().toString())));
    layout.addView(mirror);
    ScrollView scroll = new ScrollView(this);
    scroll.setContentDescription("rea-scroll");
    scroll.setId(id("scroll"));
    LinearLayout rows = new LinearLayout(this);
    rows.setOrientation(LinearLayout.VERTICAL);
    for (int index = 0; index < 40; index++) {
      TextView row = new TextView(this);
      row.setText("Row " + index);
      row.setTextSize(24);
      row.setPadding(8, 20, 8, 20);
      rows.addView(row);
    }
    scroll.addView(rows);
    layout.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(layout);
    mutations =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            String mutation = intent.getStringExtra("mutation");
            if (mutation == null) {
              setResultCode(1);
              return;
            }
            switch (mutation) {
              case "disable":
                button.setEnabled(false);
                break;
              case "move":
                button.setTranslationX(60);
                break;
              case "detach":
                layout.removeView(button);
                break;
              case "password":
                input.setRawInputType(
                    InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                input.setTransformationMethod(PasswordTransformationMethod.getInstance());
                break;
              case "text":
                input.setText("null");
                break;
              case "checked":
                toggle.setChecked(true);
                break;
              case "selected":
                toggle.setSelected(true);
                break;
              case "focused":
                toggle.setFocusableInTouchMode(true);
                toggle.requestFocus();
                break;
              case "checkable":
                toggleCheckable = false;
                toggle.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
                break;
              case "observe":
                break;
              case "disable_on_click":
              case "move_on_click":
              case "detach_on_click":
              case "leave_on_click":
              case "relabel_on_click":
                toggleClickMutation = mutation;
                break;
              case "reset":
                if (button.getParent() == null) layout.addView(button, 1);
                button.setEnabled(true);
                button.setTranslationX(0);
                input.setRawInputType(InputType.TYPE_CLASS_TEXT);
                input.setTransformationMethod(null);
                input.setText("");
                inputTouchUps = 0;
                testKeys = 0;
                dragStarts = 0;
                drops = 0;
                toggleClickMutation = "none";
                if (toggle.getParent() == null) layout.addView(toggle, layout.indexOfChild(scroll));
                toggle.setEnabled(true);
                toggle.setTranslationX(0);
                toggle.setText("Toggle");
                toggle.setContentDescription(null);
                toggle.setChecked(false);
                toggle.setSelected(false);
                toggle.setFocusableInTouchMode(false);
                toggleCheckable = true;
                input.requestFocus();
                toggleClicks = 0;
                break;
              default:
                setResultCode(1);
                return;
            }
            // Read back actual View state before acknowledging this deterministic,
            // fixture-only mutation. No new runner capture retires the old snapshot.
            AccessibilityNodeInfo toggleState = toggle.createAccessibilityNodeInfo();
            try {
              JSONObject observation =
                  new JSONObject()
                      .put("mutation", mutation)
                      .put("enabled", button.isEnabled())
                      .put("translation_x", button.getTranslationX())
                      .put("attached", button.getParent() != null)
                      .put(
                          "password",
                          input.getTransformationMethod() instanceof PasswordTransformationMethod)
                      .put("input_text", input.getText().toString())
                      .put("input_focused", input.hasFocus())
                      .put("input_touch_ups", inputTouchUps)
                      .put("test_keys", testKeys)
                      .put("drag_starts", dragStarts)
                      .put("drops", drops)
                      .put("checked", toggleState.isChecked())
                      .put("selected", toggleState.isSelected())
                      .put("focused", toggleState.isFocused())
                      .put("checkable", toggleState.isCheckable())
                      .put("toggle_enabled", toggle.isEnabled())
                      .put("toggle_translation_x", toggle.getTranslationX())
                      .put("toggle_attached", toggle.getParent() != null)
                      .put("toggle_text", toggle.getText().toString())
                      .put("on_click", toggleClickMutation)
                      .put("toggle_clicks", toggleClicks);
              setResultData(
                  Base64.encodeToString(
                      observation.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            } catch (JSONException failure) {
              throw new AssertionError(failure);
            } finally {
              toggleState.recycle();
            }
            setResultCode(0);
          }
        };
    IntentFilter filter = new IntentFilter(getPackageName() + ".MUTATE");
    if (Build.VERSION.SDK_INT >= 33)
      registerReceiver(
          mutations, filter, Manifest.permission.DUMP, null, Context.RECEIVER_EXPORTED);
    else registerReceiver(mutations, filter, Manifest.permission.DUMP, null);
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    if (event.getKeyCode() == KeyEvent.KEYCODE_F1) {
      if (event.getAction() == KeyEvent.ACTION_DOWN) testKeys++;
      return true;
    }
    return super.dispatchKeyEvent(event);
  }

  @Override
  public void onDestroy() {
    if (mutations != null) unregisterReceiver(mutations);
    super.onDestroy();
  }

  private int id(String name) {
    return getResources().getIdentifier(name, "id", getPackageName());
  }
}
