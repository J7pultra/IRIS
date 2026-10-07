import { contextBridge, ipcRenderer } from 'electron';
import { cinemaPeerInstance } from './cinemaPeer';

export const betaAPI = {
  window: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    toggleFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),
    close: () => ipcRenderer.invoke('window-close'),
    openNewWindow: (mode: 'normal' | 'incognito' | 'tor', url?: string) =>
      ipcRenderer.invoke('window-open-new', mode, url),
    getWindowMode: (): 'normal' | 'incognito' | 'tor' => {
      try {
        const mode = ipcRenderer.sendSync('window-get-mode-sync');
        if (mode && (mode === 'normal' || mode === 'incognito' || mode === 'tor')) {
          return mode;
        }
      } catch {}
      const params = new URLSearchParams(window.location.search);
      return (params.get('mode') as any) || 'normal';
    },
    getInitialUrl: (): string | null => {
      try {
        const url = ipcRenderer.sendSync('window-get-initial-url-sync');
        if (url) return url;
      } catch {}
      const params = new URLSearchParams(window.location.search);
      return params.get('url') || null;
    }
  },
  tor: {
    getStatus: (forceCheck?: boolean) => ipcRenderer.invoke('get-tor-status', forceCheck),
    retryConnection: () => ipcRenderer.invoke('retry-tor-connection'),
    startService: () => ipcRenderer.invoke('start-tor-service')
  },
  tabs: {
    create: (id: string, url: string, options?: any) => ipcRenderer.invoke('view-create', id, url, options),
    switch: (id: string) => ipcRenderer.invoke('view-switch', id),
    close: (id: string) => ipcRenderer.invoke('view-close', id),
    navigate: (id: string, url: string) => ipcRenderer.invoke('view-navigate', id, url),
    updateBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('view-update-bounds', bounds),
    setVisible: (id: string, visible: boolean) => ipcRenderer.invoke('set-view-visible', id, visible),
    goBack: (id: string) => ipcRenderer.invoke('view-go-back', id),
    goForward: (id: string) => ipcRenderer.invoke('view-go-forward', id),
    reload: (id: string, ignoreCache: boolean = false) => ipcRenderer.invoke('view-reload', id, ignoreCache),
    stop: (id: string) => ipcRenderer.invoke('view-stop', id),
    getNavState: (id: string) => ipcRenderer.invoke('view-get-nav-state', id),
    getHistoryEntries: (id: string) => ipcRenderer.invoke('view-get-history-entries', id),
    goToOffset: (id: string, offset: number) => ipcRenderer.invoke('view-go-to-offset', id, offset),
    executeJs: (id: string, code: string) => ipcRenderer.invoke('view-execute-js', id, code),
    setZoom: (id: string, factor: number) => ipcRenderer.invoke('view-set-zoom', id, factor),
    getZoom: (id: string) => ipcRenderer.invoke('view-get-zoom', id),
    print: (id: string) => ipcRenderer.invoke('view-print', id),
    toggleDevTools: (id: string) => ipcRenderer.invoke('view-toggle-devtools', id),
    clipboardAction: (id: string, action: string) => ipcRenderer.invoke('view-clipboard-action', id, action),
    findInPage: (id: string, text: string, options?: any) => ipcRenderer.invoke('view-find-in-page', id, text, options),
    stopFindInPage: (id: string, action?: string) => ipcRenderer.invoke('view-stop-find-in-page', id, action),
    getMemory: (id: string) => ipcRenderer.invoke('get-tab-memory', id),
    focusActiveView: () => ipcRenderer.invoke('focus-active-view'),
    setMenuState: (isOpen: boolean) => ipcRenderer.invoke('menu-state-changed', isOpen),
    showHoverCard: (data: { x: number; y: number; title: string; domain: string; ram: number; isHibernated?: boolean }) =>
      ipcRenderer.send('show-hover-card', data),
    hideHoverCard: () => ipcRenderer.send('hide-hover-card')
  },
  adblock: {
    getStats: () => ipcRenderer.invoke('get-block-stats'),
    toggle: (domain: string) => ipcRenderer.invoke('toggle-adblock', domain),
    getStatus: (domain: string) => ipcRenderer.invoke('get-adblock-status', domain),
    getUpdateInfo: () => ipcRenderer.invoke('get-adblock-update-info'),
    checkForUpdates: () => ipcRenderer.invoke('check-adblock-updates')
  },
  history: {
    get: () => ipcRenderer.invoke('get-history'),
    clear: (threshold: number = 0) => ipcRenderer.invoke('clear-history', threshold)
  },
  bookmarks: {
    get: () => ipcRenderer.invoke('get-bookmarks'),
    toggle: (url: string, title: string) => ipcRenderer.invoke('toggle-bookmark', url, title)
  },
  downloads: {
    get: () => ipcRenderer.invoke('get-downloads'),
    startMedia: (payload: { url: string; audioUrl?: string; format: string; quality: string; title: string }) =>
      ipcRenderer.invoke('start-media-download', payload),
    openFile: (filePath: string) => ipcRenderer.invoke('open-file', filePath),
    showInFolder: (filePath: string) => ipcRenderer.invoke('show-in-folder', filePath),
    toggleMenu: (payload: { bounds: any; activeTabId?: string; activeUrl?: string }) =>
      ipcRenderer.send('toggle-download-popup', payload),
    hideMenu: () => ipcRenderer.send('hide-download-popup'),
    onProgress: (callback: (data: { percent: number; speed: number; status: string }) => void) => {
      ipcRenderer.on('download-progress', (event, data) => callback(data));
    },
    onCompleted: (callback: (data: { id: string; filename: string; path: string }) => void) => {
      ipcRenderer.on('download-completed', (event, data) => callback(data));
    }
  },
  omnibox: {
    getSuggestions: (query: string) => ipcRenderer.invoke('get-omnibox-suggestions', query),
    showDropdown: (data: { bounds: { x: number; y: number; width: number; height: number }; suggestions: any[]; selectedIndex: number }) =>
      ipcRenderer.send('show-omnibox-dropdown', data),
    hideDropdown: () => ipcRenderer.send('hide-omnibox-dropdown'),
    onAction: (callback: (index: number) => void) => {
      ipcRenderer.on('omnibox-action', (event, index) => callback(index));
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('get-settings'),
    update: (partial: any) => ipcRenderer.invoke('update-settings', partial),
    clearSessionData: (options?: any) => ipcRenderer.invoke('clear-session-data', options)
  },
  ai: {
    extractPageContext: (tabId: string) => ipcRenderer.invoke('extract-page-context', tabId),
    extractFormFields: (tabId: string) => ipcRenderer.invoke('extract-form-fields', tabId),
    fillFormFields: (tabId: string, instructions: any[]) =>
      ipcRenderer.invoke('fill-form-fields', tabId, instructions)
  },
  phantom: {
    getMessages: () => ipcRenderer.invoke('get-phantom-messages'),
    clearMessages: () => ipcRenderer.invoke('clear-phantom-messages'),
    deleteMessage: (id: string) => ipcRenderer.invoke('delete-phantom-message', id),
    saveMessage: (msg: any) => ipcRenderer.send('phantom-message-captured', msg),
    getStatuses: () => ipcRenderer.invoke('get-saved-statuses'),
    saveStatus: (status: any) => ipcRenderer.invoke('save-saved-status', status),
    deleteStatus: (id: string) => ipcRenderer.invoke('delete-saved-status', id),
    deleteStatusesByContact: (contact: string) => ipcRenderer.invoke('delete-statuses-by-contact', contact),
    clearStatuses: () => ipcRenderer.invoke('clear-saved-statuses'),
    onMessageUpdated: (callback: (msg: any) => void) => {
      ipcRenderer.on('phantom-message-updated', (event, msg) => callback(msg));
    },
    onUpdated: (callback: (msg: any) => void) => {
      ipcRenderer.on('phantom-message-updated', (event, msg) => callback(msg));
    },
    onStatusUpdated: (callback: (status: any) => void) => {
      ipcRenderer.on('phantom-status-updated', (event, status) => callback(status));
    }
  },
  system: {
    getRam: () => ipcRenderer.invoke('get-system-ram'),
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url)
  },
  turbo: {
    getStatus: () => ipcRenderer.invoke('get-turbo-status'),
    toggle: (enabled: boolean) => ipcRenderer.invoke('toggle-turbo-mode', enabled),
    dnsPrefetch: (url: string) => ipcRenderer.send('dns-prefetch', url)
  },
  cinema: {
    getStatus: () => ipcRenderer.invoke('cinema-get-status'),
    createRoom: async (
      mode: 'player' | 'browser' = 'player',
      username?: string,
      maxParticipants?: number,
      controlMode?: 'host_only' | 'everyone'
    ) => {
      const res = await ipcRenderer.invoke('cinema-create-room', mode, username, maxParticipants, controlMode);
      if (res && res.roomId) {
        await cinemaPeerInstance.createRoom(res.roomId, maxParticipants, controlMode, username);
      }
      return res;
    },
    joinRoom: async (code: string, username?: string) => {
      const res = await ipcRenderer.invoke('cinema-join-room', code, username);
      if (res && res.roomId) {
        await cinemaPeerInstance.joinRoom(res.roomId, username);
      }
      return res;
    },
    leaveRoom: async () => {
      cinemaPeerInstance.cleanup();
      return await ipcRenderer.invoke('cinema-leave-room');
    },
    updateControlMode: async (mode: 'host_only' | 'everyone') => {
      cinemaPeerInstance.updateControlMode(mode);
      return await ipcRenderer.invoke('cinema-update-control-mode', mode);
    },
    toggleLights: (enabled?: boolean) => ipcRenderer.invoke('cinema-toggle-lights', enabled),
    onStatusUpdated: (callback: (status: any) => void) => {
      ipcRenderer.on('cinema-status-updated', (event, status) => callback(status));
    },
    sendChat: (text: string) => ipcRenderer.send('cinema-send-chat', text),
    sendMedia: (mediaUrl: string, mediaType: 'image' | 'sticker' | 'gif') =>
      ipcRenderer.send('cinema-send-media', { mediaUrl, mediaType }),
    onChatMessage: (callback: (msg: any) => void) => {
      ipcRenderer.on('cinema-chat-message', (event, msg) => callback(msg));
    },
    onChatHistory: (callback: (messages: any[]) => void) => {
      ipcRenderer.on('cinema-chat-history', (event, messages) => callback(messages));
    },
    sendReaction: (emoji: string) => ipcRenderer.send('cinema-reaction-send', emoji),
    onReaction: (callback: (emoji: string) => void) => {
      ipcRenderer.on('cinema-reaction', (event, emoji) => callback(emoji));
    },
    sendPlayerSyncState: (payload: any) => ipcRenderer.send('cinema-player-sync-send', payload),
    onPlayerSyncReceived: (callback: (payload: any) => void) => {
      ipcRenderer.on('cinema-player-sync-received', (event, payload) => callback(payload));
    },
    onSyncNavigate: (callback: (data: { url: string; mode: string }) => void) => {
      ipcRenderer.on('cinema-sync-navigate', (event, data) => callback(data));
    },
    onRoomModeUpdated: (callback: (status: any) => void) => {
      ipcRenderer.on('cinema-room-mode-updated', (event, status) => callback(status));
    },
    onControlModeUpdated: (callback: (mode: string) => void) => {
      ipcRenderer.on('cinema-control-mode-updated', (event, mode) => callback(mode));
    },
    onParticipantsUpdated: (callback: (participants: any[]) => void) => {
      ipcRenderer.on('cinema-participants-updated', (event, participants) => callback(participants));
    },
    onControlDenied: (callback: (message: string) => void) => {
      ipcRenderer.on('cinema-control-denied', (event, message) => callback(message));
    },
    onRoomFull: (callback: (maxParticipants: number) => void) => {
      ipcRenderer.on('cinema-room-full', (event, maxParticipants) => callback(maxParticipants));
    },
    toggleMicrophone: (active: boolean) => cinemaPeerInstance.toggleMicrophone(active),
    onRoomExpired: (callback: () => void) => {
      ipcRenderer.on('cinema-room-expired', () => callback());
    },
    toggleDrawer: (isOpen: boolean) => ipcRenderer.invoke('toggle-cinema-drawer', isOpen),
    getServerPort: () => ipcRenderer.invoke('cinema-get-server-port'),
    extractMedia: (url: string) => ipcRenderer.invoke('cinema-extract-media', url)
  },
  menuPopup: {
    show: (payload: any) => ipcRenderer.send('show-menu-popup', payload),
    hide: () => ipcRenderer.send('hide-menu-popup'),
    onAction: (callback: (action: string, payload: any) => void) => {
      ipcRenderer.on('menu-popup-action', (event, action, data) => callback(action, data));
    }
  },
  vpn: {
    getState: () => ipcRenderer.invoke('vpn-get-state'),
    toggle: (enabled?: boolean) => ipcRenderer.invoke('vpn-toggle', enabled),
    setLocation: (location: string) => ipcRenderer.invoke('vpn-set-location', location),
    onStatusUpdated: (callback: (state: any) => void) => {
      ipcRenderer.on('vpn-status-updated', (event, data) => callback(data));
    }
  },
  events: {
    onViewEvent: (callback: (id: string, eventName: string, data?: any) => void) => {
      ipcRenderer.on('view-event', (event, id, eventName, data) => callback(id, eventName, data));
    },
    onMediaDetected: (callback: (tabId: string, payload: any) => void) => {
      ipcRenderer.on('media-detected', (event, tabId, payload) => callback(tabId, payload));
    },
    onMediaDRMLocked: (callback: (tabId: string) => void) => {
      ipcRenderer.on('media-drm-locked', (event, tabId) => callback(tabId));
    },
    onSniffingStart: (callback: (tabId: string) => void) => {
      ipcRenderer.on('sniffing-start', (event, tabId) => callback(tabId));
    },
    onSniffingEnd: (callback: (tabId: string) => void) => {
      ipcRenderer.on('sniffing-end', (event, tabId) => callback(tabId));
    },
    onHtmlFullscreen: (callback: (active: boolean) => void) => {
      ipcRenderer.on('html-fullscreen', (event, active) => callback(active));
    },
    onNavStateChanged: (callback: (data: { tabId: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }) => void) => {
      ipcRenderer.on('nav-state-changed', (event, data) => callback(data));
    },
    onTorConnectingStart: (callback: (data: { tabId: string; targetUrl: string; progress: number }) => void) => {
      ipcRenderer.on('tor-connecting-start', (event, data) => callback(data));
    },
    onTorConnectingFinish: (callback: (data: { tabId: string; targetUrl: string }) => void) => {
      ipcRenderer.on('tor-connecting-finish', (event, data) => callback(data));
    },
    onTorBootstrapProgress: (callback: (data: { progress: number; summary: string }) => void) => {
      ipcRenderer.on('tor-bootstrap-progress', (event, data) => callback(data));
    }
  }
};

contextBridge.exposeInMainWorld('betaAPI', betaAPI);
