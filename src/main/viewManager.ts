import { app, BrowserWindow, WebContentsView, ipcMain, webContents } from 'electron';
import { AdBlockService } from './adblock';
import { StorageService } from './storageService';
import { PrerenderManager } from './prerenderManager';
import { HardwareEngine } from './hardwareEngine';
import { MediaSniffer } from './mediaSniffer';
import { PRIVACY_USER_AGENT } from './session';
import { allWindows, windowModes } from './main';
import { TorService } from './torService';
import { CinemaService } from './cinemaService';
import * as path from 'path';

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isHibernated: boolean;
  color?: string;
  category?: string;
  lastAccessed: number;
  isIncognito?: boolean;
  isTor?: boolean;
}

export class ViewManager {
  private mainWindow: BrowserWindow;
  public views: Map<string, WebContentsView> = new Map();
  private tabsMeta: Map<string, TabInfo> = new Map();
  public tabToWindowId: Map<string, number> = new Map();
  public windowActiveTab: Map<number, string> = new Map();
  public windowBounds: Map<number, { x: number; y: number; width: number; height: number }> = new Map();
  public windowHtmlFullScreen: Map<number, boolean> = new Map();
  public activeTabId: string | null = null;
  public isHtmlFullScreen: boolean = false;
  public isAnyMenuOpen: boolean = false;
  public isCinemaDrawerOpen: boolean = false;
  private bounds: { x: number; y: number; width: number; height: number };
  private hibernationTimer: NodeJS.Timeout | null = null;

  public getWindowForTab(id: string): BrowserWindow | null {
    const winId = this.tabToWindowId.get(id);
    if (winId && allWindows.has(winId)) {
      const win = allWindows.get(winId)!;
      if (!win.isDestroyed()) return win;
    }
    return (this.mainWindow && !this.mainWindow.isDestroyed()) ? this.mainWindow : (Array.from(allWindows.values())[0] || null);
  }

  public getWindowFromEvent(event: any): BrowserWindow {
    if (event?.sender) {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) return win;
    }
    return (this.mainWindow && !this.mainWindow.isDestroyed()) ? this.mainWindow : (Array.from(allWindows.values())[0] || this.mainWindow);
  }

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    const [w, h] = this.mainWindow.getContentSize();
    this.bounds = { x: 0, y: 84, width: w, height: Math.max(0, h - 84) };
    this.windowBounds.set(this.mainWindow.id, this.bounds);
    this.registerIpc();
    this.startHibernationManager();
    this.attachWindowFullScreenListeners(mainWindow);
  }

  public attachWindowFullScreenListeners(win: BrowserWindow) {
    win.on('enter-full-screen', () => {
      const isFs = this.windowHtmlFullScreen.get(win.id) || false;
      if (isFs) {
        const [winW, winH] = win.getContentSize();
        const b = { x: 0, y: 0, width: winW, height: winH };
        this.windowBounds.set(win.id, b);
        const activeTab = this.windowActiveTab.get(win.id);
        const view = activeTab ? this.views.get(activeTab) : null;
        if (view) view.setBounds(b);
      }
    });

    win.on('leave-full-screen', () => {
      const isFs = this.windowHtmlFullScreen.get(win.id) || false;
      if (isFs) {
        this.windowHtmlFullScreen.set(win.id, false);
        const [winW, winH] = win.getContentSize();
        const b = { x: 0, y: 84, width: winW, height: Math.max(0, winH - 84) };
        this.windowBounds.set(win.id, b);
        const activeTab = this.windowActiveTab.get(win.id);
        const view = activeTab ? this.views.get(activeTab) : null;
        if (view) view.setBounds(b);
        win.webContents.send('html-fullscreen', false);
      }
    });
  }

  private registerIpc() {
    ipcMain.handle('view-create', (event, id: string, url: string, options?: any) => {
      const win = this.getWindowFromEvent(event);
      return this.createView(id, url, options, win);
    });

    ipcMain.handle('clear-session-data', async (event, options?: { cache?: boolean; cookies?: boolean; storage?: boolean }) => {
      try {
        const { session } = require('electron');
        const betaSession = session.fromPartition('persist:beta-session');
        const storages: any[] = [];
        if (options?.cookies !== false) storages.push('cookies');
        if (options?.storage !== false) storages.push('localstorage', 'indexeddb', 'websql');
        if (options?.cache !== false) storages.push('cache', 'serviceworkers');
        await betaSession.clearStorageData({ storages });
        if (options?.cache !== false) {
          await betaSession.clearCache();
        }
        return true;
      } catch (e) {
        console.error('[Session] Error clearing session data:', e);
        return false;
      }
    });

    ipcMain.handle('view-switch', (event, id: string) => {
      this.switchView(id);
    });

    ipcMain.handle('view-close', (event, id: string) => {
      this.closeView(id);
    });

    ipcMain.handle('view-navigate', (event, id: string, url: string) => {
      this.navigateView(id, url);
    });

    ipcMain.handle('view-update-bounds', (event, bounds: { x: number; y: number; width: number; height: number }) => {
      const win = this.getWindowFromEvent(event);
      this.bounds = bounds;
      this.updateActiveViewBounds(bounds, win);
    });

    ipcMain.handle('menu-state-changed', (event, isOpen: boolean) => {
      this.isAnyMenuOpen = isOpen;
      this.applyMenuBlur(isOpen);
      return true;
    });

    ipcMain.handle('toggle-cinema-drawer', (event, isOpen: boolean) => {
      this.isCinemaDrawerOpen = isOpen;
      this.updateActiveViewBounds();
      return true;
    });

    ipcMain.handle('focus-active-view', (event) => {
      const win = this.getWindowFromEvent(event);
      this.focusActiveView(win);
      return true;
    });

    ipcMain.handle('set-view-visible', (event, id: string, visible: boolean) => {
      const win = this.getWindowForTab(id) || this.getWindowFromEvent(event);
      const view = this.views.get(id);
      if (view && win && !win.isDestroyed()) {
        if (visible) {
          if (!win.contentView.children.includes(view)) {
            win.contentView.addChildView(view);
          }
          this.updateActiveViewBounds(undefined, win);
        } else {
          view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
          if (win.contentView.children.includes(view)) {
            win.contentView.removeChildView(view);
          }
        }
      }
      return true;
    });

    ipcMain.handle('view-go-back', (event, id: string) => {
      const view = this.views.get(id);
      if (view) {
        const wc = view.webContents;
        if (wc.canGoBack()) wc.goBack();
        setTimeout(() => this.emitNavState(id), 50);
      }
    });

    ipcMain.handle('view-go-forward', (event, id: string) => {
      const view = this.views.get(id);
      if (view) {
        const wc = view.webContents;
        if (wc.canGoForward()) wc.goForward();
        setTimeout(() => this.emitNavState(id), 50);
      }
    });

    ipcMain.handle('view-reload', (event, id: string, ignoreCache: boolean = false) => {
      const view = this.views.get(id);
      if (view) {
        if (ignoreCache) view.webContents.reloadIgnoringCache();
        else view.webContents.reload();
        setTimeout(() => this.emitNavState(id), 50);
      }
    });

    ipcMain.handle('view-stop', (event, id: string) => {
      const view = this.views.get(id);
      if (view) {
        view.webContents.stop();
        setTimeout(() => this.emitNavState(id), 50);
      }
    });

    ipcMain.handle('view-get-nav-state', (event, id: string) => {
      const view = this.views.get(id);
      const meta = this.tabsMeta.get(id);
      if (!view || (meta && meta.url.startsWith('beta://'))) {
        return { canGoBack: false, canGoForward: false, isLoading: false };
      }
      const wc = view.webContents;
      return {
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        isLoading: wc.isLoading()
      };
    });

    ipcMain.handle('view-get-history-entries', (event, id: string) => {
      const view = this.views.get(id);
      if (!view) return { entries: [], currentIndex: -1 };
      const nh = (view.webContents as any).navigationHistory;
      if (nh && typeof nh.getAllEntries === 'function') {
        const entries = nh.getAllEntries().map((e: any) => ({
          title: e.title || e.url,
          url: e.url
        }));
        return { entries, currentIndex: nh.getActiveIndex() };
      }
      return { entries: [], currentIndex: -1 };
    });

    ipcMain.handle('view-go-to-offset', (event, id: string, offset: number) => {
      const view = this.views.get(id);
      if (view) {
        const nh = (view.webContents as any).navigationHistory;
        if (nh && typeof nh.goToOffset === 'function') {
          nh.goToOffset(offset);
          setTimeout(() => this.emitNavState(id), 50);
        }
      }
    });

    ipcMain.handle('view-execute-js', async (event, id: string, code: string) => {
      const view = this.views.get(id);
      if (view) {
        try {
          return await view.webContents.executeJavaScript(code);
        } catch (err) {
          console.error('[ViewManager] JS execution failed:', err);
          return null;
        }
      }
    });

    ipcMain.handle('view-set-zoom', (event, id: string, factor: number) => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.setZoomFactor(Math.max(0.25, Math.min(5.0, factor)));
        return true;
      }
      return false;
    });

    ipcMain.handle('view-get-zoom', (event, id: string) => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        return view.webContents.getZoomFactor();
      }
      return 1.0;
    });

    ipcMain.handle('view-print', (event, id: string) => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.print();
        return true;
      }
      return false;
    });

    ipcMain.handle('view-toggle-devtools', (event, id: string) => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        if (view.webContents.isDevToolsOpened()) {
          view.webContents.closeDevTools();
        } else {
          view.webContents.openDevTools({ mode: 'detach' });
        }
        return true;
      }
      return false;
    });

    ipcMain.handle('view-clipboard-action', (event, id: string, action: string) => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        if (action === 'cut') view.webContents.cut();
        else if (action === 'copy') view.webContents.copy();
        else if (action === 'paste') view.webContents.paste();
        else if (action === 'selectAll') view.webContents.selectAll();
        return true;
      }
      return false;
    });

    ipcMain.handle('view-find-in-page', (event, id: string, text: string, options?: any) => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        const isForward = typeof options === 'boolean' ? options : options?.forward !== false;
        const findNext = typeof options === 'object' ? !!options?.findNext : false;
        return view.webContents.findInPage(text, { forward: isForward, findNext });
      }
      return -1;
    });

    ipcMain.handle('view-stop-find-in-page', (event, id: string, action: string = 'clearSelection') => {
      const view = this.views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.stopFindInPage(action as any);
        return true;
      }
      return false;
    });

    // ── Live Memory per Tab (MB) ──
    ipcMain.handle('get-tab-memory', (event, target: string | number) => {
      return this.getTabMemory(target);
    });

    // ── Gemini AI Page & Form Helpers ──
    ipcMain.handle('extract-page-context', async (event, id: string) => {
      return await this.extractPageContext(id);
    });

    ipcMain.handle('extract-form-fields', async (event, id: string) => {
      return await this.extractFormFields(id);
    });

    ipcMain.handle('fill-form-fields', async (event, id: string, instructions: any[]) => {
      return await this.fillFormFields(id, instructions);
    });

    // ── Ojo de Halcón: Guardar mensaje capturado ──
    ipcMain.on('phantom-message-captured', (event, data) => {
      try {
        StorageService.savePhantomMessage(data);
        allWindows.forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('phantom-message-updated', data);
        });
      } catch (e) {
        console.error('[ViewManager] Error guardando phantom message:', e);
      }
    });

    ipcMain.handle('get-phantom-messages', () => {
      return StorageService.getPhantomMessages();
    });

    ipcMain.handle('clear-phantom-messages', () => {
      StorageService.clearPhantomMessages();
      allWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('phantom-message-updated');
      });
      return true;
    });

    ipcMain.handle('delete-phantom-message', (event, id: string) => {
      StorageService.deletePhantomMessage(id);
      allWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('phantom-message-updated');
      });
      return true;
    });

    // ── Estados Guardados (WhatsApp Statuses) ──
    ipcMain.handle('get-saved-statuses', () => {
      return StorageService.getSavedStatuses();
    });

    ipcMain.handle('save-saved-status', (event, status) => {
      StorageService.saveStatus(status);
      allWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('phantom-status-updated', status);
      });
      return true;
    });

    ipcMain.handle('delete-saved-status', (event, id: string) => {
      StorageService.deleteStatus(id);
      allWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('phantom-status-updated');
      });
      return true;
    });

    ipcMain.handle('delete-statuses-by-contact', (event, contact: string) => {
      StorageService.deleteStatusesByContact(contact);
      allWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('phantom-status-updated');
      });
      return true;
    });

    ipcMain.handle('clear-saved-statuses', () => {
      StorageService.clearStatuses();
      allWindows.forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('phantom-status-updated');
      });
      return true;
    });
  }

  public createView(id: string, url: string, options?: { isIncognito?: boolean; isTor?: boolean }, targetWindow?: BrowserWindow): number {
    const win = targetWindow || this.mainWindow;
    const winMode = (win && !win.isDestroyed()) ? (windowModes.get(win.id) || 'normal') : 'normal';
    const isIncognito = !!options?.isIncognito || winMode === 'incognito';
    const isTor = !!options?.isTor || winMode === 'tor';

    if (win && !win.isDestroyed()) {
      this.tabToWindowId.set(id, win.id);
    }

    const preloadPath = path.join(__dirname, '../preload/view-preload.js');
    const partition = isTor
      ? `tor-session-${win.id}`
      : (isIncognito ? `incognito-session-${win.id}` : 'persist:beta-session');

    // ── Tor Proxy & Privacy Config (Patrón Brave con SOCKS5 y Fallback Directo Seguro) ──
    if (isTor) {
      try {
        const { session } = require('electron');
        const torSession = session.fromPartition(partition);
        TorService.configureTorSession(torSession).catch((err: any) => {
          console.warn('[Tor Session] Error en configuración Tor:', err);
        });
      } catch (err) {
        console.error('[Tor Session] Error:', err);
      }
    } else if (isIncognito) {
      try {
        const { session } = require('electron');
        const incSession = session.fromPartition(partition);
        incSession.setUserAgent(PRIVACY_USER_AGENT);
        incSession.setPermissionRequestHandler((wc: any, permission: string, callback: (granted: boolean) => void) => {
          if (permission === 'geolocation' || permission === 'notifications') return callback(false);
          callback(true);
        });
        AdBlockService.enableInSession(incSession);
      } catch {}
    }

    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: true,
        preload: preloadPath,
        partition
      }
    });

    if (isTor) {
      view.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0');
    } else {
      view.webContents.setUserAgent(PRIVACY_USER_AGENT);
    }

    const initialTitle = url === 'beta://nueva-pestana'
      ? (isTor ? 'Nueva Pestaña Tor' : isIncognito ? 'Nueva Pestaña Incógnito' : 'Nueva Pestaña')
      : (url && url.startsWith('beta://')) ? 'Página del Sistema' :
        (url && url !== 'about:blank' ? 'Nueva Pestaña' : 'Nueva Pestaña');

    this.views.set(id, view);
    this.tabsMeta.set(id, {
      id,
      url: url || (isTor ? 'beta://tor' : isIncognito ? 'beta://privada' : 'beta://nueva-pestana'),
      title: initialTitle,
      isHibernated: false,
      lastAccessed: Date.now(),
      isIncognito,
      isTor
    });

    this.attachViewListeners(id, view, win);

    // Si es una url interna de beta://, se maneja en el renderer o cargando plantilla
    if (url && !url.startsWith('beta://') && url !== 'about:blank') {
      if (isTor) {
        TorService.waitUntilReady(60000).then(async (fresh) => {
          if (fresh.connected && fresh.port && win && !win.isDestroyed()) {
            try {
              const { session } = require('electron');
              const torSession = session.fromPartition(partition);
              await torSession.setProxy({ proxyRules: `socks5://127.0.0.1:${fresh.port}`, proxyBypassRules: '<local>' });
            } catch {}
          }
          if (!view.webContents.isDestroyed()) {
            view.webContents.loadURL(url);
          }
        });
      } else {
        view.webContents.loadURL(url);
      }
    }

    return view.webContents.id;
  }

  private attachViewListeners(id: string, view: WebContentsView, targetWin?: BrowserWindow) {
    const wc = view.webContents;
    const getWin = () => (targetWin && !targetWin.isDestroyed()) ? targetWin : (this.getWindowForTab(id) || this.mainWindow);

    // ── BLINDAJE ANTI-POPUNDER Y CONTROL ABSOLUTO DE VENTANAS NATIVAS ──
    // En Electron, si setWindowOpenHandler no está registrado, cualquier window.open() crea una
    // ventana BrowserWindow flotante de escritorio con menús por defecto ("File Edit View...").
    // Regla estricta: NUNCA permitir BrowserWindow nativos para ventanas web ({ action: 'deny' }).
    // Si es un anuncio/popunder, se destruye silenciosamente; si es navegación legítima, se abre como pestaña.
    wc.setWindowOpenHandler((details) => {
      const targetUrl = details.url;
      const currentUrl = wc.getURL();

      // 1. URLs inválidas, scripts o en blanco (tácticas clásicas de apertura de popunders)
      if (!targetUrl || targetUrl === 'about:blank' || targetUrl.startsWith('javascript:') || targetUrl.startsWith('data:')) {
        console.log(`[Shields] Popunder neutralizado en pestaña ${id} (URL en blanco/script)`);
        return { action: 'deny' };
      }

      // 2. Detección profunda de anuncios, trackers y popunders vía Brave Shields / Ghostery
      if (AdBlockService.isAd(targetUrl, currentUrl)) {
        console.log(`[Shields] Popunder / Ventana publicitaria bloqueada en pestaña ${id}: ${targetUrl}`);
        AdBlockService.recordBlocked(targetUrl);
        const win = getWin();
        if (win && !win.isDestroyed()) {
          win.webContents.send('view-event', id, 'ad-blocked', targetUrl);
        }
        return { action: 'deny' };
      }

      // 3. Reglas avanzadas para sitios de streaming, anime y piratería (ej. JKAnime, AnimeFLV, Cuevana)
      try {
        const currHost = new URL(currentUrl).hostname.toLowerCase();
        const isStreaming = /jkanime|animeflv|tioanime|cuevana|pelisplus|repelis|stream|veranime/i.test(currHost);
        if (isStreaming) {
          const destHost = new URL(targetUrl).hostname.toLowerCase();
          const isSameDomain = destHost === currHost || destHost.endsWith('.' + currHost);
          const isTrusted = /discord\.gg|discord\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|t\.me|telegram\.org|youtube\.com|crunchyroll\.com|github\.com/i.test(destHost);

          // Si el sitio de anime intenta abrir un dominio de terceros que no sea de confianza, bloquearlo
          if (!isSameDomain && !isTrusted) {
            console.log(`[Shields] Popunder no confiable bloqueado en streaming (${currHost} -> ${destHost}): ${targetUrl}`);
            AdBlockService.recordBlocked(targetUrl);
            return { action: 'deny' };
          }
        }
      } catch {}

      // 4. Si es una navegación legítima (ej: enlace con target="_blank" confiable o del mismo dominio),
      // abrir como pestaña limpia en el navegador, NUNCA como ventana nativa flotante.
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('view-event', id, 'open-new-tab', targetUrl);
      }

      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, targetUrl) => {
      if (targetUrl.startsWith('file:') && (targetUrl.includes('fb_noscript') || targetUrl.includes('?'))) {
        event.preventDefault();
        return;
      }
    });

    wc.on('did-start-loading', () => {
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'did-start-loading');
      this.emitNavState(id);
    });

    wc.on('did-stop-loading', () => {
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'did-stop-loading');
      this.emitNavState(id);
    });

    wc.on('found-in-page', (event, result) => {
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'found-in-page', result);
    });

    wc.on('did-navigate', (event: any, url: string, httpResponseCode?: number) => {
      const meta = this.tabsMeta.get(id);
      if (meta) {
        meta.url = url;
        meta.lastAccessed = Date.now();
        if (!meta.title || meta.title === 'Nueva Pestaña' || meta.title === 'Cargando...') {
          try {
            meta.title = new URL(url).hostname;
          } catch {
            meta.title = url;
          }
        }
      }
      if (!meta?.isIncognito && !meta?.isTor) {
        StorageService.addHistory(url, meta?.title || url, meta?.favicon);
      }
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'did-navigate', url);
      this.emitNavState(id);

      // Sincronización en vivo de Co-Navegación para todos los participantes
      try {
        if (CinemaService.status.inRoom && CinemaService.status.mode === 'browser' && id === this.activeTabId) {
          if (CinemaService.status.isHost || CinemaService.status.controlMode === 'everyone') {
            if (url && !url.startsWith('beta://') && !url.startsWith('about:') && url !== CinemaService.lastRemoteSyncUrl) {
              CinemaService.lastRemoteSyncUrl = url;
              CinemaService.syncVideoAction({
                type: 'url',
                url: url,
                timestamp: Date.now()
              });
            }
          }
        }
      } catch {}
      if (url.includes('web.whatsapp.com') || url.includes('instagram.com')) {
        this.injectPhantomCache(view);
      }

      // Detección de caída de servidor HTTP 522 / 502 / 504 con cuerpo en blanco (Cloudflare Connection Timed Out)
      if (httpResponseCode && (httpResponseCode === 522 || httpResponseCode === 502 || httpResponseCode === 504) && !url.startsWith('data:') && !url.startsWith('beta:')) {
        setTimeout(async () => {
          if (wc.isDestroyed()) return;
          try {
            const isEmpty = await wc.executeJavaScript('document.body ? (document.body.innerText.trim() === "" && document.body.children.length <= 1) : true');
            if (isEmpty) {
              let domain = url;
              try { domain = new URL(url).hostname; } catch {}
              const isAnime = domain.includes('animeflv') || domain.includes('anime');
              const safeDomain = domain.replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const errorHtml = `
                <!DOCTYPE html>
                <html lang="es">
                <head>
                  <meta charset="utf-8">
                  <title>Error ${httpResponseCode} - Servidor no responde (${safeDomain})</title>
                  <style>
                    body {
                      background: #08080c;
                      color: #f1f5f9;
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      min-height: 100vh;
                      margin: 0;
                      text-align: center;
                      padding: 24px;
                      box-sizing: border-box;
                    }
                    .error-card {
                      background: rgba(18, 18, 26, 0.9);
                      border: 1px solid rgba(255, 255, 255, 0.1);
                      border-radius: 24px;
                      padding: 44px 36px;
                      max-width: 540px;
                      box-shadow: 0 25px 60px rgba(0,0,0,0.8), 0 0 35px rgba(239, 68, 68, 0.15);
                      backdrop-filter: blur(20px);
                    }
                    .error-icon { font-size: 50px; margin-bottom: 16px; }
                    .badge {
                      display: inline-block;
                      background: rgba(239, 68, 68, 0.15);
                      border: 1px solid rgba(239, 68, 68, 0.35);
                      color: #f87171;
                      padding: 5px 14px;
                      border-radius: 12px;
                      font-weight: 800;
                      font-size: 12px;
                      text-transform: uppercase;
                      letter-spacing: 0.5px;
                      margin-bottom: 16px;
                    }
                    h1 { font-size: 22px; font-weight: 800; margin: 0 0 10px 0; color: #fff; }
                    p { font-size: 13.5px; color: #94a3b8; line-height: 1.55; margin: 0 0 26px 0; }
                    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
                    button {
                      background: linear-gradient(135deg, #2563eb, #1d4ed8);
                      color: #fff;
                      border: none;
                      padding: 12px 22px;
                      border-radius: 14px;
                      font-weight: 700;
                      font-size: 13.5px;
                      cursor: pointer;
                      box-shadow: 0 4px 15px rgba(37,99,235,0.3);
                      transition: 0.2s ease;
                      display: inline-flex;
                      align-items: center;
                      gap: 6px;
                    }
                    button:hover { transform: translateY(-2px); opacity: 0.95; }
                    button.alt {
                      background: rgba(255,255,255,0.06);
                      border: 1px solid rgba(255,255,255,0.14);
                      box-shadow: none;
                    }
                    button.alt:hover { background: rgba(255,255,255,0.12); }
                    .suggestion-box {
                      margin-top: 24px;
                      padding-top: 20px;
                      border-top: 1px solid rgba(255,255,255,0.08);
                      text-align: left;
                    }
                    .suggestion-title { font-size: 12px; font-weight: 700; color: #cbd5e1; margin-bottom: 10px; }
                    .suggested-links { display: flex; gap: 8px; flex-wrap: wrap; }
                    .sug-pill {
                      background: rgba(59, 130, 246, 0.12);
                      border: 1px solid rgba(59, 130, 246, 0.25);
                      color: #60a5fa;
                      padding: 6px 14px;
                      border-radius: 20px;
                      font-size: 12px;
                      text-decoration: none;
                      font-weight: 600;
                      transition: 0.2s;
                    }
                    .sug-pill:hover { background: rgba(59, 130, 246, 0.25); }
                  </style>
                </head>
                <body>
                  <div class="error-card">
                    <div class="error-icon">☁️ 🔌</div>
                    <div class="badge">Cloudflare Error ${httpResponseCode}</div>
                    <h1>El servidor de ${safeDomain} no responde</h1>
                    <p>
                      El servidor web de <strong>${safeDomain}</strong> tardó demasiado en responder y la conexión se agotó (Connection Timed Out). Cloudflare no pudo conectar con el servidor de origen porque el sitio está caído, sobrecargado o en mantenimiento.
                    </p>
                    <div class="actions">
                      <button onclick="location.reload()">🔄 Reintentar Carga</button>
                      <button class="alt" onclick="history.back()">⬅ Regresar</button>
                    </div>
                    ${isAnime ? `
                    <div class="suggestion-box">
                      <div class="suggestion-title">🍿 Alternativas de Anime funcionando ahora:</div>
                      <div class="suggested-links">
                        <a href="https://tioanime.com" class="sug-pill">⭐ TioAnime (Online)</a>
                        <a href="https://jkanime.net" class="sug-pill">⚡ JKAnime (Online)</a>
                        <a href="https://animeflv.vc" class="sug-pill">🌐 AnimeFLV Mirror</a>
                      </div>
                    </div>
                    ` : ''}
                  </div>
                </body>
                </html>
              `;
              wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
            }
          } catch {}
        }, 150);
      }
    });

    wc.on('did-navigate-in-page', (event, url) => {
      const meta = this.tabsMeta.get(id);
      if (meta) meta.url = url;
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'did-navigate-in-page', url);
      this.emitNavState(id);

      // Sincronización en vivo de SPA en Co-Navegación
      try {
        if (CinemaService.status.inRoom && CinemaService.status.mode === 'browser' && id === this.activeTabId) {
          if (CinemaService.status.isHost || CinemaService.status.controlMode === 'everyone') {
            if (url && !url.startsWith('beta://') && !url.startsWith('about:') && url !== CinemaService.lastRemoteSyncUrl) {
              CinemaService.lastRemoteSyncUrl = url;
              CinemaService.syncVideoAction({
                type: 'url',
                url: url,
                timestamp: Date.now()
              });
            }
          }
        }
      } catch {}
      if (url.includes('youtube.com')) {
        try {
          const res = wc.executeJavaScript(AdBlockService.getYTDefuserScript());
          if (res && typeof (res as any).catch === 'function') (res as any).catch(() => { });
        } catch { }
      }
      if (url.includes('web.whatsapp.com') || url.includes('instagram.com')) {
        this.injectPhantomCache(view);
      }
    });

    wc.on('page-title-updated', (event, title) => {
      const meta = this.tabsMeta.get(id);
      if (meta) meta.title = title;
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'page-title-updated', title);
    });

    wc.on('page-favicon-updated', (event, favicons) => {
      if (favicons && favicons.length > 0) {
        const meta = this.tabsMeta.get(id);
        if (meta) meta.favicon = favicons[0];
        const win = getWin();
        if (win && !win.isDestroyed()) win.webContents.send('view-event', id, 'page-favicon-updated', favicons[0]);
      }
    });

    // Auto-ocultar popups flotantes al hacer foco en la web
    wc.on('focus', () => {
      try {
        const { uiManager } = require('./main');
        if (uiManager) {
          uiManager.hideDownloadPopup();
          uiManager.hideOmniboxDropdown();
        }
      } catch { }
    });

    // Inyección de estilos cosméticos de AdBlock al dom-ready
    wc.on('dom-ready', () => {
      const currentUrl = wc.getURL();
      if (currentUrl.includes('youtube.com')) {
        try {
          const res = (wc as any).executeJavaScript(AdBlockService.getYTDefuserScript());
          if (res && typeof res.catch === 'function') res.catch(() => { });
        } catch { }
      }
      const cosmetics = AdBlockService.getCosmetics(currentUrl);
      if (cosmetics.styles) {
        try {
          const res = (wc as any).insertCSS(cosmetics.styles);
          if (res && typeof res.catch === 'function') {
            res.catch(() => { });
          }
        } catch { }
      }
      if (cosmetics.scripts) {
        try {
          const res = (wc as any).executeJavaScript(cosmetics.scripts);
          if (res && typeof res.catch === 'function') {
            res.catch(() => { });
          }
        } catch { }
      }

      // Inyección de Ojo de Halcón en WhatsApp e Instagram
      if (currentUrl.includes('web.whatsapp.com') || currentUrl.includes('instagram.com')) {
        this.injectPhantomCache(view);
      }
    });

    // Evasión y manejo correcto de pantalla completa YouTube/HTML5
    wc.on('enter-html-full-screen', () => {
      const win = getWin();
      if (win && !win.isDestroyed()) {
        this.windowHtmlFullScreen.set(win.id, true);
        win.setFullScreen(true);
        const [w, h] = win.getContentSize();
        const b = { x: 0, y: 0, width: w, height: h };
        this.windowBounds.set(win.id, b);
        view.setBounds(b);
        win.webContents.send('html-fullscreen', true);
      }
    });

    wc.on('leave-html-full-screen', () => {
      const win = getWin();
      if (win && !win.isDestroyed()) {
        this.windowHtmlFullScreen.set(win.id, false);
        win.setFullScreen(false);
        const [w, h] = win.getContentSize();
        const b = { x: 0, y: 84, width: w, height: Math.max(0, h - 84) };
        this.windowBounds.set(win.id, b);
        view.setBounds(b);
        win.webContents.send('html-fullscreen', false);
      }
    });

    // Manejo de errores de carga y recuperación automática de proxy
    wc.on('did-fail-load', async (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const meta = this.tabsMeta.get(id);
      console.warn(`[ViewManager] did-fail-load: tab ${id} (${errorCode}) ${errorDescription} on ${validatedURL}`);

      // Si falló por proxy no disponible (ERR_PROXY_CONNECTION_FAILED = -130) en Tor
      if (errorCode === -130 && meta?.isTor) {
        console.log('[ViewManager] Fallo en proxy Tor detectado. Cambiando a modo directo seguro...');
        try {
          const { session } = require('electron');
          const win = getWin();
          if (win) {
            const torSession = session.fromPartition(`tor-session-${win.id}`);
            await torSession.setProxy({ proxyRules: 'direct://' });
            setTimeout(() => {
              if (!wc.isDestroyed() && validatedURL) {
                wc.loadURL(validatedURL);
              }
            }, 300);
          }
        } catch (e) {
          console.error('[ViewManager] Error recuperando proxy Tor:', e);
        }
      }
    });
  }

  public switchView(id: string) {
    try {
      const { uiManager } = require('./main');
      if (uiManager) {
        uiManager.hideDownloadPopup();
        uiManager.hideOmniboxDropdown();
      }
    } catch { }

    const win = this.getWindowForTab(id) || this.mainWindow;
    if (!win || win.isDestroyed()) return;

    // 1. Remover y colapsar absolutamente todas las demás vistas pertenecientes a este win
    for (const [viewId, v] of this.views.entries()) {
      if (viewId !== id && this.tabToWindowId.get(viewId) === win.id) {
        if (win.contentView.children.includes(v)) {
          win.contentView.removeChildView(v);
        }
        v.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    }

    this.windowActiveTab.set(win.id, id);
    if (win === this.mainWindow) {
      this.activeTabId = id;
    }
    const newView = this.views.get(id);
    const meta = this.tabsMeta.get(id);

    if (newView && meta) {
      meta.lastAccessed = Date.now();

      // Si la URL es interna (beta://), no superponemos la vista nativa
      if (meta.url.startsWith('beta://')) {
        if (win.contentView.children.includes(newView)) {
          win.contentView.removeChildView(newView);
        }
        newView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        win.webContents.send('view-event', id, 'show-internal-page', meta.url);
        this.emitNavState(id);
        return;
      }

      // Si estaba hibernada, despertarla
      if (meta.isHibernated) {
        console.log(`[ViewManager] Despertando pestaña ${id} de hibernación...`);
        meta.isHibernated = false;
        newView.webContents.loadURL(meta.url);
        win.webContents.send('view-event', id, 'tab-woke-up');
      }

      if (!win.contentView.children.includes(newView)) {
        win.contentView.addChildView(newView);
      }
      this.updateActiveViewBounds(undefined, win);
      if (!meta.url.startsWith('beta://')) {
        newView.webContents.focus();
      }
      this.emitNavState(id);
    }
  }

  public emitNavState(id: string) {
    const win = this.getWindowForTab(id) || this.mainWindow;
    if (!win || win.isDestroyed()) return;

    const view = this.views.get(id);
    const meta = this.tabsMeta.get(id);

    if (!view || (meta && meta.url.startsWith('beta://'))) {
      win.webContents.send('nav-state-changed', {
        tabId: id,
        canGoBack: false,
        canGoForward: false,
        isLoading: false
      });
      return;
    }

    const wc = view.webContents;
    win.webContents.send('nav-state-changed', {
      tabId: id,
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      isLoading: wc.isLoading()
    });
  }

  public closeView(id: string) {
    const win = this.getWindowForTab(id) || this.mainWindow;
    const view = this.views.get(id);
    if (view) {
      if (win && !win.isDestroyed() && win.contentView.children.includes(view)) {
        win.contentView.removeChildView(view);
      }
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      if (win && this.windowActiveTab.get(win.id) === id) {
        this.windowActiveTab.delete(win.id);
      }
      if (this.activeTabId === id) {
        this.activeTabId = null;
      }
      try {
        (view.webContents as any).destroy();
      } catch { }
      this.views.delete(id);
      this.tabsMeta.delete(id);
      this.tabToWindowId.delete(id);
    }
  }

  public async navigateView(id: string, url: string) {
    const win = this.getWindowForTab(id) || this.mainWindow;
    const meta = this.tabsMeta.get(id);
    if (meta) {
      meta.url = url;
      meta.lastAccessed = Date.now();
    }

    const view = this.views.get(id);
    if (!view) return;

    if (url.startsWith('beta://')) {
      if (win && !win.isDestroyed() && win.contentView.children.includes(view)) {
        win.contentView.removeChildView(view);
      }
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      if (win && !win.isDestroyed()) {
        win.webContents.send('view-event', id, 'show-internal-page', url);
      }
      return;
    }

    // Si es una pestaña Tor, asegurar que Tor esté en ejecución y conectado al 100% antes de navegar
    if (meta?.isTor) {
      const status = await TorService.getStatus();
      if (!status.connected || (status.bootstrapProgress !== undefined && status.bootstrapProgress < 100)) {
        console.log(`[ViewManager] Esperando a que el circuito Tor alcance el 100% antes de navegar a ${url} (actual: ${status.bootstrapProgress || 0}%)...`);

        // 1. Notificar al renderer para mostrar la pantalla de conexión en vivo con barra de progreso
        if (win && !win.isDestroyed()) {
          win.webContents.send('tor-connecting-start', {
            tabId: id,
            targetUrl: url,
            progress: status.bootstrapProgress || 0
          });
        }

        // 2. Mantener la vista web oculta/desmontada mientras Tor conecta para que la pantalla de carga sea visible
        if (win && !win.isDestroyed() && win.contentView.children.includes(view)) {
          win.contentView.removeChildView(view);
        }
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

        // 3. Esperar activamente hasta que el circuito Tor alcance el 100% (hasta 60s)
        const readyStatus = await TorService.waitUntilReady(60000);

        if (win && !win.isDestroyed()) {
          try {
            const { session } = require('electron');
            const torSession = session.fromPartition(`tor-session-${win.id}`);
            const freshPort = readyStatus.port || 9050;
            await torSession.setProxy({
              proxyRules: `socks5://127.0.0.1:${freshPort}`,
              proxyBypassRules: '<local>'
            });
            console.log(`[ViewManager] Proxy Tor confirmado al 100% en SOCKS5 127.0.0.1:${freshPort} ✓`);
          } catch (e) {
            console.warn('[ViewManager] Error aplicando proxy antes de navegar:', e);
          }
        }

        // 4. Notificar al renderer que el circuito está 100% listo para cerrar la pantalla de conexión
        if (win && !win.isDestroyed()) {
          win.webContents.send('tor-connecting-finish', {
            tabId: id,
            targetUrl: url
          });
        }
      }
    }

    // Si viene de una página interna a una web real, asegurar que se agregue a la ventana
    const currentActive = win ? this.windowActiveTab.get(win.id) : null;
    if (currentActive === id || this.activeTabId === id) {
      if (win && !win.isDestroyed() && !win.contentView.children.includes(view)) {
        win.contentView.addChildView(view);
      }
      this.updateActiveViewBounds(undefined, win);
    }

    // ── TURBO: Intentar swap de vista especulativa prerenderizada (0ms) ──
    const prerenderedView = PrerenderManager.getPrerenderedView(url);
    if (prerenderedView && !prerenderedView.webContents.isDestroyed()) {
      try {
        if (win && !win.isDestroyed() && win.contentView.children.includes(view)) {
          win.contentView.removeChildView(view);
        }
        (view.webContents as any).destroy();
      } catch { }

      this.views.set(id, prerenderedView);
      this.attachViewListeners(id, prerenderedView, win);

      if (win && !win.isDestroyed() && !win.contentView.children.includes(prerenderedView)) {
        win.contentView.addChildView(prerenderedView);
      }
      this.updateActiveViewBounds(undefined, win);
      const b = win ? (this.windowBounds.get(win.id) || this.bounds) : this.bounds;
      prerenderedView.setBounds(b);

      const finalUrl = prerenderedView.webContents.getURL() || url;
      if (win && !win.isDestroyed()) {
        win.webContents.send('view-event', id, 'did-navigate', finalUrl);
        win.webContents.send('view-event', id, 'page-title-updated', prerenderedView.webContents.getTitle() || '');
      }
      this.emitNavState(id);
      return;
    }

    view.webContents.loadURL(url);
    if (currentActive === id || this.activeTabId === id) {
      view.webContents.focus();
    }
  }

  public focusActiveView(targetWin?: BrowserWindow) {
    const win = targetWin || this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const activeTab = this.windowActiveTab.get(win.id) || (win === this.mainWindow ? this.activeTabId : null);
    if (!activeTab) return;
    const view = this.views.get(activeTab);
    const meta = this.tabsMeta.get(activeTab);
    if (view && view.webContents && !view.webContents.isDestroyed() && (!meta || !meta.url.startsWith('beta://'))) {
      view.webContents.focus();
    }
  }

  public updateActiveViewBounds(customBounds?: { x: number; y: number; width: number; height: number }, targetWin?: BrowserWindow) {
    const win = targetWin || this.mainWindow;
    if (!win || win.isDestroyed()) return;

    let b = customBounds;
    if (!b) {
      const [w, h] = win.getContentSize();
      const isFs = this.windowHtmlFullScreen.get(win.id) || false;
      const rightOffset = (win === this.mainWindow && this.isCinemaDrawerOpen) ? 380 : 0;
      const topOffset = isFs ? 0 : 84;
      b = {
        x: 0,
        y: topOffset,
        width: Math.max(320, w - rightOffset),
        height: isFs ? h : Math.max(0, h - topOffset)
      };
    }
    this.windowBounds.set(win.id, b);
    if (win === this.mainWindow) {
      this.bounds = b;
    }

    const activeTab = this.windowActiveTab.get(win.id) || (win === this.mainWindow ? this.activeTabId : null);
    if (!activeTab) return;
    const view = this.views.get(activeTab);
    const meta = this.tabsMeta.get(activeTab);
    if (view && meta && !meta.url.startsWith('beta://')) {
      if (typeof (view as any).setVisible === 'function') {
        (view as any).setVisible(true);
      }
      view.setBounds(b);
    }
  }

  public getTabsCountForWindow(winId: number): number {
    let count = 0;
    for (const [, wId] of this.tabToWindowId.entries()) {
      if (wId === winId) count++;
    }
    return count;
  }

  public handleWindowClosed(winId: number) {
    const tabsToClose: string[] = [];
    for (const [tabId, wId] of this.tabToWindowId.entries()) {
      if (wId === winId) tabsToClose.push(tabId);
    }
    for (const tabId of tabsToClose) {
      this.closeView(tabId);
    }
    this.windowActiveTab.delete(winId);
    this.windowBounds.delete(winId);
    this.windowHtmlFullScreen.delete(winId);

    const mode = windowModes.get(winId);
    if (mode === 'incognito' || mode === 'tor') {
      try {
        const { session } = require('electron');
        const sess = session.fromPartition(`${mode}-session-${winId}`);
        sess.clearStorageData().catch(() => {});
        sess.clearCache().catch(() => {});
      } catch {}
    }
  }

  public applyMenuBlur(isOpen: boolean) {
    if (!this.activeTabId) return;
    const view = this.views.get(this.activeTabId);
    if (!view || view.webContents.isDestroyed()) return;
    const meta = this.tabsMeta.get(this.activeTabId);
    if (meta && meta.url.startsWith('beta://')) return;

    if (isOpen) {
      view.webContents.executeJavaScript(`
        (function() {
          let el = document.getElementById('navegadorbeta-menu-blur-overlay');
          if (!el) {
            el = document.createElement('div');
            el.id = 'navegadorbeta-menu-blur-overlay';
            el.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;background:rgba(8,8,14,0.45)!important;backdrop-filter:blur(8px) brightness(0.7)!important;-webkit-backdrop-filter:blur(8px) brightness(0.7)!important;z-index:2147483640!important;pointer-events:none!important;transition:opacity 0.18s cubic-bezier(0.16,1,0.3,1)!important;opacity:0!important;';
            (document.body || document.documentElement).appendChild(el);
            requestAnimationFrame(() => { el.style.opacity = '1'; });
          } else {
            el.style.opacity = '1';
          }
        })();
      `).catch(() => {});
    } else {
      view.webContents.executeJavaScript(`
        (function() {
          const el = document.getElementById('navegadorbeta-menu-blur-overlay');
          if (el) {
            el.style.opacity = '0';
            setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, 180);
          }
        })();
      `).catch(() => {});
    }
  }

  // ── Hibernación Inteligente de Pestañas ──
  private startHibernationManager() {
    this.hibernationTimer = setInterval(() => {
      const settings = StorageService.getSettings();
      if (!settings.hibernationEnabled) return;

      const now = Date.now();
      const timeoutMs = (settings.hibernationTimeoutMinutes || 15) * 60 * 1000;

      this.tabsMeta.forEach((meta, id) => {
        if (id === this.activeTabId) return; // Pestaña activa nunca se hiberna
        if (meta.isHibernated) return;
        if (meta.url.startsWith('beta://')) return;

        const idle = now - meta.lastAccessed;
        if (idle > timeoutMs) {
          console.log(`[ViewManager] Hibernando pestaña inactiva ${id} (${meta.title}) para liberar memoria.`);
          meta.isHibernated = true;
          const view = this.views.get(id);
          if (view) {
            view.webContents.loadURL('about:blank');
          }
          this.mainWindow.webContents.send('view-event', id, 'tab-hibernated');
        }
      });
    }, 45000);
  }

  // ── Live Memory Por Pestaña ──
  public getTabMemory(target: string | number): number {
    try {
      let pid: number | undefined;
      if (typeof target === 'number') {
        const wc = webContents.fromId(target);
        if (wc) pid = wc.getOSProcessId();
      } else if (typeof target === 'string') {
        const view = this.views.get(target);
        if (view) pid = view.webContents.getOSProcessId();
      }
      if (!pid) return 0;

      const metrics = app.getAppMetrics();
      const tabMetric = metrics.find(m => m.pid === pid);
      if (tabMetric) {
        // Retorna memoria en Megabytes redondeada a 1 decimal
        const kb = tabMetric.memory.workingSetSize || tabMetric.memory.privateBytes || 0;
        return Math.round((kb / 1024) * 10) / 10;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  // ── Inyección de Ojo de Halcón ──
  private async injectPhantomCache(view: WebContentsView) {
    try {
      const phantomScript = await require('fs').promises.readFile(
        path.join(__dirname, '../inject/phantom_cache.js'),
        'utf-8'
      );
      view.webContents.executeJavaScript(phantomScript).catch(e => {
        console.warn('[ViewManager] Error inyectando phantom_cache:', e);
      });
    } catch (e) {
      console.warn('[ViewManager] No se encontró phantom_cache.js:', e);
    }
  }

  // ── Gemini AI: Extracción de Contexto ──
  public async extractPageContext(tabId: string): Promise<string> {
    const view = this.views.get(tabId);
    if (!view) return '';

    try {
      const context = await view.webContents.executeJavaScript(`
        (function() {
          const title = document.title || '';
          const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
          const h1 = Array.from(document.querySelectorAll('h1')).map(h => h.innerText).slice(0, 3).join(' | ');
          
          // Si es YouTube, extraer info del video
          if (window.location.hostname.includes('youtube.com')) {
            const ytTitle = document.querySelector('h1.ytd-watch-metadata')?.innerText || title;
            const channel = document.querySelector('#owner #channel-name')?.innerText || '';
            const desc = document.querySelector('#description-inline-expander')?.innerText || '';
            return \`[Video de YouTube]\\nTítulo: \${ytTitle}\\nCanal: \${channel}\\nDescripción: \${desc.slice(0, 1500)}\`;
          }

          // Texto principal de la página (eliminando scripts, nav, footer)
          const clone = document.body.cloneNode(true);
          ['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg', 'iframe'].forEach(tag => {
            clone.querySelectorAll(tag).forEach(el => el.remove());
          });
          const text = clone.innerText.replace(/\\s+/g, ' ').trim().slice(0, 4000);
          return \`Título: \${title}\\nEncabezados: \${h1}\\nDescripción: \${metaDesc}\\nContenido Principal: \${text}\`;
        })()
      `);
      return context || '';
    } catch (e) {
      console.error('[ViewManager] Error extrayendo contexto:', e);
      return '';
    }
  }

  // ── Gemini AI: Auto-Relleno de Formularios ──
  public async extractFormFields(tabId: string): Promise<any[]> {
    const view = this.views.get(tabId);
    if (!view) return [];

    try {
      return await view.webContents.executeJavaScript(`
        (function() {
          const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
          const fields = [];
          inputs.forEach((el, index) => {
            let labelText = '';
            if (el.id) {
              const label = document.querySelector('label[for="' + el.id + '"]');
              if (label) labelText = label.innerText;
            }
            if (!labelText && el.closest('label')) {
              labelText = el.closest('label').innerText;
            }
            fields.push({
              id: el.id || el.name || 'field_' + index,
              name: el.name || '',
              type: el.tagName.toLowerCase() === 'input' ? (el.type || 'text') : el.tagName.toLowerCase(),
              label: (labelText || el.placeholder || el.name || 'Campo sin etiqueta').trim()
            });
          });
          return fields;
        })()
      `);
    } catch (e) {
      console.error('[ViewManager] Error extrayendo campos de formulario:', e);
      return [];
    }
  }

  public async fillFormFields(tabId: string, instructions: any[]): Promise<boolean> {
    const view = this.views.get(tabId);
    if (!view || !instructions || instructions.length === 0) return false;

    try {
      await view.webContents.executeJavaScript(`
        (function(instructions) {
          instructions.forEach(inst => {
            let el = document.getElementById(inst.id);
            if (!el && inst.name) el = document.getElementsByName(inst.name)[0];
            if (!el) {
              const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
              el = inputs.find(i => (i.id && i.id.includes(inst.id)) || (i.name && i.name.includes(inst.id)));
            }

            if (el) {
              if (inst.action === 'fill' || inst.action === 'select') {
                el.value = inst.value;
              } else if (inst.action === 'check') {
                el.checked = true;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          return true;
        })(${JSON.stringify(instructions)})
      `);
      return true;
    } catch (e) {
      console.error('[ViewManager] Error rellenando formulario:', e);
      return false;
    }
  }

  public getActiveTabId(): string | null {
    return this.activeTabId;
  }

  public findTabIdByWebContentsId(id: number): string | null {
    for (const [tabId, view] of this.views.entries()) {
      if (view.webContents && view.webContents.id === id) {
        return tabId;
      }
    }
    return null;
  }

  public getAllTabs(): { tabId: string; url: string; title: string }[] {
    const list: { tabId: string; url: string; title: string }[] = [];
    this.tabsMeta.forEach((meta, tabId) => {
      list.push({
        tabId,
        url: meta.url || '',
        title: meta.title || meta.url || 'Pestaña'
      });
    });
    return list;
  }
}
