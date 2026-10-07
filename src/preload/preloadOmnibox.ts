import { contextBridge, ipcRenderer } from 'electron';

export const omniboxAPI = {
  onRenderSuggestions: (callback: (data: { suggestions: any[]; selectedIndex: number }) => void) => {
    ipcRenderer.on('render-suggestions', (_event, data) => callback(data));
  },
  sendAction: (index: number) => {
    ipcRenderer.send('omnibox-action', index);
  },
  sendReady: () => {
    ipcRenderer.send('omnibox-ready');
  }
};

contextBridge.exposeInMainWorld('omniboxAPI', omniboxAPI);
