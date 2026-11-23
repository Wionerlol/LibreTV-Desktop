import type { SaveTarget } from './download-saver';

interface DesktopDownloadBridge {
  pick(taskId: string, name: string): Promise<{ leaseId: string } | null>;
  write(leaseId: string, data: ArrayBuffer): Promise<void>;
  finish(leaseId: string): Promise<void>;
  abort(leaseId: string): Promise<void>;
}

export function getDesktopDownloadBridge(): DesktopDownloadBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { libretvDownloads?: DesktopDownloadBridge }).libretvDownloads;
}

export function desktopSaveTarget(bridge: DesktopDownloadBridge, leaseId: string): SaveTarget {
  const writeBytes = 1024 * 1024;
  let finished = false;
  return {
    kind: 'native',
    async write(data) {
      for (let offset = 0; offset < data.byteLength; offset += writeBytes) {
        const chunk = new Uint8Array(data.subarray(offset, offset + writeBytes));
        await bridge.write(leaseId, chunk.buffer);
      }
    },
    async close() {
      await bridge.finish(leaseId);
      finished = true;
    },
    async abort() {
      if (!finished) await bridge.abort(leaseId);
    },
  };
}
