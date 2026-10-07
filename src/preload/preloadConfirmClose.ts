import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('confirmCloseApi', {
  onInit: (callback: (data: { tabCount: number; theme?: string }) => void) => {
    ipcRenderer.once('init-confirm-close', (_event, data) => callback(data));
  },
  respond: (result: { confirmed: boolean; dontAskAgain: boolean }) => {
    ipcRenderer.send('confirm-close-response', result);
  }
});
