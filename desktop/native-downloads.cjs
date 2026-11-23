const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

const MAX_LEASES = 8;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 ** 3;
const MAX_PARTIAL_BYTES = 24 * 1024 ** 3;
const DISK_RESERVE_BYTES = 64n * 1024n ** 2n;
const CHANNELS = ['pick', 'write', 'finish', 'abort'].map((name) => 'libretv:download:' + name);

async function isAbsent(file) {
  try {
    await fs.lstat(file);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function outputName(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('保存文件名无效');
  const ext = path.extname(value).toLowerCase();
  if (ext !== '.mp4' && ext !== '.ts') throw new Error('仅支持 MP4 和 TS');
  const stem = value.slice(0, -ext.length).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return { name: (stem.slice(0, 120) || 'LibreTV') + ext, ext };
}

function registerDesktopDownloads({ ipcMain, dialog, getWindow, origin }) {
  const leases = new Map();
  const owners = new Map();
  let closing = false;
  let pickerOpen = false;
  let reservedBytes = 0;

  async function releaseWhenIdle(lease) {
    await lease.pending?.catch(() => {});
    if (leases.has(lease.id)) await cleanup(lease);
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

  function cleanup(lease) {
    if (lease.cleaning) return lease.cleaning;
    lease.cleaning = (async () => {
      if (lease.file) {
        await lease.file.close();
        lease.file = undefined;
      }
      if (lease.partial) {
        try {
          await fs.unlink(lease.partial);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        lease.partial = undefined;
      }
      reservedBytes -= lease.reserved;
      leases.delete(lease.id);
    })().catch((error) => {
      lease.cleaning = undefined;
      throw error;
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
    if (typeof taskId !== 'string' || !/^dl_[0-9]+_[a-z0-9]{1,16}$/.test(taskId) || taskId.length > 48) {
      throw new Error('下载任务编号无效');
    }
    const { name, ext } = outputName(suggestedName);
    if (pickerOpen || leases.size >= MAX_LEASES || [...leases.values()].some((item) => item.taskId === taskId)) {
      throw new Error('请先结束当前的保存选择或已打开的下载任务');
    }

    pickerOpen = true;
    try {
      const result = await dialog.showSaveDialog(window, {
        title: '选择下载保存位置',
        defaultPath: name,
        filters: [{ name: ext === '.mp4' ? 'MP4' : 'TS', extensions: [ext.slice(1)] }],
      });
      if (result.canceled) return null;
      assertCurrentDocument();
      const selected = result.filePath;
      if (typeof selected !== 'string' || !/^[A-Za-z]:[\\/]/.test(selected) ||
          path.extname(selected).toLowerCase() !== ext || path.basename(selected).includes(':')) {
        throw new Error('请选择本地磁盘上的目标文件');
      }
      let directory;
      let destination;
      try {
        directory = await fs.realpath(path.dirname(selected));
        if (!/^[A-Za-z]:[\\/]/.test(directory)) throw new Error('non-local volume');
        destination = path.join(directory, path.basename(selected));
        if (!(await isAbsent(destination))) throw new Error('path exists');
      } catch {
        throw new Error('请选择可访问且尚不存在的目标文件');
      }
      assertCurrentDocument();
      if ([...leases.values()].some((item) => item.destination.toLowerCase() === destination.toLowerCase())) {
        throw new Error('此文件已被另一个下载任务选择');
      }
      const id = randomUUID();
      leases.set(id, {
        id, taskId, frame, owner, directory, destination,
        reserved: 0, size: 0, hash: createHash('sha256'), failed: false, finalized: false,
      });
      return { leaseId: id };
    } finally {
      pickerOpen = false;
    }
  });

  ipcMain.handle(CHANNELS[1], (event, id, data) => perform(event, id, async (lease) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > MAX_WRITE_BYTES) {
      throw new Error('下载写入大小无效');
    }
    if (lease.size + data.byteLength > MAX_FILE_BYTES || reservedBytes + data.byteLength > MAX_PARTIAL_BYTES) {
      throw new Error('下载阶段的磁盘配额已用尽');
    }
    reservedBytes += data.byteLength;
    lease.reserved += data.byteLength;
    try {
      const space = await fs.statfs(lease.directory, { bigint: true });
      if (space.bavail * space.bsize < DISK_RESERVE_BYTES + BigInt(data.byteLength)) {
        throw new Error('disk reserve');
      }
      if (!lease.file) {
        const partial = path.join(lease.directory, '.libretv-' + lease.id + '.partial');
        lease.file = await fs.open(partial, 'wx');
        lease.partial = partial;
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
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of createReadStream(lease.partial)) {
        size += chunk.length;
        hash.update(chunk);
      }
      if (lease.size !== size || lease.hash.digest('hex') !== hash.digest('hex')) {
        throw new Error('staged file differs');
      }
      // Windows rename may replace an existing path. A same-volume link
      // atomically claims the destination and fails if another file exists.
      await fs.link(lease.partial, lease.destination);
      lease.finalized = true;
    } catch (error) {
      lease.failed = true;
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
        ? ' (' + error.code + ')' : '';
      throw new Error('无法完成文件校验或落盘，请检查磁盘类型、权限和重名文件' + code);
    }
    // A successful link is the completed output. Keep failed staging cleanup
    // in the lease registry for another attempt during controlled exit.
    await cleanup(lease).catch(() => {});
  }));

  ipcMain.handle(CHANNELS[3], (event, id) => perform(event, id, async (lease) => {
    try {
      await cleanup(lease);
    } catch {
      throw new Error('无法清理下载的暂存文件');
    }
  }, true));

  return async function closeDesktopDownloads() {
    if (closing) return;
    closing = true;
    for (const owner of owners.values()) owner.detach();
    owners.clear();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
    await Promise.allSettled([...leases.values()].map(releaseWhenIdle));
  };
}

module.exports = { registerDesktopDownloads };
