/**
 * main.ts — Punto de entrada del proceso principal de NavegadorBeta
 * Fusión de lo mejor de Will Browser (UI Svelte/Gemini) y ShieldBrowser (Motor de Red/AdBlock/DRM/Hibernación).
 */

import { app, BrowserWindow, protocol, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AdBlockService } from './adblock';
import { configurePrivacySession } from './session';
import { registerIpcHandlers } from './ipc';
import { ViewManager } from './viewManager';
import { StorageService } from './storageService';
import { PrerenderManager } from './prerenderManager';
import { HardwareEngine } from './hardwareEngine';
import { WidevineManager } from './widevine';
import { MediaSniffer } from './mediaSniffer';
import { UiManager } from './uiManager';
import { CinemaService } from './cinemaService';
import { TorService } from './torService';
import { VpnService } from './vpnService';

// Prioridad alta en el sistema para fluidez máxima
try {
  os.setPriority(os.constants.priority.PRIORITY_HIGH);
} catch { }

// Optimización de switches de red y Chromium (siempre activos)
app.commandLine.appendSwitch('enable-tcp-fastopen');           // TCP Fast Open: reduce latencia en conexiones repetidas
app.commandLine.appendSwitch('enable-quic');                   // HTTP/3 QUIC: conexión más rápida y resiliente en mala red
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,WebAuthenticationConditionalUI,WebAuthnConditionalUI');
app.commandLine.appendSwitch('disable-accelerated-video-encode'); // Evita error de Mojo Video Encode Accelerator en Windows
app.commandLine.appendSwitch('enable-features',
  'ParallelDownloading,LazyFrameLoading,LazyImageLoading,BackForwardCache,PrefetchPrivacyChanges'
);
app.commandLine.appendSwitch('max-active-webgl-contexts', '16');
// Sockets paralelos máximos por proxy (default Chrome = 6, subimos a 15)
app.commandLine.appendSwitch('max-connections-per-proxy', '15');
// Pre-resolver DNS agresivamente
app.commandLine.appendSwitch('host-resolver-rules', ''); // Sin reglas custom, pero activa el resolver rápido

// Switches de privacidad
const privacySwitches = [
  'disable-component-update',
  'disable-background-networking',
  'disable-domain-reliability',
  'no-pings',
  'disable-sync',
  'disable-translate'
];
privacySwitches.forEach(sw => app.commandLine.appendSwitch(sw));
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// Inicializar Widevine antes del ready
WidevineManager.initBeforeReady();

// Aplicar flags de aceleración por hardware
HardwareEngine.applyBootSwitches();

export let mainWindow: BrowserWindow | null = null;
export let viewManager: ViewManager | null = null;
export let uiManager: UiManager | null = null;
export const allWindows: Map<number, BrowserWindow> = new Map();
export const windowModes: Map<number, 'normal' | 'incognito' | 'tor'> = new Map();
export const windowInitialUrls: Map<number, string> = new Map();

export function createBrowserWindow(options?: { mode?: 'normal' | 'incognito' | 'tor'; initialUrl?: string }): BrowserWindow {
  const mode = options?.mode || 'normal';
  const preloadPath = path.join(__dirname, '../preload/preload.js');
  const isIncognito = mode === 'incognito';
  const isTor = mode === 'tor';

  const bgColor = isTor ? '#140e24' : isIncognito ? '#13111c' : '#0d0d12';
  const windowTitle = isTor
    ? 'NavegadorBeta — Ventana Privada con Tor 🧅'
    : isIncognito
    ? 'NavegadorBeta — Ventana de Incógnito 🕶️'
    : 'NavegadorBeta';

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 840,
    minHeight: 580,
    frame: false,
    backgroundColor: bgColor,
    title: windowTitle,
    show: false,
    titleBarStyle: 'hidden',
    icon: fs.existsSync(path.join(__dirname, '../assets/icons/icon.ico'))
      ? path.join(__dirname, '../assets/icons/icon.ico')
      : path.join(__dirname, '../../assets/icons/icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  allWindows.set(win.id, win);
  windowModes.set(win.id, mode);
  if (options?.initialUrl) {
    windowInitialUrls.set(win.id, options.initialUrl);
  }
  if (!mainWindow) mainWindow = win;

  // Carga bajo demanda (Lazy Loading): Solo iniciar tor.exe si el usuario realmente abre una ventana Tor
  if (isTor) {
    TorService.startTor().catch((err: any) => console.warn('[TorService] Error iniciando Tor bajo demanda:', err));
  }

  const queryParams: Record<string, string> = { mode };
  if (options?.initialUrl) {
    queryParams.url = options.initialUrl;
  }

  win.loadFile(path.join(__dirname, '../renderer/index.html'), {
    query: queryParams,
    search: '?' + new URLSearchParams(queryParams).toString()
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('resize', () => {
    if (viewManager) viewManager.updateActiveViewBounds(undefined, win);
  });

  if (viewManager) {
    viewManager.attachWindowFullScreenListeners(win);
  }

  let isForceClosing = false;
  win.on('close', async (e) => {
    if (isForceClosing) return;
    if (!viewManager) return;

    const tabCount = viewManager.getTabsCountForWindow(win.id);
    const settings = StorageService.getSettings();
    const shouldWarn = settings.warnOnCloseMultipleTabs !== false;

    if (tabCount > 1 && shouldWarn) {
      e.preventDefault();
      try {
        const { uiManager: uiMgr } = require('./main');
        if (uiMgr) {
          const res = await uiMgr.showCloseConfirmationDialog(win, tabCount);
          if (res && res.confirmed) {
            if (res.dontAskAgain) {
              StorageService.updateSettings({ warnOnCloseMultipleTabs: false });
            }
            isForceClosing = true;
            win.close();
          }
        } else {
          isForceClosing = true;
          win.close();
        }
      } catch (err) {
        console.warn('[WindowClose] Error en confirmación de cierre:', err);
        isForceClosing = true;
        win.close();
      }
    }
  });

  win.on('closed', () => {
    allWindows.delete(win.id);
    windowModes.delete(win.id);
    windowInitialUrls.delete(win.id);
    if (viewManager) viewManager.handleWindowClosed(win.id);
    if (mainWindow && mainWindow.id === win.id) {
      const remaining = Array.from(allWindows.values())[0];
      mainWindow = remaining || null;
    }

    // Si ya no queda ninguna ventana Tor abierta, apagar tor.exe de inmediato para liberar el 100% de la RAM
    const hasTorWindow = Array.from(windowModes.values()).some(m => m === 'tor');
    if (!hasTorWindow) {
      TorService.stopTor();
    }
  });

  return win;
}

// Bloqueo de instancia única para evitar colisiones de caché y pérdida de sesiones (WhatsApp Web / IndexedDB)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[NavegadorBeta] Instancia secundaria detectada. Enfocando ventana principal...');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    console.log('[NavegadorBeta] Arrancando núcleo del navegador...');

    // 1. Inicializar almacenamiento
    await StorageService.init();

    // 2. Configurar sesión segura (tanto la predeterminada de Electron para la UI/embeds como persist:beta-session para pestañas)
    configurePrivacySession(session.defaultSession);
    const betaSession = session.fromPartition('persist:beta-session');
    configurePrivacySession(betaSession);

    // 3. Inicializar motor de AdBlock uBlock/Ghostery
    await AdBlockService.init(betaSession);

    // 4. Preparar Widevine DRM
    await WidevineManager.ensureWidevineReady();

    // 5. Crear ventana principal
    mainWindow = createBrowserWindow({ mode: 'normal' });

    // 6. Inicializar gestores
    viewManager = new ViewManager(mainWindow);
    uiManager = new UiManager(mainWindow);
    CinemaService.initialize(mainWindow);
    PrerenderManager.init(betaSession);
    MediaSniffer.init(mainWindow);
    registerIpcHandlers(mainWindow);
    VpnService.init();

    // 7. Escuchar progreso de Tor y retransmitir en tiempo real a las ventanas activas
    TorService.onProgress((progress, summary) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('tor-bootstrap-progress', { progress, summary });
        }
      }
    });

    console.log('[NavegadorBeta] Sistema listo y operativo ✓');
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    VpnService.onAppClosing();
  });

  app.on('will-quit', () => {
    VpnService.onAppClosing();
    TorService.stopTor();
  });
}
