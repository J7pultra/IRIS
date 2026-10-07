import { contextBridge, ipcRenderer } from 'electron';

export const downloadAPI = {
  onDownloadPopupData: (callback: (data: any) => void) => {
    ipcRenderer.on('download-popup-data', (_event, data) => callback(data));
  },
  onDownloadProgress: (callback: (data: { percent: number; speed: number; status: string }) => void) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
  downloadMedia: (url: string, audioUrl?: string, title?: string, quality?: string, ext?: string, type?: string, formatId?: string, originalUrl?: string) => {
    return ipcRenderer.invoke('download-media-action', {
      url,
      audioUrl,
      title,
      quality,
      ext,
      type,
      formatId,
      originalUrl
    });
  },
  close: () => {
    ipcRenderer.send('hide-download-popup');
  },
  sendReady: () => {
    ipcRenderer.send('download-popup-ready');
  }
};

contextBridge.exposeInMainWorld('downloadAPI', downloadAPI);
contextBridge.exposeInMainWorld('shieldAPI', downloadAPI);
