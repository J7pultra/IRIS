import { BrowserWindow, ipcMain, net, webContents } from 'electron';
import * as path from 'path';
import { StorageService } from './storageService';
import { MediaSniffer } from './mediaSniffer';
import { viewManager } from './main';
import { VpnService } from './vpnService';

export class UiManager {
  private mainWindow: BrowserWindow;
  private omniboxWindow: BrowserWindow | null = null;
  private downloadPopupWindow: BrowserWindow | null = null;
  private menuPopupWindow: BrowserWindow | null = null;
  private isOmniboxReady = false;
  private isDownloadPopupReady = false;
  private isMenuPopupReady = false;
  private lastOmniboxData: any = null;
  private lastDownloadData: any = null;
  private lastMenuPopupData: any = null;
  private omniboxRelativeOffset: { dx: number; dy: number; width: number } | null = null;
  private downloadRelativeOffset: { dx: number; dy: number; width: number } | null = null;
  private menuRelativeOffset: { dx: number; dy: number; width: number; height: number } | null = null;
  private isDownloadPopupOpen = false;
  private hoverCardWindow: BrowserWindow | null = null;
  public lastRequesterWindow: BrowserWindow | null = null;
  public currentOmniboxRequester: BrowserWindow | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.registerIpc();

    VpnService.onStateChange((state) => {
      if (this.menuPopupWindow && !this.menuPopupWindow.isDestroyed() && this.menuPopupWindow.isVisible()) {
        this.menuPopupWindow.webContents.send('vpn-status-updated', state);
      }
    });
  }

  // ============================================================================
  // 1. OMNIBOX DROPDOWN (AUTOCOMPLETE)
  // ============================================================================
  private getOmniboxWindow(requesterWindow?: BrowserWindow): BrowserWindow {
    const parent = (requesterWindow && !requesterWindow.isDestroyed())
      ? requesterWindow
      : ((this.currentOmniboxRequester && !this.currentOmniboxRequester.isDestroyed()) ? this.currentOmniboxRequester : this.mainWindow);

    if (this.omniboxWindow && !this.omniboxWindow.isDestroyed()) {
      try {
        if (parent && !parent.isDestroyed()) {
          this.omniboxWindow.setParentWindow(parent);
        }
      } catch {}
      return this.omniboxWindow;
    }

    this.isOmniboxReady = false;
    this.omniboxWindow = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false, // Ensures address bar doesn't lose focus
      show: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/preloadOmnibox.js')
      }
    });

    this.omniboxWindow.setAlwaysOnTop(true, 'pop-up-menu');

    this.omniboxWindow.on('blur', () => {
      if (this.omniboxWindow && !this.omniboxWindow.isDestroyed() && this.omniboxWindow.isVisible()) {
        this.omniboxWindow.hide();
      }
    });

    this.omniboxWindow.on('closed', () => {
      this.omniboxWindow = null;
      this.isOmniboxReady = false;
    });

    this.omniboxWindow.webContents.on('did-finish-load', () => {
      this.isOmniboxReady = true;
      if (this.lastOmniboxData && this.omniboxWindow && !this.omniboxWindow.isDestroyed()) {
        this.omniboxWindow.webContents.send('render-suggestions', this.lastOmniboxData);
      }
    });

    this.omniboxWindow.loadFile(path.join(__dirname, '../renderer/omnibox.html'));
    return this.omniboxWindow;
  }

  // ============================================================================
  // 2. SHIELD-STYLE MEDIA DOWNLOAD POPUP
  // ============================================================================
  private getDownloadPopupWindow(): BrowserWindow {
    if (this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed()) {
      return this.downloadPopupWindow;
    }

    this.isDownloadPopupReady = false;
    this.downloadPopupWindow = new BrowserWindow({
      parent: this.mainWindow,
      width: 340,
      height: 440,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/preloadDownloadPopup.js')
      }
    });

    this.downloadPopupWindow.setAlwaysOnTop(true, 'pop-up-menu');

    const hideDownload = () => {
      if (this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed() && this.downloadPopupWindow.isVisible()) {
        this.downloadPopupWindow.hide();
        this.isDownloadPopupOpen = false;
        try {
          const { viewManager } = require('./main');
          if (viewManager) viewManager.applyMenuBlur(false);
        } catch {}
      }
    };

    const updatePosition = () => {
      if (this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed() && this.downloadRelativeOffset) {
        const winBounds = this.mainWindow.getBounds();
        this.downloadPopupWindow.setBounds({
          x: winBounds.x + this.downloadRelativeOffset.dx,
          y: winBounds.y + this.downloadRelativeOffset.dy,
          width: 340,
          height: 440
        });
      }
    };

    this.downloadPopupWindow.on('blur', hideDownload);
    this.mainWindow.on('will-move', hideDownload);
    this.mainWindow.on('will-resize', hideDownload);
    this.mainWindow.on('minimize', hideDownload);
    this.mainWindow.on('hide', hideDownload);
    this.mainWindow.on('move', updatePosition);
    this.mainWindow.on('resize', updatePosition);

    this.downloadPopupWindow.on('closed', () => {
      this.mainWindow.removeListener('will-move', hideDownload);
      this.mainWindow.removeListener('will-resize', hideDownload);
      this.mainWindow.removeListener('minimize', hideDownload);
      this.mainWindow.removeListener('hide', hideDownload);
      this.mainWindow.removeListener('move', updatePosition);
      this.mainWindow.removeListener('resize', updatePosition);
      this.downloadPopupWindow = null;
      this.isDownloadPopupOpen = false;
    });

    this.downloadPopupWindow.loadFile(path.join(__dirname, '../renderer/downloadPopup.html'));
    return this.downloadPopupWindow;
  }

  // ============================================================================
  // 3. UNIVERSAL ON-TOP MENU POPUP (TURBO, SHIELD, CINEMA & 3-DOTS)
  // ============================================================================
  private getMenuPopupWindow(): BrowserWindow {
    if (this.menuPopupWindow && !this.menuPopupWindow.isDestroyed()) {
      return this.menuPopupWindow;
    }

    this.isMenuPopupReady = false;
    this.menuPopupWindow = new BrowserWindow({
      parent: this.mainWindow,
      width: 320,
      height: 320,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/preloadMenuPopup.js')
      }
    });

    this.menuPopupWindow.setAlwaysOnTop(true, 'pop-up-menu');

    const hideMenu = () => {
      if (this.menuPopupWindow && !this.menuPopupWindow.isDestroyed() && this.menuPopupWindow.isVisible()) {
        this.menuPopupWindow.hide();
        try {
          const { viewManager } = require('./main');
          if (viewManager) viewManager.applyMenuBlur(false);
        } catch {}
      }
    };

    const updatePosition = () => {
      if (this.menuPopupWindow && !this.menuPopupWindow.isDestroyed() && this.menuRelativeOffset) {
        const winBounds = this.mainWindow.getBounds();
        this.menuPopupWindow.setBounds({
          x: winBounds.x + this.menuRelativeOffset.dx,
          y: winBounds.y + this.menuRelativeOffset.dy,
          width: this.menuRelativeOffset.width,
          height: this.menuRelativeOffset.height
        });
      }
    };

    this.menuPopupWindow.on('blur', hideMenu);
    this.mainWindow.on('will-move', hideMenu);
    this.mainWindow.on('will-resize', hideMenu);
    this.mainWindow.on('minimize', hideMenu);
    this.mainWindow.on('hide', hideMenu);
    this.mainWindow.on('move', updatePosition);
    this.mainWindow.on('resize', updatePosition);

    this.menuPopupWindow.on('closed', () => {
      this.mainWindow.removeListener('will-move', hideMenu);
      this.mainWindow.removeListener('will-resize', hideMenu);
      this.mainWindow.removeListener('minimize', hideMenu);
      this.mainWindow.removeListener('hide', hideMenu);
      this.mainWindow.removeListener('move', updatePosition);
      this.mainWindow.removeListener('resize', updatePosition);
      this.menuPopupWindow = null;
      this.isMenuPopupReady = false;
    });

    this.menuPopupWindow.webContents.on('did-finish-load', () => {
      this.isMenuPopupReady = true;
      if (this.lastMenuPopupData && this.menuPopupWindow && !this.menuPopupWindow.isDestroyed()) {
        this.menuPopupWindow.webContents.send('render-menu-popup', this.lastMenuPopupData);
      }
    });

    this.menuPopupWindow.loadFile(path.join(__dirname, '../renderer/menuPopup.html'));
    return this.menuPopupWindow;
  }

  public updateMenuPopupData(type: string, data: any) {
    if (this.menuPopupWindow && !this.menuPopupWindow.isDestroyed() && this.menuPopupWindow.isVisible()) {
      if (this.lastMenuPopupData && this.lastMenuPopupData.type === type) {
        this.lastMenuPopupData.data = { ...this.lastMenuPopupData.data, ...data };
        this.menuPopupWindow.webContents.send('render-menu-popup', this.lastMenuPopupData);
      }
    }
  }

  public showMenuPopup(payload: { type: string; bounds: { x: number; y: number; width: number; height: number }; data?: any; isUpdateOnly?: boolean }, requesterWindow?: BrowserWindow) {
    const win = this.getMenuPopupWindow();

    if (!payload.isUpdateOnly && win.isVisible() && this.lastMenuPopupData && this.lastMenuPopupData.type === payload.type) {
      win.hide();
      return;
    }

    const parent = (requesterWindow && !requesterWindow.isDestroyed())
      ? requesterWindow
      : ((this.lastRequesterWindow && !this.lastRequesterWindow.isDestroyed()) ? this.lastRequesterWindow : this.mainWindow);
    const parentBounds = parent.getBounds();
    let popupWidth = 340;
    let popupHeight = 340;

    if (payload.type === 'turbo') {
      popupWidth = 330;
      popupHeight = 280;
    } else if (payload.type === 'shield') {
      popupWidth = 310;
      popupHeight = 315;
    } else if (payload.type === 'menu') {
      popupWidth = 340;
      popupHeight = Math.min(680, Math.max(480, parentBounds.height - (payload.bounds.y + payload.bounds.height + 6) - 14));
    } else if (payload.type === 'cinema') {
      popupWidth = 340;
      popupHeight = 360;
    } else if (payload.type === 'wallet') {
      popupWidth = 340;
      popupHeight = 440;
    } else if (payload.type === 'vpn') {
      popupWidth = 350;
      popupHeight = 520;
    } else if (payload.type === 'extensions') {
      popupWidth = 330;
      popupHeight = 390;
    } else if (payload.type === 'bookmarks') {
      popupWidth = 330;
      popupHeight = 420;
    }

    const isRightAligned = ['menu', 'wallet', 'vpn', 'extensions', 'bookmarks'].includes(payload.type);
    let modalX = isRightAligned
      ? Math.round(payload.bounds.x + payload.bounds.width - popupWidth)
      : Math.round(payload.bounds.x + (payload.bounds.width / 2) - (popupWidth / 2));
    const modalY = Math.round(payload.bounds.y + payload.bounds.height + 6);

    if (modalX + popupWidth > parentBounds.width - 12) {
      modalX = parentBounds.width - popupWidth - 12;
    }
    if (modalX < 12) modalX = 12;

    this.menuRelativeOffset = {
      dx: modalX,
      dy: modalY,
      width: popupWidth,
      height: popupHeight
    };

    win.setBounds({
      x: parentBounds.x + modalX,
      y: parentBounds.y + modalY,
      width: popupWidth,
      height: popupHeight
    });

    if (!payload.data) payload.data = {};
    payload.data.vpnState = VpnService.getState();

    this.lastMenuPopupData = payload;
    win.webContents.send('render-menu-popup', payload);

    win.show();
    win.setAlwaysOnTop(true, 'pop-up-menu');
    try {
      const { viewManager } = require('./main');
      if (viewManager) viewManager.applyMenuBlur(true);
    } catch {}
  }

  public hideMenuPopup() {
    if (this.menuPopupWindow && !this.menuPopupWindow.isDestroyed() && this.menuPopupWindow.isVisible()) {
      this.menuPopupWindow.hide();
      try {
        const { viewManager } = require('./main');
        if (viewManager) viewManager.applyMenuBlur(false);
      } catch {}
    }
  }

  // ============================================================================
  // 4. TAB HOVER CARD (LIVE RAM PREVIEW)
  // ============================================================================
  private getHoverCardWindow(): BrowserWindow {
    if (this.hoverCardWindow && !this.hoverCardWindow.isDestroyed()) {
      return this.hoverCardWindow;
    }

    this.hoverCardWindow = new BrowserWindow({
      parent: this.mainWindow,
      width: 260,
      height: 90,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    this.hoverCardWindow.setAlwaysOnTop(true, 'pop-up-menu');
    this.hoverCardWindow.setIgnoreMouseEvents(true);

    const hideHover = () => {
      if (this.hoverCardWindow && !this.hoverCardWindow.isDestroyed() && this.hoverCardWindow.isVisible()) {
        this.hoverCardWindow.hide();
      }
    };

    this.mainWindow.on('will-move', hideHover);
    this.mainWindow.on('will-resize', hideHover);
    this.mainWindow.on('minimize', hideHover);

    this.hoverCardWindow.on('closed', () => {
      this.mainWindow.removeListener('will-move', hideHover);
      this.mainWindow.removeListener('will-resize', hideHover);
      this.mainWindow.removeListener('minimize', hideHover);
      this.hoverCardWindow = null;
    });

    this.hoverCardWindow.loadFile(path.join(__dirname, '../renderer/hoverCard.html'));
    return this.hoverCardWindow;
  }

  public showHoverCard(data: { x: number; y: number; title: string; domain: string; ram: number; isHibernated?: boolean }) {
    try {
      const win = this.getHoverCardWindow();

      const titleEscaped = JSON.stringify(data.title || 'Nueva pestaña');
      const domainEscaped = JSON.stringify(data.domain || '');
      const ramEscaped = JSON.stringify(data.ram || 0);
      const isHibernated = !!data.isHibernated;

      win.webContents.executeJavaScript(`
        if (document.getElementById('hover-card-title')) {
          document.getElementById('hover-card-title').textContent = ${titleEscaped};
          document.getElementById('hover-card-domain').textContent = ${domainEscaped};
          const memContainer = document.getElementById('hover-card-memory-container');
          if (${isHibernated}) {
            if (memContainer) memContainer.innerHTML = 'Estado: <span class="hibernated-badge">Hibernada (0 MB)</span>';
          } else {
            if (memContainer) memContainer.innerHTML = 'Uso de memoria: <strong id="hover-card-ram">' + ${ramEscaped} + '</strong> MB';
          }
        }
      `).catch(() => {});

      win.setBounds({
        x: data.x,
        y: data.y,
        width: 260,
        height: 90
      });

      if (!win.isVisible()) {
        win.showInactive();
      }
    } catch (err) {
      console.error('[UiManager.showHoverCard] Error:', err);
    }
  }

  public hideHoverCard() {
    try {
      if (this.hoverCardWindow && !this.hoverCardWindow.isDestroyed() && this.hoverCardWindow.isVisible()) {
        this.hoverCardWindow.hide();
      }
    } catch (err) {
      console.error('[UiManager.hideHoverCard] Error:', err);
    }
  }

  public hideDownloadPopup() {
    if (this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed() && this.downloadPopupWindow.isVisible()) {
      this.downloadPopupWindow.hide();
      this.isDownloadPopupOpen = false;
      try {
        const { viewManager } = require('./main');
        if (viewManager) viewManager.applyMenuBlur(false);
      } catch {}
    }
  }

  public updateDownloadPopupData(data: any) {
    this.lastDownloadData = data;
    if (this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed() && this.downloadPopupWindow.isVisible()) {
      this.downloadPopupWindow.webContents.send('download-popup-data', data);
    }
  }

  public hideOmniboxDropdown() {
    if (this.omniboxWindow && !this.omniboxWindow.isDestroyed() && this.omniboxWindow.isVisible()) {
      this.omniboxWindow.hide();
    }
  }

  public toggleDownloadPopup(payload: { bounds: { x: number; y: number; width: number; height: number }; activeTabId?: string; activeUrl?: string; activeTitle?: string }) {
    const win = this.getDownloadPopupWindow();

    if (this.isDownloadPopupOpen && win.isVisible()) {
      win.hide();
      this.isDownloadPopupOpen = false;
      try {
        const { viewManager } = require('./main');
        if (viewManager) viewManager.applyMenuBlur(false);
      } catch {}
      return;
    }

    const popupWidth = 340;
    const popupHeight = 440;
    const parentBounds = this.mainWindow.getBounds();

    let modalX = Math.round(payload.bounds.x + payload.bounds.width - popupWidth);
    const modalY = Math.round(payload.bounds.y + payload.bounds.height + 6);

    if (modalX + popupWidth > parentBounds.width) {
      modalX = parentBounds.width - popupWidth - 12;
    }
    if (modalX < 12) modalX = 12;

    this.downloadRelativeOffset = {
      dx: modalX,
      dy: modalY,
      width: popupWidth
    };

    win.setBounds({
      x: parentBounds.x + modalX,
      y: parentBounds.y + modalY,
      width: popupWidth,
      height: popupHeight
    });

    // Obtener multimedia cacheada para la pestaña activa
    let dataToSend: any = {
      hasMedia: false,
      downloads: null,
      title: payload.activeTitle || 'Página Web',
      thumbnail: '',
      metadata: {
        title: payload.activeTitle || 'Página Web',
        originalUrl: payload.activeUrl || ''
      }
    };

    if (payload.activeTabId) {
      const cached = MediaSniffer.getMediaForTab(payload.activeTabId);
      if (cached && !cached.isDrmLocked && cached.downloads && Object.keys(cached.downloads).length > 0) {
        dataToSend = {
          hasMedia: true,
          downloads: cached.downloads,
          title: cached.title || payload.activeTitle || 'Video Detectado',
          thumbnail: cached.thumbnail || '',
          metadata: {
            title: cached.title || payload.activeTitle || 'Video Detectado',
            thumbnail: cached.thumbnail || '',
            originalUrl: cached.originalUrl || payload.activeUrl || ''
          }
        };
      } else {
        MediaSniffer.scanPage(payload.activeTabId, this.mainWindow);
      }
    }

    this.lastDownloadData = dataToSend;

    if (this.isDownloadPopupReady) {
      win.webContents.send('download-popup-data', dataToSend);
    }

    win.show();
    win.setAlwaysOnTop(true, 'pop-up-menu');
    this.isDownloadPopupOpen = true;
    try {
      const { viewManager } = require('./main');
      if (viewManager) viewManager.applyMenuBlur(true);
    } catch {}
  }

  // ============================================================================
  // 3. DIÁLOGO DE CONFIRMACIÓN DE CIERRE (ESTILO MICROSOFT EDGE)
  // ============================================================================
  public showCloseConfirmationDialog(
    targetWin: BrowserWindow,
    tabCount: number
  ): Promise<{ confirmed: boolean; dontAskAgain: boolean }> {
    return new Promise((resolve) => {
      if (!targetWin || targetWin.isDestroyed()) {
        return resolve({ confirmed: true, dontAskAgain: false });
      }

      const dialogWidth = 410;
      const dialogHeight = 185;
      const winBounds = targetWin.getBounds();
      const x = Math.round(winBounds.x + (winBounds.width - dialogWidth) / 2);
      const y = Math.round(winBounds.y + 44);

      // NOTA: No llamamos a applyMenuBlur para evitar el destello borroso de fondo y el parpadeo de pestañas
      const dialogWin = new BrowserWindow({
        parent: targetWin,
        modal: false,
        width: dialogWidth,
        height: dialogHeight,
        x,
        y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        alwaysOnTop: false, // NO alwaysOnTop: evita que quede flotando sobre otras apps al minimizar
        show: false,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, '../preload/preloadConfirmClose.js')
        }
      });

      let isResolved = false;
      const updatePosition = () => {
        if (dialogWin && !dialogWin.isDestroyed() && targetWin && !targetWin.isDestroyed()) {
          const b = targetWin.getBounds();
          dialogWin.setPosition(
            Math.round(b.x + (b.width - dialogWidth) / 2),
            Math.round(b.y + 44)
          );
        }
      };

      const keepDialogFocused = () => {
        if (dialogWin && !dialogWin.isDestroyed() && dialogWin.isVisible()) {
          dialogWin.focus();
        }
      };

      const onMinimize = () => {
        if (dialogWin && !dialogWin.isDestroyed()) {
          dialogWin.hide();
        }
      };

      const onRestore = () => {
        if (dialogWin && !dialogWin.isDestroyed() && !isResolved) {
          dialogWin.show();
        }
      };

      const cleanupAndResolve = (result: { confirmed: boolean; dontAskAgain: boolean }) => {
        if (isResolved) return;
        isResolved = true;

        ipcMain.removeListener('confirm-close-response', onResponse);
        if (targetWin && !targetWin.isDestroyed()) {
          targetWin.removeListener('move', updatePosition);
          targetWin.removeListener('resize', updatePosition);
          targetWin.removeListener('focus', keepDialogFocused);
          targetWin.removeListener('minimize', onMinimize);
          targetWin.removeListener('restore', onRestore);
          targetWin.removeListener('hide', onMinimize);
          targetWin.removeListener('show', onRestore);
          try { targetWin.focus(); } catch {}
        }

        if (dialogWin && !dialogWin.isDestroyed()) {
          dialogWin.hide();
          setImmediate(() => {
            if (!dialogWin.isDestroyed()) {
              dialogWin.destroy();
            }
          });
        }
        resolve(result);
      };

      const onResponse = (_event: any, result: { confirmed: boolean; dontAskAgain: boolean }) => {
        cleanupAndResolve(result || { confirmed: false, dontAskAgain: false });
      };

      ipcMain.on('confirm-close-response', onResponse);

      targetWin.on('move', updatePosition);
      targetWin.on('resize', updatePosition);
      targetWin.on('focus', keepDialogFocused);
      targetWin.on('minimize', onMinimize);
      targetWin.on('restore', onRestore);
      targetWin.on('hide', onMinimize);
      targetWin.on('show', onRestore);

      dialogWin.on('closed', () => {
        cleanupAndResolve({ confirmed: false, dontAskAgain: false });
      });

      const settings = StorageService.getSettings();
      const currentTheme = settings?.theme || 'dark';

      dialogWin.loadFile(path.join(__dirname, '../renderer/confirmCloseDialog.html')).then(() => {
        dialogWin.webContents.send('init-confirm-close', { tabCount, theme: currentTheme });
        dialogWin.show();
      }).catch((e) => {
        console.warn('[UiManager] Error cargando confirmCloseDialog:', e);
        cleanupAndResolve({ confirmed: true, dontAskAgain: false });
      });
    });
  }

  // ============================================================================
  // 4. REGISTRO DE IPC
  // ============================================================================
  private registerIpc() {
    // ── Omnibox Ready & Suggestions ──
    ipcMain.on('omnibox-ready', () => {
      this.isOmniboxReady = true;
      if (this.lastOmniboxData && this.omniboxWindow && !this.omniboxWindow.isDestroyed()) {
        this.omniboxWindow.webContents.send('render-suggestions', this.lastOmniboxData);
      }
    });

    ipcMain.handle('get-omnibox-suggestions', async (event, query: string) => {
      if (!query || query.trim() === '') return [];
      const normalizedQuery = query.toLowerCase().trim();

      const tasks = [
        // 1. Pestañas abiertas (excluyendo páginas internas y títulos provisionales 'Cargando...')
        (async () => {
          try {
            const tabs = viewManager ? viewManager.getAllTabs() : [];
            return tabs
              .filter(t => {
                if (!t.url || t.url.startsWith('beta://') || t.url === 'about:blank') return false;
                const cleanTitle = (t.title || '').trim().toLowerCase();
                if (cleanTitle === 'cargando...' || cleanTitle === 'cargando' || cleanTitle === '') return false;
                return cleanTitle.includes(normalizedQuery) || t.url.toLowerCase().includes(normalizedQuery);
              })
              .map(t => ({
                type: 'switch-tab',
                title: t.title,
                url: t.url,
                tabId: t.tabId
              }));
          } catch (err) {
            return [];
          }
        })(),

        // 2. Historial y Marcadores locales (excluyendo URLs internas y títulos erróneos)
        (async () => {
          try {
            const history = StorageService.getHistory() || [];
            const bookmarks = StorageService.getBookmarks() || [];

            const matchingHistory = history
              .filter(h => {
                if (!h.url || h.url.startsWith('beta://') || h.url === 'about:blank') return false;
                const cleanTitle = (h.title || '').trim().toLowerCase();
                if (cleanTitle === 'cargando...' || cleanTitle === 'cargando') return false;
                return cleanTitle.includes(normalizedQuery) || h.url.toLowerCase().includes(normalizedQuery);
              })
              .map(h => ({
                type: 'history',
                title: h.title || h.url,
                url: h.url
              }));

            const matchingBookmarks = bookmarks
              .filter(b => {
                if (!b.url || b.url.startsWith('beta://') || b.url === 'about:blank') return false;
                const cleanTitle = (b.title || '').trim().toLowerCase();
                if (cleanTitle === 'cargando...' || cleanTitle === 'cargando') return false;
                return cleanTitle.includes(normalizedQuery) || b.url.toLowerCase().includes(normalizedQuery);
              })
              .map(b => ({
                type: 'bookmark',
                title: b.title || b.url,
                url: b.url
              }));

            return [...matchingBookmarks, ...matchingHistory];
          } catch (err) {
            return [];
          }
        })(),

        // 3. Google Autocomplete API
        (async () => {
          try {
            const response = await net.fetch(`https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`);
            if (response.ok) {
              const data = await response.json();
              const suggestions = data[1] || [];
              return suggestions.map((s: string) => ({
                type: 'search',
                title: s,
                url: `https://www.google.com/search?q=${encodeURIComponent(s)}`
              }));
            }
          } catch (err) { }
          return [];
        })()
      ];

      const results = await Promise.allSettled(tasks);
      let allSuggestions: any[] = [];
      results.forEach(res => {
        if (res.status === 'fulfilled' && res.value) {
          allSuggestions = allSuggestions.concat(res.value);
        }
      });

      const seen = new Set<string>();
      const uniqueSuggestions: any[] = [];
      for (const item of allSuggestions) {
        const key = item.type === 'search' ? `search:${item.title}` : `url:${item.url}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueSuggestions.push(item);
        }
      }

      return uniqueSuggestions.slice(0, 7);
    });

    ipcMain.on('show-omnibox-dropdown', (event, data: { bounds: { x: number; y: number; width: number; height: number }; suggestions: any[]; selectedIndex: number }) => {
      try {
        const requesterWin = BrowserWindow.fromWebContents(event.sender) || this.mainWindow;
        this.currentOmniboxRequester = requesterWin;
        const win = this.getOmniboxWindow(requesterWin);

        // Si la ventana emisora se mueve o redimensiona, ocultar el dropdown para evitar desalineación
        const hideDropdown = () => {
          if (win && !win.isDestroyed() && win.isVisible()) {
            win.hide();
          }
        };
        requesterWin.once('will-move', hideDropdown);
        requesterWin.once('will-resize', hideDropdown);

        const contentBounds = (typeof requesterWin.getContentBounds === 'function')
          ? requesterWin.getContentBounds()
          : requesterWin.getBounds();

        this.omniboxRelativeOffset = {
          dx: data.bounds.x,
          dy: data.bounds.y + data.bounds.height + 4,
          width: data.bounds.width
        };

        const itemCount = (data.suggestions || []).length;
        const targetHeight = Math.min(360, Math.max(48, itemCount * 42 + 8));

        win.setBounds({
          x: Math.round(contentBounds.x + this.omniboxRelativeOffset.dx),
          y: Math.round(contentBounds.y + this.omniboxRelativeOffset.dy),
          width: Math.round(data.bounds.width),
          height: targetHeight
        });

        this.lastOmniboxData = {
          suggestions: data.suggestions,
          selectedIndex: data.selectedIndex
        };

        if (this.isOmniboxReady) {
          win.webContents.send('render-suggestions', this.lastOmniboxData);
        }

        if (!win.isVisible()) {
          win.showInactive();
        }
      } catch (err) {
        console.error('[UiManager] Error mostrando omnibox:', err);
      }
    });

    ipcMain.on('hide-omnibox-dropdown', () => {
      if (this.omniboxWindow && !this.omniboxWindow.isDestroyed() && this.omniboxWindow.isVisible()) {
        this.omniboxWindow.hide();
      }
    });

    ipcMain.on('omnibox-action', (event, index: number) => {
      const targetWin = (this.currentOmniboxRequester && !this.currentOmniboxRequester.isDestroyed())
        ? this.currentOmniboxRequester
        : (BrowserWindow.fromWebContents(event.sender) || this.mainWindow);

      if (targetWin && !targetWin.isDestroyed()) {
        targetWin.webContents.send('omnibox-action', index);
      }
      if (this.omniboxWindow && !this.omniboxWindow.isDestroyed()) {
        this.omniboxWindow.hide();
      }
    });

    // ── Download Popup IPC ──
    ipcMain.on('download-popup-ready', () => {
      this.isDownloadPopupReady = true;
      if (this.lastDownloadData && this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed()) {
        this.downloadPopupWindow.webContents.send('download-popup-data', this.lastDownloadData);
      }
    });

    ipcMain.on('toggle-download-popup', (event, payload: any) => {
      this.toggleDownloadPopup(payload);
    });

    ipcMain.on('hide-download-popup', () => {
      if (this.downloadPopupWindow && !this.downloadPopupWindow.isDestroyed() && this.downloadPopupWindow.isVisible()) {
        this.downloadPopupWindow.hide();
        this.isDownloadPopupOpen = false;
      }
      try {
        const { viewManager } = require('./main');
        if (viewManager) viewManager.applyMenuBlur(false);
      } catch {}
    });

    ipcMain.handle('download-media-action', async (event, args: {
      url: string;
      audioUrl?: string;
      title?: string;
      quality?: string;
      ext?: string;
      type?: string;
      formatId?: string;
      originalUrl?: string;
    }) => {
      try {
        return await MediaSniffer.downloadMedia(
          args.url,
          args.audioUrl,
          this.mainWindow,
          args.title,
          args.quality,
          args.ext,
          args.type,
          args.formatId,
          args.originalUrl
        );
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // ── Universal Menu Popup IPC ──
    ipcMain.on('show-menu-popup', (event, payload: any) => {
      const requester = BrowserWindow.fromWebContents(event.sender) || this.mainWindow;
      this.lastRequesterWindow = requester;
      this.showMenuPopup(payload, requester);
    });

    ipcMain.on('hide-menu-popup', () => {
      this.hideMenuPopup();
    });

    ipcMain.on('menu-popup-action', (event, action: string, payload: any) => {
      const shouldKeepOpen = (action.startsWith('cinema-') && action !== 'cinema-open-drawer') 
        || action === 'toggle-turbo' 
        || action === 'toggle-shield'
        || action === 'vpn-toggle'
        || action === 'vpn-location';

      if (action === 'vpn-toggle') {
        VpnService.toggle(payload).catch((e: any) => console.warn('[UI] Error en vpn-toggle:', e));
      } else if (action === 'vpn-location') {
        VpnService.setLocation(payload).catch((e: any) => console.warn('[UI] Error en vpn-location:', e));
      }

      if (!shouldKeepOpen) {
        this.hideMenuPopup();
      }
      const target = (this.lastRequesterWindow && !this.lastRequesterWindow.isDestroyed())
        ? this.lastRequesterWindow
        : (BrowserWindow.fromWebContents(event.sender) || this.mainWindow);
      if (target && !target.isDestroyed()) {
        target.webContents.send('menu-popup-action', action, payload);
      }
    });

    // ── Tab Hover Card IPC ──
    ipcMain.on('show-hover-card', (event, data: { x: number; y: number; title: string; domain: string; ram: number; isHibernated?: boolean }) => {
      this.showHoverCard(data);
    });

    ipcMain.on('hide-hover-card', () => {
      this.hideHoverCard();
    });
  }
}
