const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('libretvDownloads', {
  pick: (taskId, name) => ipcRenderer.invoke('libretv:download:pick', taskId, name),
  write: (leaseId, data) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > 1024 * 1024) {
      return Promise.reject(new Error('下载写入大小无效'));
    }
    return ipcRenderer.invoke('libretv:download:write', leaseId, data);
  },
  finish: (leaseId) => ipcRenderer.invoke('libretv:download:finish', leaseId),
  abort: (leaseId) => ipcRenderer.invoke('libretv:download:abort', leaseId),
  reconcile: () => ipcRenderer.invoke('libretv:download:reconcile'),
});
