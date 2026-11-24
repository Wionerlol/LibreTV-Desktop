/**
 * 下载文件的保存目标：
 * - Chromium（Edge/Chrome）：showSaveFilePicker 边下边写盘（FS Access API），
 *   必须在**用户手势内**调用（点击处理器的同步栈中）；
 * - 其余环境：在 500 MiB 上限内聚合为 Blob 后触发浏览器下载。
 *
 * 有意不做 StreamSaver（mitm.html + SW 中转）：云平台域名下 SW 注册受限，
 * 复杂度高、收益边际——大文件场景建议直接使用 FS Access 浏览器。
 */

import { desktopSaveTarget, getDesktopDownloadBridge } from './desktop-download-target';

export interface SaveTarget {
  kind: 'fs' | 'memory' | 'native';
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

const MAX_MEMORY_SAVE_BYTES = 500 * 1024 * 1024;

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' &&
    typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

export function detectSavingCapability(): 'fs-access' | 'memory' | 'native' {
  if (getDesktopDownloadBridge()) return 'native';
  return supportsFileSystemAccess() ? 'fs-access' : 'memory';
}

export class UserCancelledError extends Error {
  constructor() {
    super('用户取消了保存');
  }
}

function memoryTarget(filename: string): SaveTarget {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  const flush = () => {
    if (done) return;
    done = true;
    const blob = new Blob(chunks.map((c) => c.buffer as ArrayBuffer));
    chunks.length = 0;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return {
    kind: 'memory',
    async write(data) {
      if (done) return;
      if (data.byteLength > MAX_MEMORY_SAVE_BYTES - bytes) {
        throw new Error('下载超过 500 MiB 内存保存上限，请使用支持磁盘直写的浏览器');
      }
      bytes += data.byteLength;
      // 只保存视图范围内的字节，避免写出或持有整个底层缓冲区。
      chunks.push(data.slice());
    },
    async close() {
      flush();
    },
    async abort() {
      done = true;
      chunks.length = 0;
    },
  };
}

/**
 * 选择保存目标并打开写入流。showSaveFilePicker 必须在用户手势内调用，
 * 因此本函数应在点击处理器里被 await（调用方负责）。
 * 用户取消文件选择器时抛出 UserCancelledError。
 */
export async function pickSaveTarget(
  filename: string,
  { taskId, estimatedBytes }: { taskId?: string; estimatedBytes?: number } = {},
): Promise<SaveTarget> {
  const desktop = getDesktopDownloadBridge();
  if (desktop) {
    if (!taskId) throw new Error('桌面下载缺少任务编号');
    const lease = await desktop.pick(taskId, filename);
    if (!lease) throw new UserCancelledError();
    return desktopSaveTarget(desktop, lease.leaseId);
  }
  if (supportsFileSystemAccess()) {
    try {
      const picker = (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
          }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
        }
      ).showSaveFilePicker;
      const handle = await picker.call(window, { suggestedName: filename });
      const writable = await handle.createWritable();
      const writer = writable.getWriter();
      return {
        kind: 'fs',
        async write(data) {
          await writer.write(data);
        },
        async close() {
          await writer.close();
        },
        async abort() {
          try {
            await writer.abort();
          } catch { /* 已关闭则忽略 */ }
        },
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UserCancelledError();
      }
      throw err;
    }
  }
  if (estimatedBytes && estimatedBytes > MAX_MEMORY_SAVE_BYTES) {
    throw new Error('下载超过 500 MiB 内存保存上限，请使用支持磁盘直写的浏览器');
  }
  return memoryTarget(filename);
}
