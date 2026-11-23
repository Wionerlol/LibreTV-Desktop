const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  MAX_FILE_BYTES, validTaskId, validDestination, partialFor, fileIdentity, statFile,
  verifyFile, directoryUnchanged, removeOwnedPartial, retainedStageBytes, openDownloadJournal,
} = require('./download-journal.cjs');

const MAX_LEASES = 8;
const MAX_WRITING_LEASES = 3;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_PARTIAL_BYTES = 24 * 1024 ** 3;
const DISK_RESERVE_BYTES = 64n * 1024n ** 2n;
const CHANNELS = ['pick', 'write', 'finish', 'abort', 'reconcile'].map((name) => 'libretv:download:' + name);
const LINK_UNAVAILABLE = new Set(['EPERM', 'EACCES', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);
const RECOVERY_STATUS = new Map([
  ['COMPLETED', 'completed'],
  ['PAUSED_NEEDS_TARGET', 'paused_needs_target'],
  ['NEEDS_RECONCILE', 'needs_reconcile'],
  ['FINALIZING', 'needs_reconcile'],
]);
const execute = promisify(execFile);
const MOVE_COMMAND = [
  '$ErrorActionPreference = "Stop"',
  'try { [IO.File]::Move($env:LIBRETV_STAGED_FILE, $env:LIBRETV_DESTINATION_FILE) }',
  'catch {',
  '  $cause = $_.Exception.GetBaseException()',
  '  if ($cause.HResult -in @(-2147024713, -2147024816)) { exit 10 }',
  '  exit 11',
  '}',
].join('\n');

async function publishNoReplace(staged, destination) {
  if (path.dirname(staged) !== path.dirname(destination)) throw new Error('publication requires a sibling destination');
  try {
    // A same-volume link claims the destination without replacing any entry.
    await fs.link(staged, destination);
    return;
  } catch (error) {
    if (process.platform !== 'win32' || !LINK_UNAVAILABLE.has(error.code)) throw error;
  }
  const windows = process.env.SystemRoot;
  if (!/^[A-Za-z]:\\/.test(windows ?? '')) throw new Error('cannot locate Windows file move helper');
  const helper = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // The fixed command receives only two sibling paths as data. Windows
    // .NET File.Move uses an OS no-overwrite move for paths on the same volume.
    await execute(helper, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', MOVE_COMMAND], {
      env: { SystemRoot: windows, LIBRETV_STAGED_FILE: staged, LIBRETV_DESTINATION_FILE: destination },
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4096,
    });
  } catch (error) {
    const code = error.code === 10 ? 'EEXIST' : 'ERR_NATIVE_MOVE';
    throw Object.assign(new Error('Windows could not publish the staged file'), { code });
  }
}

function outputName(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('保存文件名无效');
  const ext = path.extname(value).toLowerCase();
  if (ext !== '.mp4' && ext !== '.ts') throw new Error('仅支持 MP4 和 TS');
  const stem = value.slice(0, -ext.length).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return { name: (stem.slice(0, 120) || 'LibreTV') + ext, ext };
}

function errorSuffix(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? ' (' + error.code + ')' : '';
}

function registerDesktopDownloads({ ipcMain, dialog, getWindow, origin, profilePath }) {
  const leases = new Map();
  const writing = new Set();
  const owners = new Map();
  let closing = false;
  let pickerOpen = false;
  let reservedBytes = 0;
  let retainedBytes = 0;
  const journalReady = openDownloadJournal(profilePath).then(async (journal) => {
    for (const item of journal.records()) {
      if (item.reason) retainedBytes += await retainedStageBytes(item);
    }
    return journal;
  });
  void journalReady.catch(() => {});

  async function releaseWhenIdle(lease) {
    await lease.pending?.catch(() => {});
    if (leases.has(lease.id)) await cleanup(lease, lease.failed ? 'FAILED' : 'PAUSED_NEEDS_TARGET');
  }

  function observeOwner(contents) {
    const observed = owners.get(contents);
    if (observed) return observed;

    const owner = { generation: 0 };
    const revoke = () => {
      owner.generation++;
      for (const lease of leases.values()) {
        if (lease.owner !== owner) continue;
        lease.revoked = true;
        void releaseWhenIdle(lease).catch(() => {});
      }
    };
    const navigate = (event) => {
      if (event.isMainFrame && !event.isInPlace) revoke();
    };
    const destroyed = () => {
      revoke();
      owner.detach();
      owners.delete(contents);
    };
    owner.detach = () => {
      contents.removeListener('did-start-navigation', navigate);
      contents.removeListener('destroyed', destroyed);
    };
    contents.on('did-start-navigation', navigate);
    contents.once('destroyed', destroyed);
    owners.set(contents, owner);
    return owner;
  }

  function trustedFrame(event) {
    const window = getWindow();
    if (closing || !window || window.isDestroyed() || event.sender !== window.webContents ||
        !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('下载请求来源无效');
    }
    if (!URL.canParse(event.senderFrame.url)) throw new Error('下载请求来源无效');
    const url = new URL(event.senderFrame.url);
    if (url.protocol !== 'http:' || url.origin !== origin || url.username || url.password) {
      throw new Error('下载请求来源无效');
    }
    return { window, frame: event.senderFrame, owner: observeOwner(window.webContents) };
  }

  async function remember(lease, phase, fields = {}) {
    const record = { ...lease.record, phase, ...fields };
    await (await journalReady).remember(record);
    lease.record = record;
  }

  function cleanup(lease, phase) {
    if (lease.cleaning) return lease.cleaning;
    lease.cleaning = (async () => {
      if (lease.file) {
        await lease.file.close();
        lease.file = undefined;
      }
      // A move can succeed before its child-process response or journal commit
      // arrives. Keep both the evidence and owned staging for restart recovery.
      if (lease.uncertain) return;
      const reason = lease.staged
        ? await removeOwnedPartial(lease.record, lease.stagingIdentity).catch(() => 'cleanup_failed')
        : undefined;
      if (lease.finalized) {
        if (reason) await remember(lease, 'COMPLETED', { reason });
        return;
      }
      await remember(lease, reason ? 'NEEDS_RECONCILE' : phase, { reason, size: undefined, sha256: undefined });
      if (reason) throw new Error('staging requires reconciliation');
    })().finally(async () => {
      if (lease.staged) retainedBytes += await retainedStageBytes(lease.record);
      reservedBytes -= lease.reserved;
      writing.delete(lease.id);
      leases.delete(lease.id);
    });
    return lease.cleaning;
  }

  async function perform(event, id, action, allowFailed = false) {
    const { frame, owner } = trustedFrame(event);
    const lease = typeof id === 'string' && id.length === 36 ? leases.get(id) : undefined;
    if (!lease || lease.frame !== frame || lease.owner !== owner || lease.revoked || lease.pending ||
        (!allowFailed && (lease.failed || lease.finalized))) {
      throw new Error('下载文件句柄无效或正在使用');
    }
    const operation = Promise.resolve().then(() => action(lease));
    lease.pending = operation;
    try {
      return await operation;
    } finally {
      lease.pending = undefined;
    }
  }

  ipcMain.handle(CHANNELS[0], async (event, taskId, suggestedName) => {
    const { window, frame, owner } = trustedFrame(event);
    const generation = owner.generation;
    const assertCurrentDocument = () => {
      const current = trustedFrame(event);
      if (current.frame !== frame || current.owner !== owner || owner.generation !== generation) {
        throw new Error('窗口已经变更');
      }
    };
    if (!validTaskId(taskId)) throw new Error('下载任务编号无效');
    const { name, ext } = outputName(suggestedName);
    if (pickerOpen || leases.size >= MAX_LEASES || [...leases.values()].some((item) => item.taskId === taskId)) {
      throw new Error('请先结束当前的保存选择或已打开的下载任务');
    }

    pickerOpen = true;
    try {
      const journal = await journalReady.catch(() => { throw new Error('下载任务清单不可用，请检查应用数据目录'); });
      const previous = journal.get(taskId);
      if (previous?.phase === 'COMPLETED') throw new Error('此下载任务已完成');
      if (previous?.phase === 'FINALIZING' || previous?.phase === 'NEEDS_RECONCILE') {
        throw new Error('此任务的上一次保存需要核对，请保留现有文件并新建下载任务');
      }
      assertCurrentDocument();
      const result = await dialog.showSaveDialog(window, {
        title: '选择下载保存位置',
        defaultPath: name,
        filters: [{ name: ext === '.mp4' ? 'MP4' : 'TS', extensions: [ext.slice(1)] }],
      });
      if (result.canceled) return null;
      assertCurrentDocument();
      const selected = result.filePath;
      if (!validDestination(selected) || path.extname(selected).toLowerCase() !== ext) {
        throw new Error('请选择本地磁盘上的目标文件');
      }
      let directory;
      let destination;
      try {
        directory = await fs.realpath(path.dirname(selected));
        destination = path.join(directory, path.basename(selected));
        if (!validDestination(destination) || await statFile(destination)) throw new Error('path exists');
      } catch {
        throw new Error('请选择可访问且尚不存在的目标文件');
      }
      assertCurrentDocument();
      if ([...leases.values()].some((item) => item.destination.toLowerCase() === destination.toLowerCase())) {
        throw new Error('此文件已被另一个下载任务选择');
      }
      const id = randomUUID();
      const lease = {
        id, taskId, frame, owner, directory, destination,
        record: { taskId, leaseId: id, destination },
        reserved: 0, size: 0, hash: createHash('sha256'), failed: false, finalized: false,
      };
      try {
        await remember(lease, 'PREPARING');
        assertCurrentDocument();
      } catch (error) {
        throw new Error('无法建立下载任务，请检查应用数据目录或重试' + errorSuffix(error));
      }
      leases.set(id, lease);
      return { leaseId: id };
    } finally {
      pickerOpen = false;
    }
  });

  ipcMain.handle(CHANNELS[1], (event, id, data) => perform(event, id, async (lease) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > MAX_WRITE_BYTES) {
      throw new Error('下载写入大小无效');
    }
    if (lease.size + data.byteLength > MAX_FILE_BYTES ||
        reservedBytes + retainedBytes + data.byteLength > MAX_PARTIAL_BYTES) {
      throw new Error('下载阶段的磁盘配额已用尽');
    }
    if (!writing.has(lease.id) && writing.size >= MAX_WRITING_LEASES) {
      throw new Error('下载任务正在排队');
    }
    writing.add(lease.id);
    reservedBytes += data.byteLength;
    lease.reserved += data.byteLength;
    try {
      const space = await fs.statfs(lease.directory, { bigint: true });
      if (space.bavail * space.bsize < DISK_RESERVE_BYTES + BigInt(data.byteLength)) {
        throw new Error('disk reserve');
      }
      if (!lease.file) {
        if (!(await directoryUnchanged(lease.destination))) throw new Error('destination directory changed');
        lease.file = await fs.open(partialFor(lease.record), 'wx');
        lease.staged = true;
        lease.stagingIdentity = fileIdentity(await lease.file.stat({ bigint: true }));
        await remember(lease, 'DOWNLOADING', { identity: lease.stagingIdentity });
      }
      const bytes = Buffer.from(data);
      for (let offset = 0; offset < bytes.byteLength;) {
        const { bytesWritten } = await lease.file.write(bytes, offset, bytes.byteLength - offset);
        if (!bytesWritten) throw new Error('empty write');
        offset += bytesWritten;
      }
      lease.hash.update(bytes);
      lease.size += bytes.byteLength;
    } catch {
      lease.failed = true;
      throw new Error('下载磁盘写入失败，请检查空间和目录权限');
    }
  }));

  ipcMain.handle(CHANNELS[2], (event, id) => perform(event, id, async (lease) => {
    if (!lease.file || !lease.size) throw new Error('没有可保存的下载内容');
    try {
      await lease.file.sync();
      await lease.file.close();
      lease.file = undefined;
      const staged = partialFor(lease.record);
      const sha256 = lease.hash.digest('hex');
      if (!(await directoryUnchanged(lease.destination)) ||
          !(await verifyFile(staged, lease.size, sha256, lease.stagingIdentity))) {
        throw new Error('staged file differs');
      }
      await remember(lease, 'FINALIZING', { size: lease.size, sha256 });
      lease.uncertain = true;
      await publishNoReplace(staged, lease.destination);
      const published = await statFile(lease.destination);
      if (!published?.isFile() || published.size !== BigInt(lease.size) ||
          ((!lease.stagingIdentity || fileIdentity(published) !== lease.stagingIdentity) &&
           !(await verifyFile(lease.destination, lease.size, sha256)))) {
        throw new Error('published file differs');
      }
      await remember(lease, 'COMPLETED');
      lease.uncertain = false;
      lease.finalized = true;
    } catch (error) {
      if (error.code === 'EEXIST') lease.uncertain = false;
      lease.failed = true;
      throw new Error('无法完成文件校验或落盘，请检查磁盘类型、权限和重名文件' + errorSuffix(error));
    }
    await cleanup(lease, 'COMPLETED').catch(() => {});
  }));

  ipcMain.handle(CHANNELS[3], (event, id) => perform(event, id, async (lease) => {
    try {
      await cleanup(lease, lease.failed ? 'FAILED' : 'CANCELLED');
    } catch {
      throw new Error('无法清理下载的暂存文件');
    }
  }, true));

  ipcMain.handle(CHANNELS[4], async (event) => {
    const { owner } = trustedFrame(event);
    const generation = owner.generation;
    const journal = await journalReady.catch(() => { throw new Error('下载任务清单不可用，请检查应用数据目录'); });
    trustedFrame(event);
    if (owner.generation !== generation) throw new Error('窗口已经变更');
    const currentTasks = new Set([...leases.values()].map((lease) => lease.taskId));
    return journal.records().filter((item) => !currentTasks.has(item.taskId) && RECOVERY_STATUS.has(item.phase))
      .map((item) => ({ taskId: item.taskId, status: RECOVERY_STATUS.get(item.phase) }));
  });

  return async function closeDesktopDownloads() {
    if (closing) return;
    closing = true;
    for (const owner of owners.values()) owner.detach();
    owners.clear();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
    await Promise.allSettled([...leases.values()].map(releaseWhenIdle));
    await journalReady.catch(() => {});
  };
}

module.exports = { registerDesktopDownloads };
