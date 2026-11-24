const { setTimeout: delay } = require('node:timers/promises');

const ENTER = 'enter-html-full-screen';
const LEAVE = 'leave-html-full-screen';
const ROOT = 'libretv-fullscreen-test';

const enter = "(() => { const probe = document.createElement('section'); probe.id = '" + ROOT + "';" +
  "const button = document.createElement('button'); button.textContent = 'Exit fullscreen';" +
  "button.onclick = () => void document.exitFullscreen(); probe.append(button); document.body.append(probe);" +
  "return probe.requestFullscreen(); })()";
const exitButton = "document.getElementById('" + ROOT + "')?.querySelector('button')?.click()";
const cleanup = "document.getElementById('" + ROOT + "')?.remove()";

function waitForRendererFullscreen(id, active) {
  const matches = () => active
    ? document.fullscreenElement !== null && document.fullscreenElement === document.getElementById(id)
    : document.fullscreenElement === null;
  if (matches()) return true;
  return new Promise((resolve) => {
    const changed = () => { if (matches()) finish(true); };
    const timer = setTimeout(() => finish(matches()), 3000);
    function finish(matched) {
      clearTimeout(timer);
      document.removeEventListener('fullscreenchange', changed);
      resolve(matched);
    }
    document.addEventListener('fullscreenchange', changed);
  });
}

function rendererFullscreenScript(active) {
  return '(' + waitForRendererFullscreen.toString() + ')(' + JSON.stringify(ROOT) + ', ' + active + ')';
}

function closeBounds(a, b) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 3);
}

async function until(observe) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (observe()) return true;
    await delay(50);
  }
  return false;
}

async function evaluate(contents, code, gesture = false) {
  const timer = AbortSignal.timeout(4000);
  let listener;
  try {
    const timeout = new Promise((_, reject) => {
      listener = () => reject(timer.reason);
      timer.addEventListener('abort', listener, { once: true });
    });
    return await Promise.race([contents.executeJavaScript(code, gesture), timeout]);
  } finally {
    timer.removeEventListener('abort', listener);
  }
}

async function observeFullscreen(window, screen, log) {
  const contents = window.webContents;
  const displays = screen.getAllDisplays();
  const original = window.getBounds();
  let enters = 0;
  let leaves = 0;
  const entered = () => { enters++; };
  const left = () => { leaves++; };
  contents.on(ENTER, entered);
  contents.on(LEAVE, left);

  const run = async (name, display, maximize, esc) => {
    const metrics = {};
    let step = 'FULLSCREEN_PLACE_WINDOW';
    try {
      window.unmaximize();
      const work = display.workArea;
      window.setBounds({
        x: work.x + 24, y: work.y + 24,
        width: Math.min(1000, work.width - 48), height: Math.min(700, work.height - 48),
      });
      metrics.displayPlaced = Number(await until(() => screen.getDisplayMatching(window.getBounds()).id === display.id));
      if (!metrics.displayPlaced) throw new Error('Could not place window on target display');

      step = 'FULLSCREEN_WINDOW_MODE';
      if (maximize) window.maximize();
      metrics.windowModePrepared = Number(await until(() => window.isMaximized() === maximize));
      if (!metrics.windowModePrepared) throw new Error('Could not prepare window mode');
      window.focus();
      contents.focus();
      const before = window.getBounds();
      const entryCount = enters;
      const exitCount = leaves;

      step = 'FULLSCREEN_ENTER_REQUEST';
      await evaluate(contents, enter, true);
      step = 'FULLSCREEN_NATIVE_ENTER';
      const native = await until(() => {
        metrics.htmlEnterObserved = Number(enters === entryCount + 1);
        metrics.nativeEntered = Number(window.isFullScreen());
        metrics.displayBoundsMatched = Number(closeBounds(window.getBounds(), display.bounds));
        return metrics.htmlEnterObserved && metrics.nativeEntered && metrics.displayBoundsMatched;
      });

      // The native observer can complete before Chromium updates its DOM state.
      step = 'FULLSCREEN_DOM_ENTER';
      metrics.domEntered = Number(await evaluate(contents, rendererFullscreenScript(true)));

      step = 'FULLSCREEN_EXIT_ACTION';
      if (esc) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      } else {
        await evaluate(contents, exitButton);
      }

      step = 'FULLSCREEN_NATIVE_EXIT';
      const restored = await until(() => {
        metrics.htmlExitObserved = Number(leaves === exitCount + 1);
        metrics.nativeExited = Number(!window.isFullScreen());
        metrics.windowModeRestored = Number(window.isMaximized() === maximize);
        metrics.windowBoundsRestored = Number(closeBounds(window.getBounds(), before));
        return metrics.htmlExitObserved && metrics.nativeExited && metrics.windowModeRestored && metrics.windowBoundsRestored;
      });

      step = 'FULLSCREEN_DOM_EXIT';
      metrics.domExited = Number(await evaluate(contents, rendererFullscreenScript(false)));

      let code;
      if (!native) code = 'FULLSCREEN_NATIVE_ENTER';
      else if (!metrics.domEntered) code = 'FULLSCREEN_DOM_ENTER';
      else if (!restored) code = 'FULLSCREEN_NATIVE_EXIT';
      else if (!metrics.domExited) code = 'FULLSCREEN_DOM_EXIT';
      log('integration-check', {
        name, status: code ? 'FAIL' : 'PASS', code, metrics,
        detail: 'Fullscreen API, Electron HTML events, native display bounds and restored window',
      });
    } catch {
      log('integration-check', {
        name, status: 'FAIL', code: step, metrics,
        detail: 'Fullscreen probe failed before completing its observations',
      });
    } finally {
      await evaluate(contents, 'document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : null')
        .catch(() => {});
      if (window.isFullScreen()) window.setFullScreen(false);
      await evaluate(contents, cleanup).catch(() => {});
    }
  };

  try {
    window.show();
    const display = screen.getDisplayMatching(original);
    await run('native-fullscreen-windowed-escape', display, false, true);
    await run('native-fullscreen-maximized-button', display, true, false);
    const second = displays.find(({ id }) => id !== display.id);
    if (second) await run('native-fullscreen-second-display', second, false, false);
    else log('integration-check', { name: 'native-fullscreen-second-display', status: 'NOT RUN', detail: 'One display available' });
  } finally {
    contents.removeListener(ENTER, entered);
    contents.removeListener(LEAVE, left);
    window.unmaximize();
    window.setBounds(original);
    window.hide();
  }
}

module.exports = { observeFullscreen };
