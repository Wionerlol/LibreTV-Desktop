const { lstat } = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

async function waitForSmokeClose(profile, timeout = 120_000) {
  const signal = path.join(profile, `smoke-close-${process.pid}.signal`);
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    let marker;
    try {
      marker = await lstat(signal);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw Object.assign(new Error('Smoke close signal is inaccessible', { cause: error }), { code: 'SMOKE_CONTROL' });
      }
    }
    if (marker) {
      if (marker.isFile() && marker.size === 0) return;
      throw Object.assign(new Error('Invalid smoke close signal'), { code: 'SMOKE_CONTROL' });
    }
    await delay(100);
  }
  throw Object.assign(new Error('Smoke controller did not request close in time'), { code: 'SMOKE_CONTROL_TIMEOUT' });
}

module.exports = { waitForSmokeClose };
