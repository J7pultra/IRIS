import { ipcMain, BrowserWindow, shell, app } from 'electron';
import * as os from 'os';
import { AdBlockService } from './adblock';
import { StorageService } from './storageService';
import { ConcurrentDownloader } from './downloadManager';
import { MediaSniffer } from './mediaSniffer';
import { HardwareEngine } from './hardwareEngine';
import { PrerenderManager } from './prerenderManager';
import { createBrowserWindow, windowModes, windowInitialUrls } from './main';
import { TorService } from './torService';
import { VpnService } from './vpnService';
import * as path from 'path';

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // ── Controles de Ventana (Frameless y Multi-Ventana) ──
  ipcMain.on('window-get-mode-sync', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = (win && !win.isDestroyed()) ? (windowModes.get(win.id) || 'normal') : 'normal';
  });

  ipcMain.on('window-get-initial-url-sync', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = (win && !win.isDestroyed()) ? (windowInitialUrls.get(win.id) || null) : null;
  });

  ipcMain.handle('window-get-mode', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return (win && !win.isDestroyed()) ? (windowModes.get(win.id) || 'normal') : 'normal';
  });

  ipcMain.handle('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.handle('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.unmaximize();
        return false;
      } else {
        win.maximize();
        return true;
      }
    }
    return false;
  });

  ipcMain.handle('window-is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    return win && !win.isDestroyed() ? win.isMaximized() : false;
  });

  ipcMain.handle('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle('window-toggle-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (win && !win.isDestroyed()) {
      const isFs = win.isFullScreen();
      win.setFullScreen(!isFs);
      return !isFs;
    }
    return false;
  });

  ipcMain.handle('window-open-new', (event, mode: 'normal' | 'incognito' | 'tor', url?: string) => {
    createBrowserWindow({ mode, initialUrl: url });
    return true;
  });

  // ── Tor Service IPC ──
  ipcMain.handle('get-tor-status', async (event, forceCheck?: boolean) => {
    return await TorService.getStatus(forceCheck);
  });

  ipcMain.handle('retry-tor-connection', async (event) => {
    const status = await TorService.getStatus(true);
    if (status.connected && status.port) {
      const { session } = require('electron');
      for (const [winId, mode] of windowModes.entries()) {
        if (mode === 'tor') {
          try {
            const torSess = session.fromPartition(`tor-session-${winId}`);
            await torSess.setProxy({
              proxyRules: `socks5://127.0.0.1:${status.port}`,
              proxyBypassRules: '<local>'
            });
            console.log(`[IPC] Proxy Tor reconectado a SOCKS5 127.0.0.1:${status.port} para ventana ${winId}`);
          } catch (e) {
            console.warn('[IPC] Error reconectando proxy Tor:', e);
          }
        }
      }
    }
    return status;
  });

  ipcMain.handle('start-tor-service', async () => {
    return await TorService.startTor();
  });

  // ── VPN de Protección IPC ──
  ipcMain.handle('vpn-get-state', () => {
    return VpnService.getState();
  });

  ipcMain.handle('vpn-toggle', async (event, enabled?: boolean) => {
    return await VpnService.toggle(enabled);
  });

  ipcMain.handle('vpn-set-location', async (event, locationCode: string) => {
    return await VpnService.setLocation(locationCode);
  });

  // ── AdBlock ──
  ipcMain.handle('get-block-stats', () => {
    return AdBlockService.getStats();
  });

  ipcMain.handle('toggle-adblock', (event, domain: string) => {
    return AdBlockService.toggleAllowlist(domain);
  });

  ipcMain.handle('get-adblock-status', (event, domain: string) => {
    return AdBlockService.isBlockerEnabledForDomain(domain);
  });

  ipcMain.handle('get-adblock-update-info', async () => {
    return await AdBlockService.getUpdateInfo();
  });

  ipcMain.handle('check-adblock-updates', async () => {
    return await AdBlockService.checkForUpdates(undefined, true);
  });

  // ── Historial y Marcadores ──
  ipcMain.handle('get-history', () => {
    return StorageService.getHistory();
  });

  ipcMain.handle('clear-history', (event, threshold: number) => {
    StorageService.clearHistory(threshold);
    return true;
  });

  ipcMain.handle('get-bookmarks', () => {
    return StorageService.getBookmarks();
  });

  ipcMain.handle('toggle-bookmark', (event, url: string, title: string) => {
    return StorageService.addBookmark(url, title);
  });

  // ── Descargas ──
  ipcMain.handle('get-downloads', () => {
    return StorageService.getDownloads();
  });

  ipcMain.handle('start-media-download', async (event, payload: {
    url: string;
    audioUrl?: string;
    format: string;
    quality: string;
    title: string;
  }) => {
    try {
      const type = payload.format === 'mp3' ? 'audio_only' : 'video_full';
      return await MediaSniffer.downloadMedia(
        payload.url,
        payload.audioUrl,
        mainWindow,
        payload.title,
        payload.quality,
        payload.format,
        type
      );
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('open-file', (event, filePath: string) => {
    shell.openPath(filePath);
  });

  ipcMain.handle('show-in-folder', (event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // ── Ajustes ──
  ipcMain.handle('get-settings', () => {
    return StorageService.getSettings();
  });

  ipcMain.handle('update-settings', (event, partial: any) => {
    return StorageService.updateSettings(partial);
  });

  // ── Telemetría y RAM Global ──
  ipcMain.handle('get-system-ram', () => {
    const total = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const free = Math.round(os.freemem() / (1024 * 1024 * 1024));
    const used = total - free;
    return {
      usedGb: used,
      totalGb: total,
      label: `RAM: ${used} GB / ${total} GB`
    };
  });

  ipcMain.handle('open-external', (event, url: string) => {
    shell.openExternal(url);
  });

  // ── Modo Turbo & Hardware Engine (Rayito) ──
  ipcMain.handle('get-turbo-status', () => {
    const profile = HardwareEngine.getProfile();
    return {
      enabled: profile?.dynamicModeEnabled ?? true,
      tier: profile?.tier ?? 2,
      cpuCores: profile?.cpuCores ?? os.cpus().length,
      totalRamGB: profile?.totalRamGB ? Math.round(profile.totalRamGB * 10) / 10 : Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      gpuName: profile?.gpuName || 'GPU Acelerada por Hardware'
    };
  });

  ipcMain.handle('toggle-turbo-mode', (event, enabled: boolean) => {
    HardwareEngine.toggleDynamicMode(enabled);
    if (!enabled) {
      PrerenderManager.clearAll();
    }
    return { success: true, enabled };
  });

  ipcMain.on('hover-intent', (event, targetUrl: string, originUrl: string) => {
    const profile = HardwareEngine.getProfile();
    if (profile?.dynamicModeEnabled ?? true) {
      PrerenderManager.handleHoverIntent(targetUrl, originUrl);
    }
  });

  // DNS Prefetch desde la barra de URL mientras el usuario escribe
  ipcMain.on('dns-prefetch', (event, url: string) => {
    const profile = HardwareEngine.getProfile();
    if (profile?.dynamicModeEnabled ?? true) {
      PrerenderManager.prefetchUrl(url);
    }
  });

  // Nota: Los handlers de AI (extract-page-context, extract-form-fields, fill-form-fields),
  //       phantom cache (get-phantom-messages, clear-phantom-messages) y
  //       memoria de pestaña (get-tab-memory) están registrados en ViewManager.registerIpc()
  //       para evitar duplicados que causan crash en Electron.
}
