import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { app, Session } from 'electron';
import { AdBlockService } from './adblock';

export interface TorStatus {
  connected: boolean;
  port: number | null;
  mode: 'socks5' | 'direct';
  message: string;
  hasBinary: boolean;
  binaryPath?: string;
  bootstrapProgress?: number;
}

export class TorService {
  private static activePort: number | null = null;
  private static torProcess: ChildProcess | null = null;
  private static cachedStatus: TorStatus | null = null;
  private static lastCheckTime: number = 0;
  private static bootstrapProgress: number = 0;
  private static isStarting: boolean = false;
  private static progressListeners: Array<(progress: number, summary: string) => void> = [];

  /**
   * Registra un listener para recibir actualizaciones de progreso en tiempo real del circuito Tor (0-100%)
   */
  public static onProgress(listener: (progress: number, summary: string) => void): () => void {
    this.progressListeners.push(listener);
    return () => {
      this.progressListeners = this.progressListeners.filter(l => l !== listener);
    };
  }

  private static emitProgress(progress: number, summary: string) {
    for (const listener of this.progressListeners) {
      try { listener(progress, summary); } catch {}
    }
  }

  /**
   * Comprueba si un puerto TCP local está aceptando conexiones SOCKS5
   */
  public static isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 600): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let finished = false;

      const finish = (result: boolean) => {
        if (!finished) {
          finished = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));

      try {
        socket.connect(port, host);
      } catch {
        finish(false);
      }
    });
  }

  /**
   * Detecta si hay un demonio Tor activo en los puertos estándar (9050 o 9150)
   */
  public static async detectTorPort(): Promise<number | null> {
    if (await this.isPortOpen(9050)) return 9050;
    if (await this.isPortOpen(9150)) return 9150;
    return null;
  }

  /**
   * Busca el binario tor.exe integrado en el proyecto o en el sistema
   */
  public static findTorBinary(): string | null {
    try {
      const appPath = (typeof app?.getAppPath === 'function') ? app.getAppPath() : process.cwd();
      const candidates = [
        path.join(__dirname, '../../bin/tor/tor/tor.exe'),
        path.join(__dirname, '../bin/tor/tor/tor.exe'),
        path.join(process.resourcesPath || '', 'bin/tor/tor/tor.exe'),
        path.join(appPath, 'bin/tor/tor/tor.exe'),
        path.join(process.cwd(), 'bin/tor/tor/tor.exe'),
        path.join(process.cwd(), 'navegadorbeta/bin/tor/tor/tor.exe'),
        path.join(appPath, 'bin/tor.exe'),
        path.join(process.cwd(), 'bin/tor.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(os.homedir(), 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
        path.join(os.homedir(), 'Downloads', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe')
      ];

      for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
      }
    } catch (e) {
      console.warn('[TorService] Error buscando binario tor:', e);
    }
    return null;
  }

  /**
   * Obtiene el estado actual de la conexión Tor
   */
  public static async getStatus(forceCheck = false): Promise<TorStatus> {
    const now = Date.now();
    if (!forceCheck && this.cachedStatus && (now - this.lastCheckTime < 1000)) {
      return this.cachedStatus;
    }

    const port = await this.detectTorPort();
    const binary = this.findTorBinary();

    if (port) {
      this.activePort = port;
      const isReady = this.torProcess ? (this.bootstrapProgress === 100) : true;
      this.cachedStatus = {
        connected: isReady,
        port,
        mode: 'socks5',
        message: isReady
          ? `Conectado a la Red Tor (Proxy SOCKS5 en 127.0.0.1:${port})`
          : `Estableciendo circuito Tor (${this.bootstrapProgress}%)...`,
        hasBinary: !!binary,
        binaryPath: binary || undefined,
        bootstrapProgress: this.torProcess ? this.bootstrapProgress : 100
      };
    } else {
      this.activePort = null;
      this.cachedStatus = {
        connected: false,
        port: null,
        mode: 'direct',
        message: binary
          ? (this.isStarting ? `Iniciando Tor (${this.bootstrapProgress}%)...` : 'Demonio Tor disponible. Listo para conectar.')
          : 'Demonio Tor no detectado en puertos 9050 o 9150.',
        hasBinary: !!binary,
        binaryPath: binary || undefined,
        bootstrapProgress: this.bootstrapProgress
      };
    }

    this.lastCheckTime = now;
    return this.cachedStatus;
  }

  /**
   * Inicia el demonio tor.exe en segundo plano con optimización de caché en disco y modo cliente
   */
  public static async startTor(): Promise<TorStatus> {
    const existingPort = await this.detectTorPort();
    if (existingPort) {
      this.activePort = existingPort;
      // Si nosotros iniciamos el proceso pero aún no termina de conectar, esperar activamente hasta el 100%
      if (this.torProcess && this.bootstrapProgress < 100) {
        for (let i = 0; i < 200; i++) {
          await new Promise((r) => setTimeout(r, 200));
          if (this.bootstrapProgress === 100) break;
        }
      }
      return this.getStatus(true);
    }

    const binary = this.findTorBinary();
    if (!binary) {
      console.warn('[TorService] No se encontró el binario tor.exe.');
      return this.getStatus(true);
    }

    if (this.isStarting && this.torProcess) {
      // Ya se está iniciando: esperar hasta que esté al 100%
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (this.activePort && this.bootstrapProgress === 100) break;
      }
      return this.getStatus(true);
    }

    this.isStarting = true;
    this.bootstrapProgress = 5;
    this.emitProgress(5, 'Iniciando demonio...');

    try {
      const userDir = (typeof app?.getPath === 'function') ? app.getPath('userData') : path.join(process.cwd(), '.temp_user_data');
      const dataDir = path.join(userDir, 'tor_data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const binDir = path.dirname(binary);
      const geoip = path.join(binDir, '..', 'data', 'geoip');
      const geoip6 = path.join(binDir, '..', 'data', 'geoip6');

      // Optimización de argumentos: permitir caché en disco (DataDirectory) para que los arranques
      // posteriores sean ultrarrápidos (~1-2 seg) al no tener que descargar el consenso completo.
      const args = [
        '--SocksPort', '9050',
        '--DataDirectory', dataDir,
        '--ExitRelay', '0',
        '--ClientOnly', '1',
        '--KeepalivePeriod', '60',
        '--LearnCircuitBuildTimeout', '1',
        '--NumEntryGuards', '3'
      ];

      if (fs.existsSync(geoip)) {
        args.push('--GeoIPFile', geoip);
      }
      if (fs.existsSync(geoip6)) {
        args.push('--GeoIPv6File', geoip6);
      }

      console.log(`[TorService] Ejecutando: ${binary} con SocksPort 9050...`);
      this.torProcess = spawn(binary, args, {
        detached: false,
        windowsHide: true,
        stdio: 'pipe'
      });

      if (this.torProcess.stdout) {
        this.torProcess.stdout.on('data', (d) => {
          const text = d.toString();
          const match = text.match(/Bootstrapped (\d+)%(?::\s*(.*))?/);
          if (match) {
            this.bootstrapProgress = parseInt(match[1], 10);
            const summary = match[2] ? match[2].trim() : '';
            console.log(`[TorService] Bootstrapped ${this.bootstrapProgress}%: ${summary}`);
            this.emitProgress(this.bootstrapProgress, summary);
          }
        });
      }

      if (this.torProcess.stderr) {
        this.torProcess.stderr.on('data', (d) => {
          console.warn('[TorService stderr]', d.toString().trim());
        });
      }

      this.torProcess.on('exit', (code) => {
        console.log(`[TorService] tor.exe finalizó con código: ${code}`);
        this.torProcess = null;
        this.isStarting = false;
        this.activePort = null;
      });

      // Esperar activamente a que el puerto 9050 responda Y que el circuito llegue al 100%
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (!this.activePort && await this.isPortOpen(9050)) {
          this.activePort = 9050;
        }
        if (this.activePort && this.bootstrapProgress === 100) {
          console.log('[TorService] ¡Circuito Tor establecido al 100% y enlazado al puerto 9050! ✓');
          break;
        }
      }
    } catch (e) {
      console.error('[TorService] Error iniciando demonio tor:', e);
    } finally {
      this.isStarting = false;
    }

    return this.getStatus(true);
  }

  /**
   * Espera activamente a que el circuito Tor alcance el 100% antes de permitir cualquier navegación
   */
  public static async waitUntilReady(timeoutMs = 60000): Promise<TorStatus> {
    let status = await this.getStatus();
    if (status.connected && status.port && status.bootstrapProgress === 100) {
      return status;
    }

    if (!this.torProcess && !this.isStarting) {
      this.startTor().catch(() => {});
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      status = await this.getStatus(true);
      if (status.connected && status.port && status.bootstrapProgress === 100) {
        return status;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return this.getStatus(true);
  }

  /**
   * Configura la sesión de Electron para la ventana Tor.
   * Auto-arranca el demonio Tor y enruta estrictamente por SOCKS5 (evita cualquier fuga directa de IP).
   */
  public static async configureTorSession(torSession: Session): Promise<TorStatus> {
    // Configurar de inmediato el proxy SOCKS5 a 127.0.0.1:9050 para blindar la sesión contra fugas
    await torSession.setProxy({
      proxyRules: 'socks5://127.0.0.1:9050',
      proxyBypassRules: '<local>'
    }).catch((e: any) => console.warn('[TorService] setProxy warning:', e));

    // Asegurar que Tor esté arrancado
    const status = await this.startTor();

    // Cabeceras y User-Agent idéntico a Tor Browser (Firefox ESR)
    torSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0');

    // Bloqueo total de WebRTC, geolocalización, sensores y notificaciones
    torSession.setPermissionRequestHandler((wc: any, permission: string, callback: (granted: boolean) => void) => {
      callback(false);
    });
    torSession.setPermissionCheckHandler(() => false);

    // Activar escudos AdBlock en la sesión Tor
    try {
      AdBlockService.enableInSession(torSession);
    } catch {}

    return status;
  }

  /**
   * Detiene el proceso tor.exe al cerrar el navegador
   */
  public static stopTor(): void {
    if (this.torProcess) {
      try {
        console.log('[TorService] Deteniendo demonio Tor...');
        this.torProcess.kill();
        this.torProcess = null;
      } catch (e) {
        console.warn('[TorService] Error deteniendo tor:', e);
      }
    }
  }
}
