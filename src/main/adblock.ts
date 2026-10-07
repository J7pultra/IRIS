import fetch from 'cross-fetch';
import { Session, app } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { parseFilters, Request } from '@ghostery/adblocker';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface BlockStats {
  totalBlocked: number;
  byHost: Record<string, number>;
}

export interface AdblockUpdateInfo {
  lastUpdated: number;
  lastChecked: number;
  status: 'idle' | 'updating' | 'success' | 'error';
  rulesCount: number;
  sourcesCount: number;
  message: string;
}

const stats: BlockStats = { totalBlocked: 0, byHost: {} };
let blockerInstance: ElectronBlocker | null = null;
const allowlistedDomains = new Set<string>([
  'web.whatsapp.com',
  'whatsapp.com',
  'whatsapp.net',
  'web.whatsapp.net',
  'crashlogs.whatsapp.net',
  'dyn.whatsapp.net',
  'challenges.cloudflare.com',
  'cloudflare.com',
  'turnstile.cloudflare.com'
]);

// ── Fuentes rápidas de parches contra YouTube y Anti-Adblocks ──
const RAPID_UPDATE_LISTS = [
  // uBlock Origin Quick-Fixes (La lista de respuesta inmediata más rápida contra los parches diarios de YouTube)
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
  // Brave Shields Unbreak & Specific (Parches oficiales de Brave contra detección y popups)
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt',
  // uBlock Origin Unbreak (Desactivación de scriptlets anti-adblock en la web)
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
  // uBlock Origin Annoyances (Parches directos contra popunders y overlays)
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt'
];

const FILTER_LISTS = [
  // ── Brave Shields Official Filters ──
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-social.txt',

  // ── EasyList, EasyPrivacy & Fanboy Annoyance ──
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://easylist.to/easylist/fanboy-annoyance.txt',
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',

  // ── uBlock Origin Core Filters & Annoyances ──
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt'
];

const CORE_YOUTUBE_RULES = `
! ── Reglas Críticas Inmediatas Brave Shields / YouTube ──
||googlesyndication.com^$third-party
||googleads.g.doubleclick.net^
||static.doubleclick.net^
||youtube.com/pagead/*
||youtube.com/api/stats/ads*
||youtube.com/api/stats/qoe*adformat*
||youtube.com/ptracking*
||youtube.com/youtubei/v1/log_event*
||play.google.com/log*
youtube.com##+js(set-constant, ytInitialPlayerResponse.adPlacements, undefined)
youtube.com##+js(set-constant, ytInitialPlayerResponse.playerAds, undefined)
youtube.com##+js(set-constant, ytInitialPlayerResponse.adSlots, undefined)
youtube.com##+js(set-constant, playerResponse.adPlacements, undefined)
youtube.com###masthead-ad
youtube.com##ytd-display-ad-renderer
youtube.com##ytd-promoted-sparkles-web-renderer
youtube.com##ytd-banner-promo-renderer
youtube.com##.video-ads
youtube.com##.ytp-ad-module
youtube.com##.ytp-ad-overlay-container
youtube.com##.ytp-ad-message-container
youtube.com##.ytp-ad-text
youtube.com##ytd-enforcement-message-view-model

! ── Reglas Popups, Popunders y Redes Publicitarias Streaming (JKAnime, AnimeFLV, Cuevana) ──
||popads.net^
||propellerads.com^
||monetag.com^
||adsterra.com^
||exoclick.com^
||adcash.com^
||hilltopads.com^
||trafficjunky.com^
||yllix.com^
||clickadu.com^
||juicyads.com^
||richads.com^
||gallaupcoil.cfd^
||unboltsecole.com^
||agl003.com^
||*.cfd^$third-party
||*.buzz^$third-party
||*.monster^$third-party
||*.top^$third-party,script
||*.click^$third-party,script
||*.rest^$third-party,script
||*.icu^$third-party,script
||*.sbs^$third-party,script
||betano.*^
||1xbet.*^
||bet365.*^
||mostbet.*^
||melbet.*^
||stake.com^$third-party
||caliente.mx^$third-party

! ── Reglas de excepción críticas para WhatsApp Web (Evita bloqueo de websockets, tokens y QR) ──
@@||web.whatsapp.com^
@@||whatsapp.com^
@@||whatsapp.net^
`;

async function fetchWithTimeout(url: string, timeoutMs: number = 10000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal as any });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function applySessionPolyfill(targetSession: Session) {
  const sAny = targetSession as any;
  if (typeof sAny.registerPreloadScript !== 'function') {
    if (typeof sAny.registerPreloadScripts === 'function') {
      sAny.registerPreloadScript = function(opts: any) {
        try {
          const res = sAny.registerPreloadScripts([opts]);
          return res && res[0] ? res[0] : 'preload-adblocker';
        } catch {
          return 'preload-adblocker';
        }
      };
    } else {
      sAny.registerPreloadScript = function() {
        return 'preload-dummy';
      };
    }
  }
  if (typeof sAny.unregisterPreloadScript !== 'function') {
    if (typeof sAny.unregisterPreloadScripts === 'function') {
      sAny.unregisterPreloadScript = function(id: string) {
        try {
          sAny.unregisterPreloadScripts([id]);
        } catch {}
      };
    } else {
      sAny.unregisterPreloadScript = function() {};
    }
  }
}

export class AdBlockService {
  private static autoUpdateTimer: NodeJS.Timeout | null = null;
  private static isUpdating: boolean = false;

  static async init(targetSession: Session) {
    console.log('[AdBlockService] Inicializando motor nativo Brave Shields / uBlock Origin...');
    
    // Polyfill necesario para Electron 31+
    applySessionPolyfill(targetSession);

    // 1. Activación inmediata sincrónica (0 ms de espera para YouTube)
    try {
      blockerInstance = ElectronBlocker.parse(CORE_YOUTUBE_RULES);
      blockerInstance.enableBlockingInSession(targetSession);
      console.log('[AdBlockService] Reglas nucleares de Brave Shields activadas al instante (0ms) ✓');
    } catch (e) {
      console.warn('[AdBlockService] Activación rápida de reglas nucleares falló, activando directo:', e);
      try {
        targetSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (blockerInstance as any).onHeadersReceived);
        targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (blockerInstance as any).onBeforeRequest);
        console.log('[AdBlockService] Bloqueo de red directo activado como fallback ✓');
      } catch {}
    }

    // 2. Cargar motor completo precompilado en segundo plano
    this.setupEngine(targetSession).catch(err => {
      console.error('[AdBlockService] Fallo iniciando el motor de AdBlock completo:', err);
    });

    // 3. Programar auto-actualizador silencioso en segundo plano
    this.scheduleAutoUpdater(targetSession);
  }

  public static enableInSession(targetSession: Session) {
    applySessionPolyfill(targetSession);
    if (blockerInstance) {
      try {
        blockerInstance.enableBlockingInSession(targetSession);
      } catch {
        try {
          targetSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (blockerInstance as any).onHeadersReceived);
          targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (blockerInstance as any).onBeforeRequest);
        } catch {}
      }
    }
  }

  private static async setupEngine(targetSession: Session) {
    const binPath = path.join(app.getPath('userData'), 'engine_prebuilt_v1.bin');
    
    try {
      console.log('[AdBlockService] Inicializando base de datos completa de AdBlock (precompilada)...');
      
      blockerInstance = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: binPath,
        read: (p: string) => fs.readFile(p),
        write: (p: string, d: any) => fs.writeFile(p, d),
      });

      if (blockerInstance) {
        try {
          const coreParsed = parseFilters(CORE_YOUTUBE_RULES);
          blockerInstance.update({
            newNetworkFilters: coreParsed.networkFilters,
            newCosmeticFilters: coreParsed.cosmeticFilters
          });
        } catch {}

        applySessionPolyfill(targetSession);
        try {
          blockerInstance.enableBlockingInSession(targetSession);
          console.log('[AdBlockService] Motor completo de AdBlock activado con éxito ✓');
        } catch (err) {
          targetSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (blockerInstance as any).onHeadersReceived);
          targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (blockerInstance as any).onBeforeRequest);
          console.log('[AdBlockService] Bloqueo de red directo activado ✓');
        }

        blockerInstance.on('request-blocked', (request: any) => {
          try {
            const parsed = new URL(request.url);
            stats.totalBlocked++;
            stats.byHost[parsed.hostname] = (stats.byHost[parsed.hostname] || 0) + 1;
          } catch {}
        });
      }
    } catch (err) {
      console.error('[AdBlockService] Error configurando motor completo:', err);
    }
  }

  private static getMetaPath(): string {
    return path.join(app.getPath('userData'), 'adblock_meta.json');
  }

  static async getUpdateInfo(): Promise<AdblockUpdateInfo> {
    const metaPath = this.getMetaPath();
    try {
      const data = await fs.readFile(metaPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return {
        lastUpdated: 0,
        lastChecked: 0,
        status: 'idle',
        rulesCount: 85000,
        sourcesCount: RAPID_UPDATE_LISTS.length,
        message: 'Reglas base activas'
      };
    }
  }

  private static async saveMeta(info: AdblockUpdateInfo): Promise<void> {
    try {
      await fs.writeFile(this.getMetaPath(), JSON.stringify(info, null, 2), 'utf8');
    } catch (err) {
      console.warn('[AdBlockService] No se pudo guardar metadatos de actualización:', err);
    }
  }

  /**
   * Programa la verificación automática en segundo plano sin interrumpir ni ralentizar al usuario.
   */
  static scheduleAutoUpdater(targetSession: Session) {
    // Verificación diferida a los 4 segundos tras arrancar
    setTimeout(async () => {
      try {
        const meta = await this.getUpdateInfo();
        const FOUR_HOURS = 4 * 60 * 60 * 1000;
        const now = Date.now();
        if (!meta.lastUpdated || (now - meta.lastUpdated > FOUR_HOURS)) {
          console.log('[AdBlockService] Comprobando parches de YouTube / Brave en segundo plano (+4h)...');
          await this.checkForUpdates(targetSession, false);
        } else {
          console.log(`[AdBlockService] Protección al día (hace ${Math.round((now - meta.lastUpdated) / 60000)} min).`);
        }
      } catch (err) {
        console.warn('[AdBlockService] Error en verificación silenciosa inicial:', err);
      }
    }, 4000);

    // Verificación recurrente cada 4 horas
    if (this.autoUpdateTimer) clearInterval(this.autoUpdateTimer);
    this.autoUpdateTimer = setInterval(async () => {
      console.log('[AdBlockService] Ejecutando auto-actualización programada de reglas...');
      await this.checkForUpdates(targetSession, false);
    }, 4 * 60 * 60 * 1000);
  }

  /**
   * Descarga las listas rápidas (uBlock Quick-Fixes, Brave Unbreak/Specific),
   * compila en memoria, inyecta al motor activo en vivo y persiste a disco.
   */
  static async checkForUpdates(targetSession?: Session, isManual: boolean = false): Promise<{ success: boolean; message: string; updateInfo: AdblockUpdateInfo }> {
    if (this.isUpdating) {
      const meta = await this.getUpdateInfo();
      return { success: false, message: 'La actualización ya está en curso...', updateInfo: meta };
    }

    this.isUpdating = true;
    console.log(`[AdBlockService] ${isManual ? 'Iniciando actualización manual' : 'Iniciando auto-actualización en segundo plano'} de reglas anti-adblock...`);

    try {
      const fetchPromises = RAPID_UPDATE_LISTS.map(url => fetchWithTimeout(url, 12000));
      const results = await Promise.allSettled(fetchPromises);
      
      let combinedRules = CORE_YOUTUBE_RULES + '\n';
      let successfulSources = 0;

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.status === 'fulfilled' && res.value && res.value.length > 50) {
          combinedRules += '\n' + res.value;
          successfulSources++;
        } else if (res.status === 'rejected') {
          console.warn(`[AdBlockService] Advertencia: lista ${RAPID_UPDATE_LISTS[i]} no disponible:`, (res as any).reason?.message);
        }
      }

      if (successfulSources === 0) {
        throw new Error('No se pudo descargar ninguna lista (comprueba tu conexión a internet)');
      }

      // Parsea las reglas descargadas
      const parsed = parseFilters(combinedRules);
      const addedRules = (parsed.networkFilters?.length || 0) + (parsed.cosmeticFilters?.length || 0);

      // Inyección en caliente en el motor activo
      if (blockerInstance) {
        blockerInstance.update({
          newNetworkFilters: parsed.networkFilters,
          newCosmeticFilters: parsed.cosmeticFilters,
          newPreprocessors: parsed.preprocessors
        });

        // Persistir el binario serializado para que el siguiente inicio sea instantáneo
        try {
          const binPath = path.join(app.getPath('userData'), 'engine_prebuilt_v1.bin');
          const serialized = blockerInstance.serialize();
          await fs.writeFile(binPath, Buffer.from(serialized));
        } catch (e) {
          console.warn('[AdBlockService] Error guardando caché binaria en disco:', e);
        }
      }

      const now = Date.now();
      const updateInfo: AdblockUpdateInfo = {
        lastUpdated: now,
        lastChecked: now,
        status: 'success',
        rulesCount: addedRules,
        sourcesCount: successfulSources,
        message: `Actualizado: +${addedRules} reglas y parches anti-adblock activos`
      };

      await this.saveMeta(updateInfo);
      console.log(`[AdBlockService] ¡Actualización exitosa! +${addedRules} reglas aplicadas en vivo desde ${successfulSources} fuentes.`);
      this.isUpdating = false;
      return { success: true, message: updateInfo.message, updateInfo };
    } catch (err: any) {
      console.error('[AdBlockService] Error actualizando reglas:', err);
      this.isUpdating = false;
      const meta = await this.getUpdateInfo();
      meta.lastChecked = Date.now();
      meta.status = 'error';
      meta.message = err?.message || 'Error al descargar actualizaciones';
      await this.saveMeta(meta);
      return { success: false, message: meta.message, updateInfo: meta };
    }
  }

  static getStats(): BlockStats {
    return { ...stats };
  }

  static toggleAllowlist(domain: string): boolean {
    if (allowlistedDomains.has(domain)) {
      allowlistedDomains.delete(domain);
      return false; // bloqueador activo
    } else {
      allowlistedDomains.add(domain);
      return true; // bloqueador pausado para este dominio
    }
  }

  static isBlockerEnabledForDomain(domain: string): boolean {
    return !allowlistedDomains.has(domain);
  }

  static getCosmetics(url: string): { styles: string; scripts: string } {
    if (!blockerInstance) return { styles: '', scripts: '' };
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      if (allowlistedDomains.has(hostname)) return { styles: '', scripts: '' };
      
      const res = blockerInstance.getCosmeticsFilters({
        url,
        hostname,
        domain: hostname
      });
      return {
        styles: (res as any)?.styles || '',
        scripts: (res as any)?.scripts || ''
      };
    } catch {
      return { styles: '', scripts: '' };
    }
  }

  static getYTDefuserScript(): string {
    return `
    (function() {
      if (window.__braveShieldYTReady) {
        if (typeof window.__patrolInStreamAds === 'function') {
          window.__patrolInStreamAds();
        }
        return;
      }
      window.__braveShieldYTReady = true;

      try { Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } }); } catch(e) {}

      var AD_DEL = ['adBreakHeartbeatParams', 'adBreakServiceExpiry', 'adBreaks', 'playerAds'];
      var AD_EMP = ['adPlacements', 'adSlots', 'adBreakParams'];

      function prune(o) {
        if (!o || typeof o !== 'object') return o;
        if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) prune(o[i]); return o; }
        for (var d = 0; d < AD_DEL.length; d++) if (AD_DEL[d] in o) delete o[AD_DEL[d]];
        for (var e = 0; e < AD_EMP.length; e++) if (AD_EMP[e] in o) { if (Array.isArray(o[AD_EMP[e]])) o[AD_EMP[e]].length = 0; else o[AD_EMP[e]] = {}; }
        var ks = Object.keys(o);
        for (var k = 0; k < ks.length; k++) if (typeof o[ks[k]] === 'object' && o[ks[k]] !== null) prune(o[ks[k]]);
        return o;
      }

      var _jp = JSON.parse;
      JSON.parse = function() {
        var r = _jp.apply(this, arguments);
        if (r && typeof r === 'object') {
          if (r.playerResponse || r.adPlacements || r.adSlots || r.playerAds) prune(r);
        }
        return r;
      };

      try {
        var _ytr;
        Object.defineProperty(window, 'ytInitialPlayerResponse', { get: function() { return _ytr; }, set: function(v) { _ytr = prune(v); }, configurable: true });
      } catch(e) {}

      function click(el) {
        if (!el) return;
        try { el.click(); } catch(e) {}
        try {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch(e) {}
      }

      window.__patrolInStreamAds = function() {
        var enf = document.querySelector('ytd-enforcement-message-view-model');
        if (enf) { enf.remove(); document.querySelector('tp-yt-iron-overlay-backdrop')?.remove(); document.querySelector('video')?.play().catch(function() {}); }

        var p = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        var isAd = p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
        if (!isAd) isAd = !!(document.querySelector('.ytp-ad-player-overlay') || document.querySelector('.ytp-ad-skip-button-container') || document.querySelector('.ytp-ad-skip-button-slot'));

        var v = p ? p.querySelector('video') : document.querySelector('video');
        if (isAd && v) {
          v.muted = true;
          try { v.playbackRate = 16; } catch(e) {}
          var sk = [
            'button.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button',
            '.ytp-skip-ad-button', 'button.ytp-skip-ad-button', '.ytp-ad-skip-button-slot button',
            '.ytp-ad-skip-button-container button', '.videoAdUiSkipButton', '[id^="skip-button"]',
            'button[class*="skip"]', 'div[class*="skip"]'
          ];
          for (var i = 0; i < sk.length; i++) {
            var bs = document.querySelectorAll(sk[i]);
            for (var j = 0; j < bs.length; j++) click(bs[j]);
          }
          if (p) {
            var all = p.querySelectorAll('button, div[role="button"]');
            for (var b = 0; b < all.length; b++) {
              var t = (all[b].textContent || '').toLowerCase();
              if (t.includes('saltar') || t.includes('skip') || t.includes('omitir')) click(all[b]);
            }
          }
          try {
            if (!isNaN(v.duration) && isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
            else v.currentTime = 999999;
          } catch(e) {}
        }
      };

      setInterval(window.__patrolInStreamAds, 50);
    })();
    `;
  }

  /**
   * Determina si una URL pertenece a un anuncio, tracker, popunder o campaña de apuestas.
   */
  public static isAd(url: string, sourceUrl?: string): boolean {
    if (!url) return false;
    const cleanUrl = url.trim();
    if (!cleanUrl || cleanUrl === 'about:blank' || cleanUrl.startsWith('javascript:') || cleanUrl.startsWith('data:')) {
      return true;
    }

    const lower = cleanUrl.toLowerCase();

    // 1. Patrones de alta frecuencia de apuestas, casinos, clickjacking y redes de popunder
    const AD_POPUP_PATTERNS = [
      'betano', '1xbet', 'bet365', 'mostbet', 'melbet', 'betway', 'stake.com',
      'rojabet', 'caliente.mx', 'sportingbet', 'casino', 'apuestas', 'jugadas', 'bono',
      'adsterra', 'propellerads', 'monetag', 'popads', 'exoclick', 'adcash',
      'hilltopads', 'trafficjunky', 'yllix', 'clickadu', 'juicyads', 'richads',
      'doubleclick', 'googleads', 'googlesyndication', 'adnxs', 'rubiconproject',
      'criteo', 'outbrain', 'taboola', 'mgid', 'zergnet', 'revcontent',
      'popunder', 'onclick', 'direct-link', 'track.', 'affiliate', 'aff_c?',
      'offer_id=', 'delivery/afr.php', 'ad_id=',
      'gallaupcoil', 'unboltsecole', 'agl003', '.cfd', '.buzz', '.monster'
    ];

    for (const pattern of AD_POPUP_PATTERNS) {
      if (lower.includes(pattern)) {
        return true;
      }
    }

    // 2. Consulta de alta fidelidad al motor Brave Shields / Ghostery
    if (blockerInstance) {
      try {
        const popupReq = Request.fromRawDetails({
          url: cleanUrl,
          sourceUrl: sourceUrl || undefined,
          type: 'popup' as any
        });
        const popupMatch = blockerInstance.match(popupReq);
        if (popupMatch && popupMatch.match && !popupMatch.exception) {
          return true;
        }

        const frameReq = Request.fromRawDetails({
          url: cleanUrl,
          sourceUrl: sourceUrl || undefined,
          type: 'main_frame'
        });
        const frameMatch = blockerInstance.match(frameReq);
        if (frameMatch && frameMatch.match && !frameMatch.exception) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  public static recordBlocked(url?: string) {
    stats.totalBlocked++;
    if (url) {
      try {
        const parsed = new URL(url);
        stats.byHost[parsed.hostname] = (stats.byHost[parsed.hostname] || 0) + 1;
      } catch {}
    }
  }
}

export function isBlockerEnabledForDomain(domain: string): boolean {
  return AdBlockService.isBlockerEnabledForDomain(domain);
}

export const BraveShields = AdBlockService;

