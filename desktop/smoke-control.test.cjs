const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rmdir, unlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { waitForSmokeClose } = require('./smoke-control.cjs');

async function profileFixture(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'libretv-smoke-control-'));
  t.after(() => rmdir(profile));
  return profile;
}

test('waits for the current process marker, ignoring another process marker', async (t) => {
  const profile = await profileFixture(t);
  const otherMarker = path.join(profile, `smoke-close-${process.pid + 1}.signal`);
  const marker = path.join(profile, `smoke-close-${process.pid}.signal`);
  await writeFile(otherMarker, '', { flag: 'wx' });
  try {
    const close = waitForSmokeClose(profile, 2_000);
    const premature = await Promise.race([close.then(() => true), delay(150, false)]);
    assert.equal(premature, false);
    await writeFile(marker, '', { flag: 'wx' });
    try {
      await close;
    } finally {
      await unlink(marker);
    }
  } finally {
    await unlink(otherMarker);
  }
});

test('rejects a directory used as the process marker', async (t) => {
  const profile = await profileFixture(t);
  const marker = path.join(profile, `smoke-close-${process.pid}.signal`);
  await mkdir(marker);
  try {
    await assert.rejects(waitForSmokeClose(profile, 1_000), { code: 'SMOKE_CONTROL' });
  } finally {
    await rmdir(marker);
  }
});

test('a missing marker times out as a test failure', async (t) => {
  const profile = await profileFixture(t);
  await assert.rejects(waitForSmokeClose(profile, 20), { code: 'SMOKE_CONTROL_TIMEOUT' });
});
