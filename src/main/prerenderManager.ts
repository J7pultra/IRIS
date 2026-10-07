/**
 * prerenderManager.ts
 *
 * Motor nativo de Especulación de Red y Prerenderizado para NavegadorBeta.
 *
 * PILARES:
 * 1. Preconnect Nativo: Resuelve DNS y realiza TCP Fast Open + TLS Handshake antes de hacer clic.
 * 2. Speculative Prerendering: Instancia WebContentsView off-screen para carga en GPU paralela.
 * 3. Gestión agresiva de memoria: Purga contextos prerenderizados si el usuario no hace clic.
 * 4. DNS Prefetch activo: Prefetch de dominios relacionados al navegar.
 */

import { Session, session, WebContentsView } from 'electron';
import { isBlockerEnabledForDomain } from './adblock';
import { HardwareEngine } from './hardwareEngine';
import * as path from 'path';

export class PrerenderManager {
  private static targetSession: Session;
  private static prerenderedViews: Map<string, WebContentsView> = new Map();
  private static preconnectSet: Set<string> = new Set();
  private static prerenderTimers: Map<string, NodeJS.Timeout> = new Map();

  // Constantes de heurística
  private static PRERENDER_TIMEOUT_MS = 6000; // 6 segundos antes de purgar RAM
  private static MAX_CONCURRENT_PRERENDERS = 2; // Límite para no saturar CPU

  static init(sess: Session): void {
    PrerenderManager.targetSession = sess;
    console.log('[PrerenderManager] Motor de especulación Turbo inicializado.');
  }

  /**
   * PILAR 1 + 2: Especulación de Red Predictiva (Socket Preconnect & TCP Fast Open)
   * + Speculative Prerendering (WebContentsView off-screen en GPU paralela)
   */
  static handleHoverIntent(url: string, originUrl: string): void {
    if (!url || !url.startsWith('http')) return;

    // Evitar prerender de telemetría, ads o dominios bloqueados
    try {
      const targetHost = new URL(url).hostname;
      if (!isBlockerEnabledForDomain(targetHost)) return;
    } catch {
      return;
    }

    // 1. NATIVE PRECONNECT (0 coste GPU / 100% nativo C++)
    // Pre-resuelve DNS y abre sockets HTTP/TLS antes de que el usuario haga clic
    try {
      const origin = new URL(url).origin;
      if (!PrerenderManager.preconnectSet.has(origin) && PrerenderManager.targetSession) {
        PrerenderManager.preconnectSet.add(origin);
        PrerenderManager.targetSession.preconnect({ url: origin, numSockets: 2 });
        console.log(`[PrerenderManager] TCP/TLS Preconnect: ${origin}`);
      }
    } catch {
      // Ignorar URLs inválidas
    }

    // 2. SPECULATIVE PRERENDERING (solo si Turbo está activo y hardware lo permite)
    const profile = HardwareEngine.getProfile();
    const tier = profile?.tier || 2;
    const isDynamic = profile?.dynamicModeEnabled ?? true;

    // Prerenderizamos solo si Turbo está activo y no somos Tier 1
    if (isDynamic && tier > 1) {
      PrerenderManager.prerenderUrl(url, tier);
    }
  }

  /**
   * PILAR 2: Prerendering especulativo (Prepara la página en background con GPU off-screen)
   */
  private static prerenderUrl(url: string, tier: number): void {
    const maxConcurrent = tier === 3 ? 3 : 1;
    const timeout = tier === 3 ? 8000 : 4000;

    // Verificar límites y si ya está prerenderizado
    if (PrerenderManager.prerenderedViews.has(url)) return;
    if (PrerenderManager.prerenderedViews.size >= maxConcurrent) {
      // Purgar el más antiguo (FIFO)
      const oldestUrl = PrerenderManager.prerenderedViews.keys().next().value;
      if (oldestUrl) PrerenderManager.purgePrerender(oldestUrl);
    }

    console.log(`[PrerenderManager] Iniciando Speculative Prerendering para: ${url}`);

    try {
      const view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: path.join(__dirname, '../preload/view-preload.js'),
          partition: 'persist:beta-session' // Mismo perfil = misma caché compartida
        }
      });

      // Silenciar audio fantasma y denegar apertura de popups off-screen
      view.webContents.setAudioMuted(true);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      // Cargar la URL en background (GPU off-screen, sin mostrar)
      try {
        view.webContents.loadURL(url);
      } catch {
        PrerenderManager.purgePrerender(url);
        return;
      }

      PrerenderManager.prerenderedViews.set(url, view);

      // Programar destrucción para evitar fugas de memoria
      const timer = setTimeout(() => {
        PrerenderManager.purgePrerender(url);
      }, timeout);
      PrerenderManager.prerenderTimers.set(url, timer);

    } catch (err) {
      console.warn(`[PrerenderManager] Error creando prerender para ${url}:`, err);
    }
  }

  /**
   * PILAR 3: Swap de contexto 0ms (intercambia la vista prerenderizada en lugar de cargar de cero)
   * Llamado por ViewManager cuando el usuario realmente navega a la URL.
   */
  static getPrerenderedView(url: string): WebContentsView | null {
    const view = PrerenderManager.prerenderedViews.get(url);
    if (view && !view.webContents.isDestroyed()) {
      console.log(`[PrerenderManager] ¡SWAP 0ms! Entregando vista pre-cargada: ${url}`);
      PrerenderManager.prerenderedViews.delete(url);
      // Limpiar timer asociado
      const timer = PrerenderManager.prerenderTimers.get(url);
      if (timer) {
        clearTimeout(timer);
        PrerenderManager.prerenderTimers.delete(url);
      }
      view.webContents.setAudioMuted(false); // Desmutear
      return view;
    }
    return null;
  }

  /**
   * DNS Prefetch proactivo al escribir en la barra de URL.
   * Se puede llamar desde el renderer vía IPC para precalentar una URL parcial.
   */
  static prefetchUrl(url: string): void {
    if (!url || !url.startsWith('http')) return;
    try {
      const origin = new URL(url).origin;
      if (!PrerenderManager.preconnectSet.has(origin) && PrerenderManager.targetSession) {
        PrerenderManager.preconnectSet.add(origin);
        PrerenderManager.targetSession.preconnect({ url: origin, numSockets: 1 });
      }
    } catch { }
  }

  /**
   * Limpia todos los contextos prerenderizados
   */
  public static clearAll(): void {
    const urls = Array.from(PrerenderManager.prerenderedViews.keys());
    for (const url of urls) {
      PrerenderManager.purgePrerender(url);
    }
    PrerenderManager.preconnectSet.clear();
  }

  /**
   * Destruye de memoria un prerenderizado no utilizado.
   */
  private static purgePrerender(url: string): void {
    const view = PrerenderManager.prerenderedViews.get(url);
    if (view) {
      console.log(`[PrerenderManager] Purgando RAM: timeout para ${url}`);
      try {
        if (!view.webContents.isDestroyed()) {
          (view.webContents as any).destroy();
        }
      } catch { }
      PrerenderManager.prerenderedViews.delete(url);
    }
    const timer = PrerenderManager.prerenderTimers.get(url);
    if (timer) {
      clearTimeout(timer);
      PrerenderManager.prerenderTimers.delete(url);
    }
  }
}
