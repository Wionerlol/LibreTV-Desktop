// Runs only in an isolated, explicitly requested packaged smoke profile.
async function rendererChecks() {
  const observe = async (name, callback) => {
    try {
      return { name, ...await callback() };
    } catch (error) {
      return { name, passed: false, error: error.name };
    }
  };

  return Promise.all([
    observe('rsc', async () => {
      const response = await fetch('/live', {
        headers: { RSC: '1' }, signal: AbortSignal.timeout(6000),
      });
      const type = response.headers.get('content-type') || '';
      const size = (await response.arrayBuffer()).byteLength;
      return { status: response.status, passed: response.ok && type.startsWith('text/x-component') && size > 0 };
    }),
    observe('bundled-range', async () => {
      const response = await fetch('/favicon.ico', {
        headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(6000),
      });
      const contentRange = response.headers.get('content-range') || '';
      const size = (await response.arrayBuffer()).byteLength;
      return { status: response.status, passed: response.status === 206 && /^bytes 0-15\/\d+$/.test(contentRange) && size === 16 };
    }),
    observe('blob-worker', async () => {
      const script = new Blob([
        "self.onmessage = async ({ data }) => {" +
        "  try {" +
        "    const response = await fetch(data, { signal: AbortSignal.timeout(4000) });" +
        "    const state = await response.json();" +
        "    self.postMessage({ status: response.status, passed: response.ok && state.verified === true });" +
        "  } catch { self.postMessage({ passed: false }); }" +
        "};"
      ], { type: 'text/javascript' });
      const url = URL.createObjectURL(script);
      let worker;
      let timer;
      try {
        worker = new Worker(url);
        return await new Promise((resolve) => {
          timer = setTimeout(() => resolve({ passed: false, error: 'timeout' }), 5500);
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = () => resolve({ passed: false, error: 'worker' });
          worker.postMessage(new URL('/api/status', location.origin).href);
        });
      } finally {
        clearTimeout(timer);
        worker?.terminate();
        URL.revokeObjectURL(url);
      }
    }),
    observe('persistent-profile', () => {
      const key = 'libretv-desktop:smoke-only';
      const existing = localStorage.getItem(key) === '1';
      localStorage.setItem(key, '1');
      return { passed: localStorage.getItem(key) === '1', existing };
    }),
  ]);
}

async function observeRenderer(contents, log) {
  try {
    const checks = await contents.executeJavaScript('(' + rendererChecks.toString() + ')()');
    log('renderer-acceptance', { checks });
  } catch (error) {
    log('renderer-acceptance', { checks: [], error: error.name });
  }
}

module.exports = { observeRenderer };
