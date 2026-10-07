import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('menuApi', {
  onRender: (callback: (payload: any) => void) => {
    ipcRenderer.on('render-menu-popup', (event, payload) => callback(payload));
  },
  sendAction: (action: string, payload?: any) => {
    ipcRenderer.send('menu-popup-action', action, payload);
  },
  close: () => {
    ipcRenderer.send('hide-menu-popup');
  },
  onVpnStatusUpdated: (callback: (state: any) => void) => {
    ipcRenderer.on('vpn-status-updated', (event, state) => callback(state));
  }
});
