const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const vm = require('node:vm');
const { observeFullscreen } = require('./fullscreen-acceptance.cjs');

async function runProbe({ delayExit = true } = {}) {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 }, workArea: { x: 0, y: 0, width: 1600, height: 860 } },
    { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 800 }, workArea: { x: -1280, y: 0, width: 1280, height: 760 } },
  ];
  const screen = {
    getAllDisplays: () => displays,
    getDisplayMatching: ({ x }) => displays[x < 0 ? 1 : 0],
  };
  const document = new EventTarget();
  document.fullscreenElement = null;
  const nodes = new Map();
  let bounds = { x: 40, y: 60, width: 1000, height: 700 };
  let saved;
  let maximized = false;
  let fullscreen = false;
  const contents = new EventEmitter();

  function transition(active, element) {
    fullscreen = active;
    if (active) {
      saved = bounds;
      bounds = screen.getDisplayMatching(bounds).bounds;
    } else {
      bounds = saved;
    }
    contents.emit(active ? 'enter-html-full-screen' : 'leave-html-full-screen');
    if (active || delayExit) {
      setTimeout(() => {
        document.fullscreenElement = element;
        document.dispatchEvent(new Event('fullscreenchange'));
      }, 15);
    }
    return Promise.resolve();
  }

  document.body = { append: (element) => nodes.set(element.id, element) };
  document.getElementById = (id) => nodes.get(id) || null;
  document.exitFullscreen = () => fullscreen ? transition(false, null) : Promise.resolve();
  document.createElement = () => ({
    append(child) { this.button = child; },
    querySelector() { return this.button; },
    requestFullscreen() { return transition(true, this); },
    remove() { nodes.delete(this.id); },
    click() { this.onclick(); },
  });
  const renderer = vm.createContext({
    document, clearTimeout,
    setTimeout: (callback, milliseconds) => setTimeout(callback, Math.min(milliseconds, 100)),
  });
  Object.assign(contents, {
    async executeJavaScript(script, gesture) {
      if (script.includes('probe.requestFullscreen()')) assert.equal(gesture, true);
      return vm.runInContext(script, renderer);
    },
    sendInputEvent({ type, keyCode }) {
      if (type === 'keyDown' && keyCode === 'Escape') void document.exitFullscreen();
    },
    focus() {},
  });
  const window = {
    webContents: contents,
    getBounds: () => bounds,
    setBounds(next) { bounds = next; },
    isMaximized: () => maximized,
    maximize() { maximized = true; },
    unmaximize() { maximized = false; },
    isFullScreen: () => fullscreen,
    setFullScreen(active) { if (!active) void document.exitFullscreen(); },
    show() {},
    hide() {},
    focus() {},
  };
  const observations = [];
  await observeFullscreen(window, screen, (stage, report) => {
    assert.equal(stage, 'integration-check');
    observations.push(report);
  });
  return observations;
}

test('fullscreen probe waits for renderer state after native enter and exit', async () => {
  const checks = await runProbe();
  assert.deepEqual(checks.map(({ status }) => status), ['PASS', 'PASS', 'PASS']);
  for (const { metrics } of checks) {
    assert.equal(metrics.domEntered, 1);
    assert.equal(metrics.domExited, 1);
    assert.equal(metrics.displayBoundsMatched, 1);
    assert.equal(metrics.windowBoundsRestored, 1);
  }
});

test('fullscreen probe preserves failure for a renderer that never exits fullscreen', async () => {
  const checks = await runProbe({ delayExit: false });
  assert.deepEqual(checks.map(({ status }) => status), ['FAIL', 'FAIL', 'FAIL']);
  for (const { code, metrics } of checks) {
    assert.equal(code, 'FULLSCREEN_DOM_EXIT');
    assert.equal(metrics.domEntered, 1);
    assert.equal(metrics.nativeExited, 1);
    assert.equal(metrics.domExited, 0);
  }
});
