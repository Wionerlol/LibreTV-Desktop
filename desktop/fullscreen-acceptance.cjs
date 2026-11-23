const { setTimeout: delay } = require('node:timers/promises');

const ENTER = 'enter-html-full-screen';
const LEAVE = 'leave-html-full-screen';
const ROOT = 'libretv-fullscreen-test';

const enter = "(() => { const probe = document.createElement('section'); probe.id = '" + ROOT + "';" +
  "const button = document.createElement('button'); button.textContent = 'Exit fullscreen';" +
  "button.onclick = () => void document.exitFullscreen(); probe.append(button); document.body.append(probe);" +
  "return probe.requestFullscreen().then(() => document.fullscreenElement === probe); })()";
const exitButton = "document.getElementById('" + ROOT + "')?.querySelector('button')?.click()";
const cleanup = "document.getElementById('" + ROOT + "')?.remove()";

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
    try {
      window.unmaximize();
      const work = display.workArea;
      window.setBounds({
        x: work.x + 24, y: work.y + 24,
        width: Math.min(1000, work.width - 48), height: Math.min(700, work.height - 48),
      });
      if (!await until(() => screen.getDisplayMatching(window.getBounds()).id === display.id)) {
        throw new Error('DISPLAY_PLACEMENT');
      }
      if (maximize) window.maximize();
      if (!await until(() => window.isMaximized() === maximize)) throw new Error('WINDOW_MODE');
      window.focus();
      contents.focus();
      const before = window.getBounds();
      const entryCount = enters;
      const exitCount = leaves;
      const domEntered = await evaluate(contents, enter, true);
      const native = await until(() => enters === entryCount + 1 && window.isFullScreen() &&
        closeBounds(window.getBounds(), display.bounds));
      if (esc) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      } else {
        await evaluate(contents, exitButton);
      }
      const restored = await until(() => leaves === exitCount + 1 && !window.isFullScreen() &&
        window.isMaximized() === maximize && closeBounds(window.getBounds(), before));
      const domExited = await evaluate(contents, 'document.fullscreenElement === null');
      log('integration-check', {
        name, status: domEntered && native && restored && domExited ? 'PASS' : 'FAIL',
        detail: 'Fullscreen API, Electron HTML events, native display bounds and restored window',
      });
    } catch {
      log('integration-check', { name, status: 'FAIL', detail: 'Fullscreen probe failed before completing its observations' });
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
