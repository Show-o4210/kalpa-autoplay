import Java from "frida-java-bridge";

"use strict";

// Verified against KALPA 4.0.7 (Android, arm64-v8a). The signature check
// below intentionally refuses to hook an unknown native build.

const TARGET_ACTIVITY = "com.google.firebase.MessagingUnityPlayerActivity";
const BALL_TAG = "kalpa-auto-floating-ball-v1";

const OFF = {
  update: 0x2453fbc,
  panelLogic: 0x110,
  panelIsPlaying: 0x118,
  panelAuto: 0x298,
  logicAuto: 0x80
};

let initialized = false;
let autoEnabled = false;
let startupPoll = null;
let updateHook = null;
let nativePoll = null;
let javaPoll = null;
let retainedActivity = null;
let retainedBall = null;
let activityOnResume = null;
let ballSizePx = 142;
let ballDragThresholdPx = 18;
let ballSafeInsetPx = 16;
const touchState = {
  active: false,
  dragged: false,
  downRawX: 0,
  downRawY: 0,
  downX: 0,
  downY: 0
};

function log(message) {
  console.log("[KalpaAuto] " + message);
}

function installNativeHook() {
  if (updateHook !== null) return true;

  let module;
  try {
    module = Process.getModuleByName("libil2cpp.so");
  } catch (_) {
    return false;
  }

  const updateAddress = module.base.add(OFF.update);
  const signature0 = updateAddress.readU32();
  const signature1 = updateAddress.add(4).readU32();
  if (signature0 !== 0xd10183ff || signature1 !== 0xfd001bea) {
    log(
      "unsupported KALPA build; Update signature=" +
        signature0.toString(16) +
        " " +
        signature1.toString(16)
    );
    return true;
  }

  updateHook = Interceptor.attach(updateAddress, {
    onEnter(args) {
      this.changed = false;
      if (!autoEnabled) return;

      const panel = args[0];
      if (panel.isNull()) return;
      if (panel.add(OFF.panelIsPlaying).readU8() === 0) return;

      const logic = panel.add(OFF.panelLogic).readPointer();
      if (logic.isNull()) return;

      this.panel = panel;
      this.logic = logic;
      this.oldPanelAuto = panel.add(OFF.panelAuto).readU8();
      this.oldLogicAuto = logic.add(OFF.logicAuto).readU8();
      panel.add(OFF.panelAuto).writeU8(1);
      logic.add(OFF.logicAuto).writeU8(1);
      this.changed = true;
    },
    onLeave(_) {
      if (!this.changed) return;
      try {
        this.panel.add(OFF.panelAuto).writeU8(this.oldPanelAuto);
        this.logic.add(OFF.logicAuto).writeU8(this.oldLogicAuto);
      } catch (_) {
      }
      this.changed = false;
    }
  });

  log("native AutoMode hook installed at " + updateAddress);
  return true;
}

function startNativeHookPoll() {
  if (installNativeHook()) return;
  nativePoll = setInterval(() => {
    if (installNativeHook()) {
      clearInterval(nativePoll);
      nativePoll = null;
    }
  }, 250);
}

function makeBackground(enabled) {
  const GradientDrawable = Java.use("android.graphics.drawable.GradientDrawable");
  const Color = Java.use("android.graphics.Color");
  const background = GradientDrawable.$new();
  background.setShape(1);
  background.setColor(
    Color.parseColor(enabled ? "#E62EBD72" : "#DD626874")
  );
  background.setStroke(2, Color.parseColor(enabled ? "#FFFFFFFF" : "#CCFFFFFF"));
  return background;
}

function refreshBall(ball) {
  const JString = Java.use("java.lang.String");
  ball.setText.overload("java.lang.CharSequence").call(
    ball,
    JString.$new(autoEnabled ? "AUTO\nON" : "AUTO\nOFF")
  );
  ball.setTextSize(9);
  ball.setBackground(makeBackground(autoEnabled));
  ball.setAlpha(autoEnabled ? 0.95 : 0.86);
}

function getBallParent(ball) {
  const rawParent = ball.getParent();
  if (rawParent === null) return null;
  const ViewGroup = Java.use("android.view.ViewGroup");
  return Java.cast(rawParent, ViewGroup);
}

function placeBall(ball, x, y) {
  const FrameLayoutParams = Java.use("android.widget.FrameLayout$LayoutParams");
  const params = Java.cast(ball.getLayoutParams(), FrameLayoutParams);
  params.leftMargin.value = Math.round(x);
  params.topMargin.value = Math.round(y);
  ball.setLayoutParams(params);
}

function clampBallInsideParent(ball) {
  const parent = getBallParent(ball);
  if (parent === null || ball.getWidth() <= 0 || parent.getWidth() <= 0) return;
  const minX = Math.min(ballSafeInsetPx, parent.getWidth() - ball.getWidth());
  const minY = Math.min(ballSafeInsetPx, parent.getHeight() - ball.getHeight());
  const maxX = Math.max(minX, parent.getWidth() - ball.getWidth() - ballSafeInsetPx);
  const maxY = Math.max(minY, parent.getHeight() - ball.getHeight() - ballSafeInsetPx);
  placeBall(
    ball,
    Math.max(minX, Math.min(ball.getLeft(), maxX)),
    Math.max(minY, Math.min(ball.getTop(), maxY))
  );
}

function toggleAutoFromBall(ball) {
  autoEnabled = !autoEnabled;
  refreshBall(ball);
  log("AutoMode " + (autoEnabled ? "ON" : "OFF"));
}

function installBallOnMainThread(activity) {
  const ViewGroup = Java.use("android.view.ViewGroup");
  const TextView = Java.use("android.widget.TextView");
  const FrameLayoutParams = Java.use("android.widget.FrameLayout$LayoutParams");
  const Gravity = Java.use("android.view.Gravity");
  const Color = Java.use("android.graphics.Color");
  const MotionEvent = Java.use("android.view.MotionEvent");
  const OnTouchListener = Java.use("android.view.View$OnTouchListener");

  const decor = Java.cast(activity.getWindow().getDecorView(), ViewGroup);
  const existing = decor.findViewWithTag(BALL_TAG);
  if (existing !== null) {
    retainedBall = Java.retain(existing);
    refreshBall(existing);
    clampBallInsideParent(existing);
    return;
  }

  const density = activity.getResources().getDisplayMetrics().density.value;
  const size = Math.round(54 * density);
  const margin = Math.round(14 * density);
  ballSizePx = size;
  ballDragThresholdPx = Math.round(7 * density);
  ballSafeInsetPx = Math.round(6 * density);

  const ball = TextView.$new(activity);
  ball.setTag(BALL_TAG);
  ball.setTextColor(Color.WHITE.value);
  ball.setTextSize(9);
  ball.setGravity(Gravity.CENTER.value);
  ball.setAllCaps(false);
  ball.setElevation(12 * density);
  ball.setPadding(0, 0, 0, 0);

  const params = FrameLayoutParams.$new(ballSizePx, ballSizePx);
  params.gravity.value = Gravity.LEFT.value | Gravity.TOP.value;
  params.leftMargin.value = margin;
  params.topMargin.value = Math.max(
    ballSafeInsetPx,
    Math.round((decor.getHeight() - ballSizePx) / 2)
  );
  ball.setLayoutParams(params);

  const TouchListener = Java.registerClass({
    name: "re.kalpa.assist.AutoBallTouch" + Date.now(),
    implements: [OnTouchListener],
    methods: {
      onTouch(view, event) {
        const TextView = Java.use("android.widget.TextView");
        const ball = Java.cast(view, TextView);
        const action = event.getActionMasked();

        if (action === MotionEvent.ACTION_DOWN.value) {
          ball.animate().cancel();
          touchState.active = true;
          touchState.dragged = false;
          touchState.downRawX = event.getRawX();
          touchState.downRawY = event.getRawY();
          touchState.downX = ball.getLeft();
          touchState.downY = ball.getTop();
          return true;
        }

        if (action === MotionEvent.ACTION_MOVE.value && touchState.active) {
          const dx = event.getRawX() - touchState.downRawX;
          const dy = event.getRawY() - touchState.downRawY;
          if (!touchState.dragged && Math.hypot(dx, dy) >= ballDragThresholdPx) {
            touchState.dragged = true;
            ball.setAlpha(autoEnabled ? 0.95 : 0.82);
          }
          if (touchState.dragged) {
            const parent = getBallParent(ball);
            if (parent === null) return true;
            const minX = Math.min(ballSafeInsetPx, parent.getWidth() - ball.getWidth());
            const minY = Math.min(ballSafeInsetPx, parent.getHeight() - ball.getHeight());
            const maxX = Math.max(minX, parent.getWidth() - ball.getWidth() - ballSafeInsetPx);
            const maxY = Math.max(minY, parent.getHeight() - ball.getHeight() - ballSafeInsetPx);
            placeBall(
              ball,
              Math.max(minX, Math.min(touchState.downX + dx, maxX)),
              Math.max(minY, Math.min(touchState.downY + dy, maxY))
            );
          }
          return true;
        }

        if (
          action === MotionEvent.ACTION_UP.value ||
          action === MotionEvent.ACTION_CANCEL.value
        ) {
          const wasDragged = touchState.dragged;
          touchState.active = false;
          touchState.dragged = false;
          clampBallInsideParent(ball);
          if (!wasDragged && action === MotionEvent.ACTION_UP.value) {
            toggleAutoFromBall(ball);
          }
          return true;
        }

        return true;
      }
    }
  });
  ball.setOnTouchListener(TouchListener.$new());
  refreshBall(ball);
  decor.addView(ball);

  retainedActivity = Java.retain(activity);
  retainedBall = Java.retain(ball);
  log("floating ball installed");
}

function scheduleBallInstall(activity) {
  const kept = Java.retain(activity);
  Java.scheduleOnMainThread(() => {
    try {
      installBallOnMainThread(kept);
    } catch (error) {
      log("floating ball install failed: " + error.stack);
    }
  });
}

function findCurrentActivity() {
  Java.choose(TARGET_ACTIVITY, {
    onMatch(activity) {
      scheduleBallInstall(activity);
      return "stop";
    },
    onComplete() {
    }
  });
}

function installJavaUi() {
  if (!Java.available) return false;

  Java.perform(() => {
    const Activity = Java.use("android.app.Activity");
    activityOnResume = Activity.onResume.overload();
    activityOnResume.implementation = function () {
      activityOnResume.call(this);
      try {
        if (this.getClass().getName().toString() === TARGET_ACTIVITY) {
          scheduleBallInstall(this);
        }
      } catch (_) {
      }
    };
    findCurrentActivity();
  });

  log("Java UI hook installed");
  return true;
}

function startJavaUiPoll() {
  if (installJavaUi()) return;
  javaPoll = setInterval(() => {
    if (installJavaUi()) {
      clearInterval(javaPoll);
      javaPoll = null;
    }
  }, 250);
}

function initialize(stage) {
  if (initialized) return;
  initialized = true;
  log("initializing at stage=" + stage);
  startNativeHookPoll();
  startJavaUiPoll();
}

function waitForKalpaRuntime(stage) {
  const ready = () => Process.findModuleByName("libunity.so") !== null;
  if (ready()) {
    initialize(stage);
    return;
  }

  if (startupPoll !== null) return;
  startupPoll = setInterval(() => {
    if (!ready()) return;
    clearInterval(startupPoll);
    startupPoll = null;
    initialize(stage);
  }, 250);
}

function dispose() {
  autoEnabled = false;
  if (startupPoll !== null) clearInterval(startupPoll);
  if (nativePoll !== null) clearInterval(nativePoll);
  if (javaPoll !== null) clearInterval(javaPoll);
  if (updateHook !== null) updateHook.detach();

  try {
    Java.perform(() => {
      if (activityOnResume !== null) activityOnResume.implementation = null;
      if (retainedActivity !== null && retainedBall !== null) {
        const activity = retainedActivity;
        const ball = retainedBall;
        Java.scheduleOnMainThread(() => {
          try {
            const ViewGroup = Java.use("android.view.ViewGroup");
            const parent = ball.getParent();
            if (parent !== null) Java.cast(parent, ViewGroup).removeView(ball);
          } catch (_) {
          }
        });
      }
    });
  } catch (_) {
  }
  log("disposed");
}

rpc.exports = {
  init(stage, _parameters) {
    waitForKalpaRuntime(stage);
  },
  dispose() {
    dispose();
  },
  enable() {
    autoEnabled = true;
    return true;
  },
  disable() {
    autoEnabled = false;
    return true;
  },
  state() {
    return { initialized, autoEnabled, nativeHook: updateHook !== null };
  }
};

// With Android's wrap mechanism Gadget is loaded before ART finishes booting.
// Touching the Java bridge during that window can crash HeapTaskDaemon, so the
// app-specific Unity module is our safe readiness barrier.
setImmediate(() => waitForKalpaRuntime("manual"));
