const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_FILE_BYTES = 8 * 1024 ** 3;
const MAX_RECORDS = 512;
const MAX_JOURNAL_BYTES = 8 * 1024 ** 2;
const MAX_PATH_LENGTH = 4096;
const PHASES = new Set([
  'PREPARING', 'DOWNLOADING', 'FINALIZING', 'COMPLETED',
  'PAUSED_NEEDS_TARGET', 'NEEDS_RECONCILE', 'FAILED', 'CANCELLED',
]);
const PRUNABLE = new Set(['COMPLETED', 'PAUSED_NEEDS_TARGET', 'FAILED', 'CANCELLED']);
const REASONS = new Set([
  'directory_changed', 'partial_unidentified', 'cleanup_failed', 'publication_unverified',
]);
const RETRYABLE_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);

function validTaskId(id) {
  return typeof id === 'string' && id.length <= 48 && /^dl_[0-9]+_[a-z0-9]{1,16}$/.test(id);
}

function validDestination(file) {
  if (typeof file !== 'string' || file.length > MAX_PATH_LENGTH || !/^[A-Za-z]:[\\/]/.test(file) ||
      /[<>:"|?*\u0000-\u001f]/.test(file.slice(2)) || path.normalize(file) !== file ||
      !['.mp4', '.ts'].includes(path.extname(file).toLowerCase())) return false;
  return !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(path.basename(file).split('.')[0].trimEnd());
}

function partialFor(record) {
  return path.join(path.dirname(record.destination), '.libretv-' + record.leaseId + '.partial');
}

function fileIdentity(stat) {
  return stat.isFile() && stat.ino !== 0n ? String(stat.dev) + ':' + String(stat.ino) : undefined;
}

async function statFile(file) {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function verifyFile(file, size, sha256, identity) {
  // Hash the opened file, with a bounded buffer and exact length. Compare the
  // handle to lstat so a changed staging name cannot be published as verified.
  const observed = await statFile(file);
  if (!observed?.isFile() || observed.size !== BigInt(size)) return false;
  const expectedIdentity = identity ?? fileIdentity(observed);
  const handle = await fs.open(file, 'r');
  try {
    const matches = (stat) => stat?.isFile() && stat.size === BigInt(size) &&
      (expectedIdentity === undefined || fileIdentity(stat) === expectedIdentity);
    if (!matches(await handle.stat({ bigint: true }))) return false;
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) return false;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return digest.digest('hex') === sha256 &&
      matches(await handle.stat({ bigint: true })) && matches(await statFile(file));
  } finally {
    await handle.close();
  }
}

async function directoryUnchanged(file) {
  const directory = path.dirname(file);
  try {
    return (await fs.realpath(directory)).toLowerCase() === directory.toLowerCase();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnedPartial(record, openedIdentity) {
  if (!(await directoryUnchanged(record.destination))) return 'directory_changed';
  const partial = partialFor(record);
  const observed = await statFile(partial);
  if (!observed) return undefined;
  const identity = openedIdentity ?? record.identity;
  if (!identity || identity !== fileIdentity(observed)) return 'partial_unidentified';
  await fs.unlink(partial);
  return undefined;
}

async function retainedStageBytes(record) {
  try {
    if (!(await directoryUnchanged(record.destination))) return 0;
    const stat = await statFile(partialFor(record));
    if (!stat?.isFile()) return 0;
    return stat.size >= BigInt(MAX_FILE_BYTES) ? MAX_FILE_BYTES : Number(stat.size);
  } catch {
    return record.size ?? MAX_FILE_BYTES;
  }
}

function isValidRecord(record) {
  if (!record || !validTaskId(record.taskId) || !validDestination(record.destination) ||
      typeof record.leaseId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.leaseId) ||
      !PHASES.has(record.phase) || (record.reason !== undefined && !REASONS.has(record.reason)) ||
      (record.identity !== undefined && (typeof record.identity !== 'string' || !/^\d{1,20}:\d{1,20}$/.test(record.identity)))) {
    return false;
  }
  if (record.phase === 'FINALIZING' || record.phase === 'COMPLETED') {
    return Number.isSafeInteger(record.size) && record.size > 0 && record.size <= MAX_FILE_BYTES &&
      typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256);
  }
  return record.size === undefined && record.sha256 === undefined;
}

async function diagnosePartial(record) {
  return removeOwnedPartial(record).catch(() => 'cleanup_failed');
}

async function recover(record) {
  if (record.phase === 'NEEDS_RECONCILE') return record;
  if (record.phase === 'COMPLETED') {
    const reason = await diagnosePartial(record);
    return { ...record, reason };
  }
  if (PRUNABLE.has(record.phase)) return record;

  const pause = (reason) => ({
    taskId: record.taskId, leaseId: record.leaseId, destination: record.destination, identity: record.identity,
    phase: reason ? 'NEEDS_RECONCILE' : 'PAUSED_NEEDS_TARGET', reason,
  });
  if (record.phase === 'FINALIZING') {
    try {
      if (!(await directoryUnchanged(record.destination))) return pause('directory_changed');
      const output = await statFile(record.destination);
      if (output) {
        if (record.identity && fileIdentity(output) === record.identity &&
            await verifyFile(record.destination, record.size, record.sha256, record.identity)) {
          const reason = await diagnosePartial(record);
          return { ...record, phase: 'COMPLETED', reason };
        }
        return pause('publication_unverified');
      }
    } catch {
      return pause('publication_unverified');
    }
  }
  return pause(await diagnosePartial(record));
}

async function openDownloadJournal(profilePath) {
  if (!path.isAbsolute(profilePath)) throw new Error('invalid download journal profile');
  const realProfile = await fs.realpath(profilePath);
  const directory = path.join(realProfile, 'DownloadJournal');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
    throw new Error('invalid download journal directory');
  }
  const filename = path.join(directory, 'manifest.json');
  const stat = await statFile(filename);
  const entries = new Map();
  if (stat) {
    if (!stat.isFile() || stat.size > BigInt(MAX_JOURNAL_BYTES)) throw new Error('invalid download journal');
    const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (manifest?.version !== 1 || !Array.isArray(manifest.tasks) || manifest.tasks.length > MAX_RECORDS) {
      throw new Error('invalid download journal');
    }
    for (const record of manifest.tasks) {
      if (!isValidRecord(record) || entries.has(record.taskId)) throw new Error('invalid download journal entry');
      entries.set(record.taskId, record);
    }
  }

  let update = Promise.resolve();
  async function commit(next) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, tasks: [...next.values()] }));
    if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('download journal size limit');
    const temp = path.join(directory, '.manifest-' + randomUUID() + '.pending');
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Replace only the application's own manifest. User output paths use a
      // separate, strictly no-replace publication protocol.
      const retryDelays = [20, 60, 120];
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temp, filename);
          break;
        } catch (error) {
          if (attempt >= retryDelays.length || !RETRYABLE_RENAME.has(error.code)) throw error;
          await delay(retryDelays[attempt]);
        }
      }
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  let changed = false;
  for (const record of entries.values()) {
    const recovered = await recover(record);
    if (record.phase !== recovered.phase || record.reason !== recovered.reason) changed = true;
    entries.set(record.taskId, recovered);
  }
  if (changed) await commit(entries);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^\.manifest-[a-f0-9-]{36}\.pending$/.test(entry.name)) {
      await fs.unlink(path.join(directory, entry.name)).catch(() => {});
    }
  }

  return {
    get(taskId) { return entries.get(taskId); },
    records() { return [...entries.values()]; },
    remember(record) {
      if (!isValidRecord(record)) throw new Error('invalid download journal entry');
      const saved = update.then(async () => {
        const next = new Map(entries);
        next.delete(record.taskId);
        next.set(record.taskId, record);
        if (next.size > MAX_RECORDS) {
          const prunable = [...next.values()].find((item) =>
            item.taskId !== record.taskId && PRUNABLE.has(item.phase) && !item.reason);
          if (!prunable) throw new Error('download journal recovery backlog');
          next.delete(prunable.taskId);
        }
        await commit(next);
        entries.clear();
        for (const [id, item] of next) entries.set(id, item);
      });
      update = saved.catch(() => {});
      return saved;
    },
  };
}

module.exports = {
  MAX_FILE_BYTES, validTaskId, validDestination, partialFor, fileIdentity, statFile, verifyFile,
  directoryUnchanged, removeOwnedPartial, retainedStageBytes, openDownloadJournal,
};
