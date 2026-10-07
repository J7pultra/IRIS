/**
 * view-preload.ts
 *
 * Se inyecta en cada WebContentsView (cada pestaña de página web).
 * Opera bajo contextIsolation = true.
 *
 * PILARES IMPLEMENTADOS:
 *  Pilar 1 — Filtrado a nivel preload: prevent-fetch de telemetría
 *  Pilar 2 — Scriptlets: set-constant, json-prune, anti-adblock wall v2
 *  Pilar 3 — SSAI Heurístico: detección por timestamps + fast-forward inteligente
 *
 * DISEÑO DE MEMORIA:
 *  - Todos los observers se crean UNA SOLA VEZ y se reutilizan
 *  - El SSAI detector usa un sliding window de timestamps (array de tamaño fijo)
 *  - El MutationObserver usa attributeFilter para no procesar cambios irrelevantes
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

/**
 * Precarga de Conexiones por Resource Hints Dinámicos (Hover Prefetch)
 */
function initHoverPrefetcher() {
  let hoverTimer: any = null;
  document.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement;
    const a = target?.closest?.('a');
    if (!a || !a.href) return;
    try {
      const url = new URL(a.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

      // Enviar intención de hover al proceso principal después de 60ms
      hoverTimer = setTimeout(() => {
        ipcRenderer.send('hover-intent', a.href, window.location.origin);
      }, 60);
    } catch { /* URLs inválidas */ }
  }, { passive: true });

  document.addEventListener('mouseout', () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }, { passive: true });
}

try {
  initHoverPrefetcher();
} catch (err) {
  console.error('[Shield Preload] Error en inicialización:', err);
}

// ══════════════════════════════════════════════════════════════════════════════
// BRAVE SHIELDS YOUTUBE AD DEFUSER ULTRA (Scriptlets, JSON Pruner & Auto-Skip)
// ══════════════════════════════════════════════════════════════════════════════

const isYouTube = window.location.hostname.includes('youtube.com') ||
  document.location.href.includes('youtube.com');

const braveYTDefuserScript = `
(function() {
  'use strict';
  if (window.__braveShieldYTReady) return;
  window.__braveShieldYTReady = true;

  console.log('[BraveShields] Motor defensivo YouTube Main World activo ✓');

  // 1. Evasión de detección de bloqueador
  try {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
  } catch(e) {}

  // 2. Podador quirúrgico de objetos JSON de anuncios (Brave Shields / uBlock pruneAds)
  var AD_KEYS_DELETE = ['adBreakHeartbeatParams', 'adBreakServiceExpiry', 'adBreaks', 'playerAds'];
  var AD_KEYS_EMPTY  = ['adPlacements', 'adSlots', 'adBreakParams', 'inReelAdPlaceholder'];

  function pruneAds(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        pruneAds(obj[i]);
      }
      return obj;
    }
    for (var d = 0; d < AD_KEYS_DELETE.length; d++) {
      var kDel = AD_KEYS_DELETE[d];
      if (kDel in obj) {
        delete obj[kDel];
      }
    }
    for (var e = 0; e < AD_KEYS_EMPTY.length; e++) {
      var kEmp = AD_KEYS_EMPTY[e];
      if (kEmp in obj) {
        if (Array.isArray(obj[kEmp])) {
          obj[kEmp].length = 0;
        } else {
          obj[kEmp] = {};
        }
      }
    }
    var keys = Object.keys(obj);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        pruneAds(obj[key]);
      }
    }
    return obj;
  }

  // 3. Interceptar JSON.parse antes de que el player procese anuncios
  var _origJSONParse = JSON.parse;
  JSON.parse = function() {
    var parsed = _origJSONParse.apply(this, arguments);
    if (parsed && typeof parsed === 'object') {
      if (parsed.playerResponse || parsed.adPlacements || parsed.adSlots || parsed.playerAds || parsed.adBreakParams) {
        pruneAds(parsed);
      }
    }
    return parsed;
  };

  // 4. Interceptar ytInitialPlayerResponse exclusivamente (NUNCA tocar ytInitialData para no romper el feed de inicio)
  var _ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      get: function() { return _ytInitialPlayerResponse; },
      set: function(val) { _ytInitialPlayerResponse = pruneAds(val); },
      configurable: true
    });
  } catch(e) {}

  // 5. Interceptar ytplayer.config.args
  var _ytplayer;
  try {
    Object.defineProperty(window, 'ytplayer', {
      get: function() { return _ytplayer; },
      set: function(val) {
        if (val && typeof val === 'object') {
          pruneAds(val);
        }
        _ytplayer = val;
      },
      configurable: true
    });
  } catch(e) {}

  // 6. Interceptar fetch y XMLHttpRequest (bloquear beacons y podar respuestas solo de player)
  var _origFetch = window.fetch;
  window.fetch = async function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url ? arguments[0].url : String(arguments[0]));

    if (url.includes('/api/stats/ads') || url.includes('/pagead/') || url.includes('/pcs/view') || url.includes('/ptracking') || url.includes('/api/stats/qoe?adformat')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // Interceptar exclusivamente /youtubei/v1/player (NUNCA /next ni /browse para no romper inicio)
    if (url.includes('/youtubei/v1/player')) {
      try {
        var response = await _origFetch.apply(this, arguments);
        var clone = response.clone();
        var text = await clone.text();
        var json = JSON.parse(text);
        pruneAds(json);
        var newHeaders = new Headers(response.headers);
        newHeaders.delete('content-encoding');
        newHeaders.delete('content-length');
        return new Response(JSON.stringify(json), {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (e) {
        return _origFetch.apply(this, arguments);
      }
    }

    return _origFetch.apply(this, arguments);
  };

  var _origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    this._url = typeof arguments[1] === 'string' ? arguments[1] : '';
    this._isPlayer = this._url.includes('/youtubei/v1/player');
    return _origXHROpen.apply(this, arguments);
  };

  var _xhrDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
  if (_xhrDesc && _xhrDesc.get) {
    Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
      get: function() {
        var text = _xhrDesc.get.call(this);
        if (this._isPlayer && text) {
          try {
            var data = JSON.parse(text);
            pruneAds(data);
            return JSON.stringify(data);
          } catch(e) {}
        }
        return text;
      },
      configurable: true,
      enumerable: true
    });
  }

  // 7. Disparador de click universal simulando eventos de mouse reales
  function triggerClick(el) {
    if (!el) return;
    try {
      el.click();
    } catch(e) {}
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch(e) {}
  }

  // 8. Auto-Skipper Infalible para In-Stream Ads (Loop cada 50ms)
  var adActive = false;
  var savedVol = 1;

  function patrolInStreamAds() {
    // A. Quitar pantallas de detección
    var enforcement = document.querySelector('ytd-enforcement-message-view-model');
    if (enforcement) {
      enforcement.remove();
      var backdrop1 = document.querySelector('tp-yt-iron-overlay-backdrop');
      if (backdrop1) backdrop1.remove();
      var v1 = document.querySelector('video');
      if (v1 && v1.paused) v1.play().catch(function() {});
    }

    var dialog = document.querySelector('ytd-popup-container tp-yt-paper-dialog');
    if (dialog && /ad blocker|bloqueador de anuncios|adblocker/i.test(dialog.textContent || '')) {
      dialog.remove();
      var backdrop2 = document.querySelector('tp-yt-iron-overlay-backdrop');
      if (backdrop2) backdrop2.remove();
      var v2 = document.querySelector('video');
      if (v2 && v2.paused) v2.play().catch(function() {});
    }

    // B. Detectar reproductor en modo anuncio
    var player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    var isAd = false;

    if (player) {
      if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
        isAd = true;
      }
    }

    if (!isAd) {
      if (document.querySelector('.ytp-ad-player-overlay') || 
          document.querySelector('.ytp-ad-skip-button-container') ||
          document.querySelector('.ytp-ad-skip-button-slot') ||
          document.querySelector('.ytp-ad-text')) {
        isAd = true;
      }
    }

    var video = player ? player.querySelector('video') : document.querySelector('video');

    if (isAd && video) {
      if (!adActive) {
        adActive = true;
        savedVol = video.volume;
      }

      // 1. Silenciar inmediatamente
      video.muted = true;

      // 2. Máxima aceleración
      if (video.playbackRate < 16) {
        try { video.playbackRate = 16; } catch(e) {}
      }

      // 3. Cliquear todos los botones de saltar disponibles
      var skipSelectors = [
        'button.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button',
        '.ytp-skip-ad-button',
        'button.ytp-skip-ad-button',
        '.ytp-ad-skip-button-slot button',
        '.ytp-ad-skip-button-container button',
        '.ytp-ad-overlay-close-button',
        '.videoAdUiSkipButton',
        '[id^="skip-button"]',
        'button[class*="skip"]',
        'div[class*="skip"]',
        '.ytp-ad-skip-button__text',
        '.ytp-skip-ad-button__text'
      ];

      for (var s = 0; s < skipSelectors.length; s++) {
        var btns = document.querySelectorAll(skipSelectors[s]);
        for (var b = 0; b < btns.length; b++) {
          triggerClick(btns[b]);
        }
      }

      // 4. Búsqueda por texto (ej: "Saltar", "Skip", "Omitir")
      if (player) {
        var allButtons = player.querySelectorAll('button, div[role="button"], span[role="button"]');
        for (var k = 0; k < allButtons.length; k++) {
          var txt = (allButtons[k].textContent || '').trim().toLowerCase();
          if (txt.includes('saltar') || txt.includes('skip') || txt.includes('omitir')) {
            triggerClick(allButtons[k]);
          }
        }
      }

      // 5. Forzar video al final del anuncio
      try {
        if (!isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        } else {
          video.currentTime = 999999;
        }
      } catch(e) {}

    } else if (adActive && video) {
      // El anuncio terminó: restaurar sonido y velocidad normal
      adActive = false;
      video.muted = false;
      video.volume = savedVol || 1;
      video.playbackRate = 1;
      if (video.paused) {
        video.play().catch(function() {});
      }
    }
  }

  setInterval(patrolInStreamAds, 50);

  // 9. Estilos Cosméticos
  function applyCosmeticCSS() {
    if (document.getElementById('brave-yt-cosmetic-styles')) return;
    var style = document.createElement('style');
    style.id = 'brave-yt-cosmetic-styles';
    style.textContent = [
      '#masthead-ad',
      'ytd-ad-slot-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-banner-promo-renderer',
      'ytd-statement-banner-renderer',
      'ytd-display-ad-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-promoted-sparkles-text-search-renderer',
      'ytd-promoted-video-renderer',
      '.ytd-player-legacy-desktop-watch-ads-renderer',
      '.ytp-ad-overlay-container',
      '.ytp-ad-message-container',
      '.ytp-ad-text',
      '.ytp-ad-image-overlay',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
      'tp-yt-paper-dialog:has(#mealbar-promo-renderer)',
      'ytd-popup-container:has(ytd-enforcement-message-view-model)'
    ].join(',') + '{ display: none !important; visibility: hidden !important; height: 0 !important; width: 0 !important; opacity: 0 !important; pointer-events: none !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  applyCosmeticCSS();
  document.addEventListener('DOMContentLoaded', applyCosmeticCSS);
})();
`;

if (isYouTube) {
  // Inyección Primaria: World ID 0 (Main World de Chromium)
  try {
    (webFrame as any).executeJavaScriptInIsolatedWorld(0, [{
      code: braveYTDefuserScript
    }]);
  } catch (err) {
    console.warn('[Preload] Inyección World 0:', err);
  }

  // Inyección Secundaria: Inserción directa de script en el DOM
  const injectToDOM = () => {
    try {
      const scriptEl = document.createElement('script');
      scriptEl.textContent = braveYTDefuserScript;
      (document.head || document.documentElement).appendChild(scriptEl);
      scriptEl.remove();
    } catch { }
  };

  if (document.documentElement) {
    injectToDOM();
  } else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        injectToDOM();
      }
    });
    observer.observe(document, { childList: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BLINDAJE WEBAUTHN / PASSKEYS: ELIMINAR POPUPS ESPONTÁNEOS DE WINDOWS SECURITY
// ══════════════════════════════════════════════════════════════════════════════
const passkeyShieldScript = `
(function() {
  'use strict';
  if (window.__passkeyShieldActive) return;
  window.__passkeyShieldActive = true;

  // 1. Informar a los sitios (Google, YouTube, GitHub, etc.) que la mediación condicional
  // (autofill silencioso en segundo plano) NO está activa en este navegador.
  // Con esto, Google ni siquiera intenta consultar passkeys en segundo plano.
  try {
    if (window.PublicKeyCredential) {
      if (typeof window.PublicKeyCredential.isConditionalMediationAvailable === 'function') {
        window.PublicKeyCredential.isConditionalMediationAvailable = function() {
          return Promise.resolve(false);
        };
      }
      if (typeof window.PublicKeyCredential.getClientCapabilities === 'function') {
        var origCaps = window.PublicKeyCredential.getClientCapabilities;
        window.PublicKeyCredential.getClientCapabilities = async function() {
          var caps = await origCaps.call(this).catch(function() { return {}; });
          return Object.assign({}, caps, { conditionalMediation: false, conditionalCreate: false });
        };
      }
    }
  } catch(e) {}

  // 2. Interceptar navigator.credentials.get
  try {
    if (navigator.credentials && typeof navigator.credentials.get === 'function') {
      var _origGet = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = function(options) {
        // A. Bloquear peticiones de mediación condicional (autofill de fondo sin clic)
        // Evita que Windows 10/11 abra el diálogo modal de "Seguridad de Windows / Elige una clave de paso".
        if (options && options.mediation === 'conditional') {
          return Promise.reject(new DOMException('Conditional mediation is not supported by platform modal UI', 'NotAllowedError'));
        }

        // B. Si la llamada ocurre espontáneamente sin interacción previa del usuario en la página, abortarla
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
          return Promise.reject(new DOMException('WebAuthn requires user activation', 'NotAllowedError'));
        }

        // C. Si el usuario hizo clic deliberadamente en "Iniciar sesión con clave de paso" (gesto explícito),
        // se permite la autenticación normal para que Windows Hello funcione cuando el usuario lo desea.
        return _origGet(options);
      };
    }
  } catch(e) {}
})();
`;

// Inyección en el Main World de Chromium para todas las páginas
try {
  (webFrame as any).executeJavaScriptInIsolatedWorld(0, [{
    code: passkeyShieldScript
  }]);
} catch (err) {
  const injectPasskeyToDOM = () => {
    try {
      const scriptEl = document.createElement('script');
      scriptEl.textContent = passkeyShieldScript;
      (document.head || document.documentElement).appendChild(scriptEl);
      scriptEl.remove();
    } catch {}
  };
  if (document.documentElement) {
    injectPasskeyToDOM();
  } else {
    const obs = new MutationObserver(() => {
      if (document.documentElement) {
        obs.disconnect();
        injectPasskeyToDOM();
      }
    });
    obs.observe(document, { childList: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BRAVE SHIELDS ANTI-POPUNDER & CLICKJACKING OVERLAY DEFUSER
// ══════════════════════════════════════════════════════════════════════════════
const antiPopunderShieldScript = `
(function() {
  'use strict';
  if (window.__braveAntiPopunderActive) return;
  window.__braveAntiPopunderActive = true;

  // 1. Interceptar window.open en el Main World (World 0)
  var _origOpen = window.open;
  window.open = function(url, target, features) {
    var strUrl = (url || '').trim();
    var lower = strUrl.toLowerCase();

    // A. Bloquear URLs en blanco o de señuelo ('about:blank', 'javascript:', etc.)
    if (!strUrl || strUrl === 'about:blank' || strUrl.startsWith('javascript:')) {
      console.log('[BraveShields] window.open(about:blank/empty) interceptado y bloqueado.');
      return {
        closed: true,
        focus: function() {},
        blur: function() {},
        close: function() {},
        location: { href: 'about:blank', replace: function() {} },
        document: { write: function() {}, open: function() {}, close: function() {} }
      };
    }

    // B. Bloquear patrones conocidos de anuncios, apuestas y popunders
    var AD_KEY_PATTERNS = [
      'betano', '1xbet', 'bet365', 'mostbet', 'melbet', 'casino', 'apuestas',
      'adsterra', 'monetag', 'popads', 'propeller', 'exoclick', 'adcash',
      'hilltopads', 'trafficjunky', 'yllix', 'clickadu', 'juicyads', 'richads',
      'onclick', 'popunder', 'direct-link', 'affiliate', 'aff_c?', 'offer_id='
    ];

    for (var i = 0; i < AD_KEY_PATTERNS.length; i++) {
      if (lower.includes(AD_KEY_PATTERNS[i])) {
        console.log('[BraveShields] window.open publicidad bloqueado:', strUrl);
        return {
          closed: true,
          focus: function() {},
          blur: function() {},
          close: function() {},
          location: { href: 'about:blank', replace: function() {} }
        };
      }
    }

    // C. En sitios de streaming y anime (ej: jkanime, animeflv, cuevana, etc.)
    var currentHost = window.location.hostname.toLowerCase();
    var isStreamingSite = /jkanime|animeflv|tioanime|cuevana|pelisplus|repelis|stream|veranime/i.test(currentHost);
    if (isStreamingSite) {
      try {
        var targetHost = new URL(strUrl, window.location.href).hostname.toLowerCase();
        var isSameHost = targetHost === currentHost || targetHost.endsWith('.' + currentHost);
        var isTrusted = /discord|twitter|x\\.com|facebook|instagram|telegram|t\\.me|youtube|crunchyroll|github/i.test(targetHost);
        if (!isSameHost && !isTrusted) {
          console.log('[BraveShields] Popunder no confiable bloqueado en streaming:', targetHost);
          return {
            closed: true,
            focus: function() {},
            blur: function() {},
            close: function() {},
            location: { href: 'about:blank', replace: function() {} }
          };
        }
      } catch(e) {}
    }

    return _origOpen.apply(this, arguments);
  };

  // 2. Neutralizador Quirúrgico de Overlays de Clickjacking (SOLO EN SITIOS DE STREAMING/PIRATERÍA)
  // En plataformas oficiales (YouTube, Netflix, Twitch, Disney, Google, etc.), se omite para no romper
  // los reproductores de video, navegación SPA interna con preventDefault, ni agotar CPU con sweepOverlays.
  var isMajorPlatform = /youtube\.com|google\.|netflix\.com|twitch\.tv|kick\.com|disney|primevideo|spotify\.com|facebook\.com|instagram\.com|twitter\.com|x\.com/i.test(currentHost);

  if (isStreamingSite && !isMajorPlatform) {
    function isOverlayTrap(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      try {
        var s = window.getComputedStyle(el);
        var z = parseInt(s.zIndex, 10);
        if ((s.position === 'fixed' || s.position === 'absolute') && (z >= 999 || z === 2147483647)) {
          var r = el.getBoundingClientRect();
          if (r.width >= window.innerWidth * 0.75 && r.height >= window.innerHeight * 0.75) {
            var isTransparent = s.opacity === '0' || s.backgroundColor === 'rgba(0, 0, 0, 0)' || s.backgroundColor === 'transparent';
            var hasNoText = !(el.innerText || '').trim();
            if (isTransparent && hasNoText && !el.closest('#player, video, .video-player, ytd-app, ytd-watch-flexy')) {
              return true;
            }
          }
        }
      } catch(e) {}
      return false;
    }

    function neutralizeTrap(el) {
      if (!el) return;
      try {
        el.style.pointerEvents = 'none';
        el.style.display = 'none';
        el.remove();
      } catch(e) {}
    }

    // Interceptar el clic en fase de captura y redirigir inmediatamente al elemento real
    document.addEventListener('click', function(e) {
      var t = e.target;
      if (isOverlayTrap(t)) {
        console.log('[BraveShields] Overlay de clickjacking neutralizado al vuelo.');
        neutralizeTrap(t);
        // Localizar el elemento real que el usuario quería pulsar debajo del overlay
        var realTarget = document.elementFromPoint(e.clientX, e.clientY);
        if (realTarget && realTarget !== t) {
          var realLink = realTarget.closest ? realTarget.closest('a[href]') : null;
          if (realLink && realLink.href && !realLink.href.startsWith('javascript:')) {
            console.log('[BraveShields] Ejecutando navegación al primer clic:', realLink.href);
            if (realLink.target === '_blank') {
              window.open(realLink.href, '_blank');
            } else {
              window.location.href = realLink.href;
            }
            e.stopPropagation();
            e.preventDefault();
            return;
          } else {
            try { realTarget.click(); } catch(err) {}
          }
        }
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // 3. Proteger enlaces reales para que los scripts de publicidad no puedan cancelar el clic (preventDefault)
    var _origPreventDefault = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function() {
      if (this.type === 'click' && this.isTrusted && this.target) {
        try {
          var a = this.target.closest ? this.target.closest('a[href]') : null;
          if (a && a.href && !a.href.startsWith('javascript:') && a.getAttribute('href') !== '#' && !a.getAttribute('href').startsWith('javascript:')) {
            var linkHost = new URL(a.href, window.location.href).hostname;
            if (linkHost === window.location.hostname || linkHost.endsWith('.' + window.location.hostname)) {
              // Un script publicitario intentó cancelar la navegación del usuario al hacer clic en un anime: se ignora
              return;
            }
          }
        } catch(err) {}
      }
      return _origPreventDefault.apply(this, arguments);
    };

    // 4. Garantía de navegación en el 1er clic (35ms fallback si un script absorbió el evento)
    window.addEventListener('click', function(e) {
      if (!e.isTrusted) return;
      var t = e.target;
      var a = t && t.closest ? t.closest('a[href]') : null;
      if (a && a.href && !a.href.startsWith('javascript:') && a.getAttribute('href') !== '#' && !a.getAttribute('href').startsWith('javascript:')) {
        try {
          var targetUrl = new URL(a.href, window.location.href);
          if (targetUrl.hostname === window.location.hostname) {
            var startHref = window.location.href;
            var destHref = a.href;
            setTimeout(function() {
              if (window.location.href === startHref && !a.target) {
                window.location.href = destHref;
              }
            }, 35);
          }
        } catch(err) {}
      }
    }, true);

    // Barrido periódico cada 600ms para limpiar overlays antes de que el usuario haga clic
    function sweepOverlays() {
      try {
        var elements = document.querySelectorAll('div, a, span, section');
        for (var j = 0; j < elements.length; j++) {
          if (isOverlayTrap(elements[j])) {
            neutralizeTrap(elements[j]);
          }
        }
      } catch(e) {}
    }
    setInterval(sweepOverlays, 600);
    document.addEventListener('DOMContentLoaded', sweepOverlays);
    window.addEventListener('load', sweepOverlays);
  }
})();
`;

try {
  (webFrame as any).executeJavaScriptInIsolatedWorld(0, [{
    code: antiPopunderShieldScript
  }]);
} catch (err) {
  const injectPopunderToDOM = () => {
    try {
      const scriptEl = document.createElement('script');
      scriptEl.textContent = antiPopunderShieldScript;
      (document.head || document.documentElement).appendChild(scriptEl);
      scriptEl.remove();
    } catch {}
  };
  if (document.documentElement) {
    injectPopunderToDOM();
  } else {
    const obsPop = new MutationObserver(() => {
      if (document.documentElement) {
        obsPop.disconnect();
        injectPopunderToDOM();
      }
    });
    obsPop.observe(document, { childList: true });
  }
}

// ── Exponer API Mínima ──────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('shieldApp', {
  isShieldBrowser: true
});

// ══════════════════════════════════════════════════════════════════════════════
// CINEMA MODE & P2P REAL-TIME VIDEO SYNCHRONIZATION
// ══════════════════════════════════════════════════════════════════════════════

let isRemoteSync = false;
let remoteSyncTimer: any = null;
let currentObservedVideo: HTMLVideoElement | null = null;
let lastReportedSeekTime = -1;

function setRemoteSyncFlag() {
  isRemoteSync = true;
  if (remoteSyncTimer) clearTimeout(remoteSyncTimer);
  remoteSyncTimer = setTimeout(() => {
    isRemoteSync = false;
  }, 800);
}

const attachedVideos = new WeakSet<HTMLVideoElement>();

function attachVideoListeners(video: HTMLVideoElement) {
  if (!video || attachedVideos.has(video)) return;
  attachedVideos.add(video);

  video.addEventListener('play', () => {
    if (isRemoteSync) return;
    ipcRenderer.send('cinema-video-event', {
      type: 'play',
      currentTime: video.currentTime,
      timestamp: Date.now()
    });
  });

  video.addEventListener('pause', () => {
    if (isRemoteSync) return;
    ipcRenderer.send('cinema-video-event', {
      type: 'pause',
      currentTime: video.currentTime,
      timestamp: Date.now()
    });
  });

  video.addEventListener('seeked', () => {
    if (isRemoteSync) return;
    if (Math.abs(video.currentTime - lastReportedSeekTime) < 0.8) return;
    lastReportedSeekTime = video.currentTime;
    ipcRenderer.send('cinema-video-event', {
      type: 'seek',
      currentTime: video.currentTime,
      timestamp: Date.now()
    });
  });

  video.addEventListener('ratechange', () => {
    if (isRemoteSync) return;
    ipcRenderer.send('cinema-video-event', {
      type: 'rate',
      rate: video.playbackRate,
      timestamp: Date.now()
    });
  });
}

function findPrimaryVideo(): HTMLVideoElement | null {
  const allVideos = Array.from(document.querySelectorAll('video'));
  if (allVideos.length === 0) {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      try {
        const idoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (idoc) {
          const iv = idoc.querySelector('video');
          if (iv) return iv as HTMLVideoElement;
        }
      } catch {}
    }
    return null;
  }
  if (allVideos.length === 1) return allVideos[0];
  let best = allVideos[0];
  let maxArea = 0;
  for (const v of allVideos) {
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > maxArea) {
      maxArea = area;
      best = v;
    }
  }
  return best;
}

function scanAndAttachVideo() {
  document.querySelectorAll('video').forEach(v => attachVideoListeners(v));
  document.querySelectorAll('iframe').forEach(iframe => {
    try {
      const idoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (idoc) {
        idoc.querySelectorAll('video').forEach(v => attachVideoListeners(v as HTMLVideoElement));
      }
    } catch {}
  });
}

// Observar adición dinámica de videos en cualquier plataforma (YouTube, Twitch, AnimeFLV, Netflix, etc.)
const videoObserver = new MutationObserver(() => {
  scanAndAttachVideo();
});

if (document.documentElement) {
  videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  scanAndAttachVideo();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
    scanAndAttachVideo();
  });
}

// Detectar navegación universal SPA en cualquier plataforma (YouTube, Twitch, AnimeFLV, Netflix, etc.)
let lastUrl = window.location.href;
function notifyUrlChange() {
  const curUrl = window.location.href;
  if (curUrl !== lastUrl && !curUrl.startsWith('beta://') && !curUrl.startsWith('about:')) {
    lastUrl = curUrl;
    ipcRenderer.send('cinema-video-event', {
      type: 'url',
      url: lastUrl,
      timestamp: Date.now()
    });
  }
}

window.addEventListener('yt-navigate-finish', notifyUrlChange);
window.addEventListener('popstate', notifyUrlChange);
window.addEventListener('hashchange', notifyUrlChange);

try {
  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    const ret = originalPushState.apply(this, args);
    notifyUrlChange();
    return ret;
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function(...args) {
    const ret = originalReplaceState.apply(this, args);
    notifyUrlChange();
    return ret;
  };
} catch {}

// Escuchar eventos de video emitidos desde subframes (AnimeFLV, Cuevana, embeds)
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'cinema-subframe-video-event' && ev.data.action) {
    if (isRemoteSync) return;
    ipcRenderer.send('cinema-video-event', ev.data.action);
  } else if (ev.data && ev.data.type === 'cinema-subframe-apply-sync' && ev.data.action) {
    const act = ev.data.action;
    const v = document.querySelector('video');
    if (!v) return;
    setRemoteSyncFlag();
    if (act.type === 'play') {
      if (typeof act.currentTime === 'number' && Math.abs(v.currentTime - act.currentTime) > 1.2) {
        v.currentTime = act.currentTime;
      }
      v.play().catch(() => {});
    } else if (act.type === 'pause') {
      if (typeof act.currentTime === 'number' && Math.abs(v.currentTime - act.currentTime) > 1.2) {
        v.currentTime = act.currentTime;
      }
      v.pause();
    } else if (act.type === 'seek') {
      if (typeof act.currentTime === 'number') {
        v.currentTime = act.currentTime;
      }
    }
  }
});

// Receptor de sincronización remota desde el compañero P2P
ipcRenderer.on('cinema-apply-sync', (event, action: any) => {
  // Notificar a subframes vía postMessage
  try {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage({ type: 'cinema-subframe-apply-sync', action }, '*');
      } catch {}
    }
  } catch {}

  const video = findPrimaryVideo() || document.querySelector('video');
  if (!video) return;

  setRemoteSyncFlag();

  if (action.type === 'play') {
    if (typeof action.currentTime === 'number' && Math.abs(video.currentTime - action.currentTime) > 1.2) {
      video.currentTime = action.currentTime;
    }
    video.play().catch(() => { });
  } else if (action.type === 'pause') {
    if (typeof action.currentTime === 'number' && Math.abs(video.currentTime - action.currentTime) > 1.2) {
      video.currentTime = action.currentTime;
    }
    video.pause();
  } else if (action.type === 'seek') {
    if (typeof action.currentTime === 'number') {
      video.currentTime = action.currentTime;
    }
  } else if (action.type === 'rate') {
    if (typeof action.rate === 'number') {
      video.playbackRate = action.rate;
    }
  }
});

// Modo Teatro: Luces Apagadas
ipcRenderer.on('cinema-set-lights', (event, dimmed: boolean) => {
  const OVERLAY_ID = 'cinema-theater-lights-overlay';
  let overlay = document.getElementById(OVERLAY_ID);

  if (dimmed) {
    if (!overlay && document.body) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.cssText = `
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        background: rgba(0, 0, 0, 0.88) !important;
        z-index: 2147483640 !important;
        pointer-events: none !important;
        transition: opacity 0.3s ease !important;
      `;
      document.body.appendChild(overlay);

      // Asegurar que el reproductor de video esté elevado por encima del overlay
      const styleTag = document.createElement('style');
      styleTag.id = 'cinema-theater-style';
      styleTag.textContent = `
        video, ytd-player, #movie_player, .html5-video-player, .video-stream {
          position: relative !important;
          z-index: 2147483646 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(styleTag);
    }
  } else {
    if (overlay) overlay.remove();
    const styleTag = document.getElementById('cinema-theater-style');
    if (styleTag) styleTag.remove();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// OJO DE HALCÓN (PHANTOM CACHE): GUARDIÁN WHATSAPP & INSTAGRAM WEB
// ══════════════════════════════════════════════════════════════════════════════

function initPhantomWhatsAppGuardian() {
  const isWhatsApp = window.location.hostname.includes('whatsapp.com');
  const isInstagram = window.location.hostname.includes('instagram.com');
  if (!isWhatsApp && !isInstagram) return;

  console.log(`[Ojo de Halcón] Guardián de Mensajes y Fotos activado en ${isWhatsApp ? 'WhatsApp Web' : 'Instagram'}`);

  // Evasión de detección básica en WhatsApp Web
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch { }

  interface CachedMessage {
    id: string;
    coreId: string;
    cleanId?: string;
    text: string | null;
    media: {
      type: 'image' | 'video' | 'audio' | 'document';
      dataUrl: string;
    } | null;
    sender: string;
    chatName: string;
    isOutgoing: boolean;
    timestamp: number;
  }

  const RESCUED_STORE_KEY = '__OJO_DE_HALCON_RESCUED_STORE_V4__';
  const rescuedStore = new Map<string, CachedMessage>();
  const liveCache = new Map<string, CachedMessage>();
  let lastRemovedMessage: CachedMessage | null = null;
  let lastRemovedTime = 0;

  const lastOutgoingMessages: CachedMessage[] = [];
  const lastOutgoingByChat = new Map<string, CachedMessage[]>();
  let pendingComposerText = '';
  let pendingComposerTime = 0;
  let pendingComposerChat = '';

  function loadRescuedStore() {
    try {
      // Purgar versiones antiguas acumuladas para empezar 100% limpio
      const oldKeys = [
        '__OJO_DE_HALCON_RESCUED_STORE_V1__',
        '__OJO_DE_HALCON_RESCUED_STORE_V2__',
        '__OJO_DE_HALCON_RESCUED_STORE_V3__',
        'phantom_rescued_v1',
        'phantom_rescued_v2',
        'phantom_rescued_v3'
      ];
      oldKeys.forEach(k => {
        try { localStorage.removeItem(k); } catch (e) {}
      });

      const raw = localStorage.getItem(RESCUED_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach((item: any) => {
            if (item && (item.id || item.coreId)) {
              const sid = extractStanzaId(item.id || item.coreId);
              const ns = normalizeStanza(sid);
              if (sid) rescuedStore.set(sid, item);
              if (ns) rescuedStore.set(ns, item);
              if (item.cleanId) rescuedStore.set(item.cleanId, item);
              if (item.id) rescuedStore.set(item.id, item);
              if (item.coreId) rescuedStore.set(item.coreId, item);
            }
          });
        }
      }
    } catch (e) {}
  }

  function saveToRescuedStore(msg: CachedMessage) {
    if (!msg) return;
    try {
      const sid = extractStanzaId(msg.id || msg.coreId);
      const ns = normalizeStanza(sid);
      if (sid) rescuedStore.set(sid, msg);
      if (ns) rescuedStore.set(ns, msg);
      if (msg.cleanId) rescuedStore.set(msg.cleanId, msg);
      if (msg.id) rescuedStore.set(msg.id, msg);
      if (msg.coreId) rescuedStore.set(msg.coreId, msg);

      const unique: CachedMessage[] = [];
      const seen = new Set<string>();
      for (const item of rescuedStore.values()) {
        const key = item.coreId || item.id || item.cleanId;
        if (key && !seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      }
      const trimmed = unique.slice(-300);
      localStorage.setItem(RESCUED_STORE_KEY, JSON.stringify(trimmed));
    } catch (e) {}
  }

  // Interceptar texto enviado por el propio usuario en el compositor
  document.addEventListener('keydown', (e) => {
    try {
      if (e.key === 'Enter' && !e.shiftKey) {
        const composer = document.querySelector(
          '#main footer div[contenteditable="true"], footer div[contenteditable="true"], [data-testid="conversation-compose-box-input"], div[data-tab="10"]'
        );
        if (composer && composer.textContent) {
          const t = cleanWaText(composer.textContent);
          if (t.length > 0 && !isGarbageMessageText(t)) {
            pendingComposerText = t;
            pendingComposerTime = Date.now();
            pendingComposerChat = updateActiveChat();
          }
        }
      }
    } catch (err) {}
  }, true);

  document.addEventListener('click', (e) => {
    try {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const sendBtn = target.closest(
        'button[aria-label*="Enviar"], button[data-testid="compose-btn-send"], span[data-icon="send"], button span[data-icon="send"]'
      );
      if (sendBtn) {
        const composer = document.querySelector(
          '#main footer div[contenteditable="true"], footer div[contenteditable="true"], [data-testid="conversation-compose-box-input"], div[data-tab="10"]'
        );
        if (composer && composer.textContent) {
          const t = cleanWaText(composer.textContent);
          if (t.length > 0 && !isGarbageMessageText(t)) {
            pendingComposerText = t;
            pendingComposerTime = Date.now();
            pendingComposerChat = updateActiveChat();
          }
        }
      }

      // Al hacer clic en un chat lateral, programar barrido inmediato de restauración
      const chatItem = target.closest(
        '#pane-side div[role="listitem"], #pane-side div[role="row"], #pane-side div[tabindex]'
      );
      if (chatItem) {
        setTimeout(() => {
          updateActiveChat();
          loadRescuedStore();
          document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(el => {
            const c = getMessageContainer(el);
            if (c) checkForDeletion(c);
          });
        }, 100);
        setTimeout(() => {
          updateActiveChat();
          document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(el => {
            const c = getMessageContainer(el);
            if (c) checkForDeletion(c);
          });
        }, 300);
        setTimeout(() => {
          updateActiveChat();
          document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(el => {
            const c = getMessageContainer(el);
            if (c) checkForDeletion(c);
          });
        }, 750);
      }
    } catch (err) {}
  }, true);

  let activeChatName = '';
  function getActiveChatName(): string {
    const chatHeader = document.querySelector(
      '#main header span[dir="auto"], header span[dir="auto"], [data-testid="conversation-info-header"] span[dir="auto"], #main header h2'
    );
    return chatHeader?.textContent?.trim() || 'WhatsApp Web';
  }

  function updateActiveChat(): string {
    const current = getActiveChatName();
    if (current && current !== activeChatName && current !== 'WhatsApp Web') {
      activeChatName = current;
      lastRemovedMessage = null;
      lastRemovedTime = 0;
    }
    return activeChatName || current;
  }

  function normalizeStanza(s: string | null | undefined): string {
    if (!s) return '';
    return String(s)
      .replace(/^temp[-_]?/i, '')
      .replace(/_(recalled|revoked|deleted)$/i, '')
      .trim();
  }

  function extractStanzaId(rawId: string | null | undefined): string | null {
    if (!rawId) return null;
    let clean = rawId.replace(/_(recalled|revoked|deleted)$/i, '');
    clean = clean.replace(/_TEMP[-_]/i, '_');
    const parts = clean.split('_');
    const stanza = parts.find(p => p.length >= 8 && !p.includes('@') && p !== 'true' && p !== 'false' && p !== 'owner');
    if (stanza) return normalizeStanza(stanza);
    return normalizeStanza(parts.length > 1 ? parts[parts.length - 1] : clean);
  }

  function getCoreId(rawId: string | null): string | null {
    return extractStanzaId(rawId);
  }

  function getMessageContainer(node: Element | null | undefined): Element | null {
    if (!node) return null;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement as Element | null;
      if (!node) return null;
    }
    const bubble = node.closest ? node.closest('.message-in, .message-out') : null;
    if (bubble) return bubble;
    const row = node.closest ? node.closest('[data-id]') : null;
    if (row) return row;
    if (node.matches && node.matches('.message-in, .message-out, [data-id]')) return node;
    return null;
  }

  function getMessageFullId(el?: Element | null, container?: Element | null): string | null {
    const list = [container, el];
    for (const c of list) {
      if (!c) continue;
      if (c.getAttribute && c.getAttribute('data-id')) {
        return c.getAttribute('data-id');
      }
      if (c.closest) {
        const row = c.closest('[data-id]');
        if (row && row.getAttribute && row.getAttribute('data-id')) {
          return row.getAttribute('data-id');
        }
      }
      if (c.querySelector) {
        const child = c.querySelector('[data-id]');
        if (child && child.getAttribute && child.getAttribute('data-id')) {
          return child.getAttribute('data-id');
        }
      }
    }
    return null;
  }

  function isMsgOutgoing(container: Element | null, rawId: string | null | undefined): boolean {
    if (!container) return false;
    if (container.classList && container.classList.contains('message-out')) return true;
    if (container.classList && container.classList.contains('message-in')) return false;
    const effId = rawId || getMessageFullId(container);
    if (effId && (effId.startsWith('true_') || effId.includes('_true_'))) return true;
    if (effId && (effId.startsWith('false_') || effId.includes('_false_'))) return false;
    if (container.querySelector && (container.querySelector('[data-icon="tail-out"], .tail-out') || container.querySelector('[data-testid="tail-out"]'))) return true;
    if (container.querySelector && (container.querySelector('[data-icon="tail-in"], .tail-in') || container.querySelector('[data-testid="tail-in"]'))) return false;
    const textContent = (container.textContent || '').toLowerCase();
    if (textContent.includes('eliminaste este mensaje') || textContent.includes('you deleted this message') || textContent.includes('você apagou esta mensagem')) {
      return true;
    }
    return false;
  }

  function extractSenderName(msgNode: Element): string {
    const rawId = getMessageFullId(msgNode);
    if (isMsgOutgoing(msgNode, rawId)) {
      return 'Tú';
    }
    const prePlain = msgNode.querySelector('div[data-pre-plain-text]')?.getAttribute('data-pre-plain-text');
    if (prePlain) {
      const match = prePlain.match(/\]\s*([^:]+):/);
      if (match && match[1]) return match[1].trim();
    }
    const authorSpan = msgNode.querySelector('span[dir="auto"]._ah-q, span._ah-q, [data-testid="author"], .copyable-text [dir="auto"]');
    if (authorSpan && authorSpan.textContent && authorSpan.textContent.trim().length > 0) {
      return authorSpan.textContent.trim();
    }
    return updateActiveChat();
  }

  async function captureMedia(mediaEl: HTMLImageElement | HTMLVideoElement | HTMLAudioElement): Promise<{ type: 'image' | 'video' | 'audio' | 'document'; dataUrl: string } | null> {
    const src = (mediaEl as any).currentSrc || mediaEl.src;

    if (mediaEl.tagName === 'IMG') {
      const img = mediaEl as HTMLImageElement;
      if (img.complete && img.naturalWidth > 50 && img.naturalHeight > 50) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            if (dataUrl && dataUrl.length > 200) return { type: 'image', dataUrl };
          }
        } catch { }
      }
    }

    if (mediaEl.tagName === 'VIDEO') {
      const vid = mediaEl as HTMLVideoElement;
      // 1. Intentar capturar el stream/archivo de video real si es accesible
      if (src && !src.includes('mediasource')) {
        try {
          const response = await fetch(src);
          if (response.ok) {
            const blob = await response.blob();
            if (blob.size > 2000 && blob.type.startsWith('video/')) {
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = () => reject(null);
                reader.readAsDataURL(blob);
              });
              if (dataUrl && dataUrl.startsWith('data:video/')) return { type: 'video', dataUrl };
            }
          }
        } catch { }
      }

      // 2. Si no es accesible el archivo de video completo, capturar un fotograma claro como IMAGEN (nunca como video)
      if (vid.readyState >= 2 && (vid.videoWidth > 100 || vid.clientWidth > 100)) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = vid.videoWidth || vid.clientWidth || 640;
          canvas.height = vid.videoHeight || vid.clientHeight || 1136;
          const ctx = canvas.getContext('2d');
          if (ctx && canvas.width > 50 && canvas.height > 50) {
            ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            if (dataUrl && dataUrl.length > 500) return { type: 'image', dataUrl };
          }
        } catch { }
      }
    }

    if (src && !src.includes('mediasource')) {
      try {
        const response = await fetch(src);
        if (response.ok) {
          const blob = await response.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(null);
            reader.readAsDataURL(blob);
          });

          let type: 'image' | 'video' | 'audio' = 'image';
          if (mediaEl.tagName === 'VIDEO' || blob.type.startsWith('video/')) type = 'video';
          else if (mediaEl.tagName === 'AUDIO' || blob.type.startsWith('audio/')) type = 'audio';

          return { type, dataUrl };
        }
      } catch { }
    }

    return null;
  }

  function renderTextStatusCard(text: string, bgColor: string): string {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';

      // Draw background
      ctx.fillStyle = bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' ? bgColor : '#128c7e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Subtle gradient overlay
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.15)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Text styling
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const fontSize = text.length > 100 ? 36 : text.length > 50 ? 44 : 52;
      ctx.font = `600 ${fontSize}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

      // Word wrapping
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let currentLine = '';
      const maxWidth = 580;

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) lines.push(currentLine);

      const lineHeight = fontSize * 1.35;
      const totalTextHeight = lines.length * lineHeight;
      const startY = (canvas.height - totalTextHeight) / 2 + (lineHeight / 2);

      lines.forEach((line, i) => {
        ctx.fillText(line, canvas.width / 2, startY + (i * lineHeight));
      });

      return canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      return '';
    }
  }

  function stripTrailingTimestamp(str: string | null | undefined): string {
    if (!str) return '';
    let s = str.trim();
    // Remover timestamp pegado al final e.g. "Hola12:07 a.m." -> "Hola" o "Hola 12:07 a.m." -> "Hola"
    s = s.replace(/(?:^|\b|\s|[a-zA-Z\u00C0-\u017F\.,!?])(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm))?)$/i, (match, ts) => {
      return match.slice(0, match.length - ts.length).trim();
    });
    // Si toda la cadena es solamente una hora, retornar vacío
    if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm))?$/i.test(s)) {
      return '';
    }
    return s.trim();
  }

  function isGarbageMessageText(text: string | null | undefined): boolean {
    if (!text) return true;
    const t = text.trim();
    if (t.length < 1) return true;
    if (/ic-search|ic-more-vert|ic-attach|ic-mic|Escribe un mensaje|wds-ic-sticker/i.test(t)) return true;
    if (/tail-in|tail-out|recalled/i.test(t)) return true;
    if (/Usa WhatsApp en tu teléfono para ver mensajes anteriores/i.test(t)) return true;
    if (/^(?:este\s+mensaje\s+fue\s+eliminado|se\s+elimin[oó]\s+este\s+mensaje|this\s+message\s+was\s+deleted|you\s+deleted\s+this\s+message)\.?$/i.test(t)) return true;
    return false;
  }

  function extractCleanMessageText(container: Element): string | null {
    if (!container) return null;

    const candidates = container.querySelectorAll('span.selectable-text, span._ao3e, .copyable-text span[dir]');
    let bestText = '';

    for (const el of Array.from(candidates)) {
      if (el.closest('[data-testid="quoted-message"], .quoted-mention, [data-icon="quote"]')) continue;

      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[data-testid="msg-meta"], [data-icon], time, span.x1rg5ohu').forEach(meta => {
        if (/^\s*\d{1,2}:\d{2}/.test(meta.textContent || '') || meta.closest('[data-testid="msg-meta"]')) {
          meta.remove();
        }
      });

      let raw = cleanWaText(clone.textContent);
      raw = stripTrailingTimestamp(raw);

      if (raw.length > 0 && !isDeletionText(raw) && !isGarbageMessageText(raw)) {
        if (raw.length > bestText.length) {
          bestText = raw;
        }
      }
    }

    if (!bestText) {
      const textEl = container.querySelector('.selectable-text, span._ao3e, div[dir="ltr"], div[dir="rtl"]');
      if (textEl && !textEl.closest('[data-testid="quoted-message"]')) {
        const clone = textEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[data-testid="msg-meta"], [data-icon], time, span.x1rg5ohu').forEach(m => m.remove());
        let raw = cleanWaText(clone.textContent);
        raw = stripTrailingTimestamp(raw);
        if (raw.length > 0 && !isDeletionText(raw) && !isGarbageMessageText(raw)) {
          bestText = raw;
        }
      }
    }

    return bestText || null;
  }

  async function cacheMessageNode(node: Element) {
    const mainChat = node.closest ? node.closest('#main, [data-testid="conversation-panel-wrapper"], [data-testid="conversation-panel-messages"]') : null;
    if (!mainChat) return;

    const container = getMessageContainer(node);
    if (!container) return;

    if (container.getAttribute('data-phantom-restored') === 'true') return;

    // Si ya es un mensaje eliminado, NO cachearlo como mensaje vivo ni asociarle texto del compositor
    const textContent = (container.textContent || '').trim();
    const hasRecallIcon = container.querySelector(
      'span[data-icon="recalled"], span[data-icon="block"], span[data-icon="msg-deleted"], [data-testid="recalled"], [data-testid="msg-recalled"], span[data-icon*="recalled"], span[data-icon*="delete"]'
    );
    if (hasRecallIcon || isDeletionText(textContent)) {
      return;
    }

    const rawId = getMessageFullId(node, container);
    const stanzaId = extractStanzaId(rawId);
    const normStanza = normalizeStanza(stanzaId);
    const cleanId = rawId ? rawId.replace(/_(recalled|revoked|deleted)$/i, '') : null;
    const normClean = normalizeStanza(cleanId);
    if (!stanzaId && !cleanId && !rawId) return;

    const isOut = isMsgOutgoing(container, rawId);
    const currentChat = updateActiveChat();

    let entry = (stanzaId && liveCache.get(stanzaId)) ||
      (normStanza && liveCache.get(normStanza)) ||
      (cleanId && liveCache.get(cleanId)) ||
      (normClean && liveCache.get(normClean)) ||
      (stanzaId && rescuedStore.get(stanzaId)) ||
      (normStanza && rescuedStore.get(normStanza)) ||
      {
        id: rawId || stanzaId || cleanId || ('wa_' + Date.now()),
        coreId: stanzaId || cleanId || ('wa_' + Date.now()),
        cleanId: cleanId || undefined,
        text: null,
        media: null,
        sender: isOut ? 'Tú' : extractSenderName(container),
        chatName: currentChat,
        isOutgoing: isOut,
        timestamp: Date.now()
      };

    if (!entry.text) {
      const extracted = extractCleanMessageText(container);
      if (extracted) {
        entry.text = extracted;
      } else if (isOut && pendingComposerText && (Date.now() - pendingComposerTime < 5000)) {
        entry.text = pendingComposerText;
        pendingComposerText = ''; // Evitar que se reutilice en otros mensajes
      }
    }

    if (!entry.media) {
      const img = container.querySelector('img[src], img[src^="blob:"], img[src*="whatsapp.net"]');
      const vid = container.querySelector('video');
      const aud = container.querySelector('audio');
      const htmlImg = img as HTMLImageElement;
      const validImg = htmlImg && !htmlImg.closest('[data-icon]') && !htmlImg.classList.contains('emoji') && (htmlImg.naturalWidth > 60 || (htmlImg as HTMLElement).clientWidth > 60 || (htmlImg.getAttribute('src') || '').includes('blob:')) ? htmlImg : null;
      const mediaTarget = validImg || vid || aud;
      if (mediaTarget) {
        const captured = await captureMedia(mediaTarget as any);
        if (captured) {
          entry.media = captured;
        }
      }
    }

    if (entry.text || entry.media) {
      if (stanzaId) liveCache.set(stanzaId, entry);
      if (normStanza) liveCache.set(normStanza, entry);
      if (cleanId) liveCache.set(cleanId, entry);
      if (normClean) liveCache.set(normClean, entry);
      if (entry.id) liveCache.set(entry.id, entry);

      saveToRescuedStore(entry);

      if (isOut) {
        lastOutgoingMessages.unshift(entry);
        if (lastOutgoingMessages.length > 30) lastOutgoingMessages.pop();

        const chatOut = lastOutgoingByChat.get(currentChat) || [];
        if (!chatOut.some(m => m.id === entry.id || m.coreId === entry.coreId || (m.text && m.text === entry.text && Math.abs(m.timestamp - entry.timestamp) < 3000))) {
          chatOut.unshift(entry);
          if (chatOut.length > 20) chatOut.pop();
          lastOutgoingByChat.set(currentChat, chatOut);
        }
      }
    }
  }

  function isDeletionText(text: string): boolean {
    if (!text) return false;
    return /(?:este\s+mensaje\s+fue\s+eliminado|se\s+elimin[oó]\s+este\s+mensaje|eliminaste\s+este\s+mensaje|se\s+ha\s+eliminado\s+este\s+mensaje|this\s+message\s+was\s+deleted|you\s+deleted\s+this\s+message|mensagem\s+apagada|foi\s+apagada|apagou\s+esta\s+mensagem|você\s+apagou\s+esta\s+mensagem|anul[oó]\s+el\s+env[ií]o|cancel[oó]\s+el\s+env[ií]o|unsent\s+a\s+message|mensaje\s+eliminado)/i.test(text);
  }

  function restoreMessageInDom(container: Element, data: CachedMessage) {
    if (!container) return;
    if (container.getAttribute('data-phantom-restored') === 'true') return;
    container.setAttribute('data-phantom-restored', 'true');

    // Guardar en rescuedStore para que NUNCA desaparezca al cambiar de conversación
    saveToRescuedStore(data);

    const fullId = getMessageFullId(container);
    const isOutgoing = (data && data.isOutgoing !== undefined)
      ? data.isOutgoing
      : isMsgOutgoing(container, fullId);

    const cleanText = stripTrailingTimestamp(data.text);
    const timeStr = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const card = document.createElement('div');
    card.className = `phantom-rescued-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
    card.style.cssText = `
      box-sizing: border-box !important;
      display: inline-flex !important;
      flex-direction: column !important;
      max-width: 95% !important;
      min-width: 160px !important;
      width: fit-content !important;
      margin: 2px 0 !important;
      padding: 8px 12px !important;
      background: ${isOutgoing ? '#005c4b' : '#202c33'} !important;
      border: 1px solid ${isOutgoing ? 'rgba(37, 211, 102, 0.45)' : 'rgba(0, 168, 132, 0.45)'} !important;
      border-${isOutgoing ? 'right' : 'left'}: 3.5px solid ${isOutgoing ? '#25d366' : '#00a884'} !important;
      border-radius: 9px !important;
      border-bottom-${isOutgoing ? 'right' : 'left'}-radius: 2px !important;
      color: #e9edef !important;
      font-family: inherit !important;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35) !important;
      ${isOutgoing ? 'margin-left: auto !important; margin-right: 0 !important;' : 'margin-right: auto !important; margin-left: 0 !important;'}
    `;

    let html = `
      <div style="font-size: 10px; font-weight: 700; color: ${isOutgoing ? '#25d366' : '#00a884'}; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 3px; letter-spacing: 0.3px;">
        <span style="display: flex; align-items: center; gap: 4px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          MENSAJE RESCATADO ${!isOutgoing && data.sender && data.sender !== 'Tú' ? `• ${escapeHtml(data.sender)}` : ''}
        </span>
        <span style="font-size: 8.5px; padding: 1px 5px; background: ${isOutgoing ? 'rgba(37, 211, 102, 0.22)' : 'rgba(0, 168, 132, 0.18)'}; border-radius: 3px; color: ${isOutgoing ? '#25d366' : '#00a884'}; font-weight: 800;">
          ${isOutgoing ? 'ELIMINADO POR TI' : 'PRESERVADO'}
        </span>
      </div>
    `;

    if (cleanText) {
      html += `<div style="font-size: 14.5px; line-height: 19px; color: #e9edef; word-break: break-word; user-select: text; margin: 3px 0 2px 0;">${escapeHtml(cleanText)}</div>`;
    }

    if (data.media && data.media.dataUrl) {
      if (data.media.type === 'video') {
        html += `<video src="${data.media.dataUrl}" controls style="width: 100%; max-width: 320px; border-radius: 6px; margin: 6px 0; display: block;"></video>`;
      } else if (data.media.type === 'audio') {
        html += `<audio src="${data.media.dataUrl}" controls style="width: 100%; max-width: 300px; margin: 6px 0; display: block;"></audio>`;
      } else {
        html += `<img src="${data.media.dataUrl}" style="max-width: 300px; max-height: 300px; border-radius: 6px; margin: 6px 0; display: block; object-fit: contain; cursor: pointer;" onclick="window.open('${data.media.dataUrl}', '_blank')"/>`;
      }

      const ext = data.media.type === 'video' ? 'mp4' : (data.media.type === 'audio' ? 'ogg' : 'png');
      html += `
        <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
          <a href="${data.media.dataUrl}" download="OjoDeHalcon_${Date.now()}.${ext}" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: #00a884; color: #fff; font-size: 11px; font-weight: 600; text-decoration: none; border-radius: 4px; cursor: pointer;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Guardar Archivo
          </a>
        </div>
      `;
    }

    html += `
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; font-size: 11px; color: #8696a0; margin-top: 2px;">
        <span>${timeStr}</span>
        <span style="color: #53bdeb; font-size: 12px; line-height: 1;">✓✓</span>
      </div>
    `;

    card.innerHTML = html;

    try {
      if (isOutgoing) {
        container.classList.add('message-out');
        container.classList.remove('message-in');
        (container as HTMLElement).style.justifyContent = 'flex-end';
      } else {
        container.classList.add('message-in');
        container.classList.remove('message-out');
        (container as HTMLElement).style.justifyContent = 'flex-start';
      }
    } catch (e) {}

    // Encontrar el contenedor visual de la burbuja (div._amk4, etc.)
    let bubble = container.querySelector('div[class*="_amk"], div[class*="_akb"], div[tabindex="-1"]') as HTMLElement | null;
    if (!bubble) {
      bubble = (container.firstElementChild || container) as HTMLElement;
    }

    // Ocultar todos los elementos y textos antiguos dentro de la burbuja y el contenedor
    container.querySelectorAll('span, [data-icon], time, .copyable-text, [data-testid="msg-meta"]').forEach(el => {
      if (!el.closest('.phantom-rescued-bubble')) {
        (el as HTMLElement).style.display = 'none';
      }
    });

    Array.from(bubble.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = '';
      } else if (node.nodeType === Node.ELEMENT_NODE && !(node as HTMLElement).classList.contains('phantom-rescued-bubble')) {
        (node as HTMLElement).style.display = 'none';
      }
    });

    try {
      bubble.style.background = 'transparent';
      bubble.style.boxShadow = 'none';
      bubble.style.border = 'none';
      bubble.style.padding = '0';
      bubble.style.display = 'flex';
      bubble.style.flexDirection = 'column';
      bubble.style.alignItems = isOutgoing ? 'flex-end' : 'flex-start';
      bubble.style.width = '100%';
    } catch (e) {}

    const existingCard = bubble.querySelector('.phantom-rescued-bubble');
    if (existingCard) {
      existingCard.replaceWith(card);
    } else {
      bubble.appendChild(card);
    }

    if (cleanText || data.media) {
      try {
        ipcRenderer.send('phantom-message-captured', {
          id: data.coreId || data.cleanId || ('wa_' + Date.now()),
          platform: isWhatsApp ? 'whatsapp' : 'instagram',
          sender: data.sender || (isOutgoing ? 'Tú' : 'Remitente'),
          chatName: data.chatName || updateActiveChat(),
          text: cleanText || '(Multimedia)',
          mediaType: data.media ? data.media.type : undefined,
          mediaData: data.media ? data.media.dataUrl : undefined,
          timestamp: data.timestamp || Date.now(),
          isDeleted: true,
          isOutgoing: !!isOutgoing,
          deletedAt: Date.now()
        });
      } catch (e) {
        console.warn('[Ojo de Halcón] Error enviando mensaje a Electron:', e);
      }
    }
  }

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function checkForDeletion(node: Element) {
    if (!node) return;
    if (node.getAttribute?.('data-phantom-restored') === 'true') return;

    // Solo procesar dentro de la conversación actual (#main)
    const mainChat = node.closest ? node.closest('#main, [data-testid="conversation-panel-wrapper"], [data-testid="conversation-panel-messages"]') : null;
    if (!mainChat) return;

    const container = getMessageContainer(node);
    if (!container) return;
    if (container.getAttribute?.('data-phantom-restored') === 'true') return;

    const fullId = getMessageFullId(node, container);
    const stanzaId = extractStanzaId(fullId);
    const normStanza = normalizeStanza(stanzaId);
    const cleanId = fullId ? fullId.replace(/_(recalled|revoked|deleted)$/i, '') : null;
    const normClean = normalizeStanza(cleanId);
    const currentChat = updateActiveChat();
    const isOut = isMsgOutgoing(container, fullId);

    const hasIcon = container.querySelector(
      'span[data-icon="recalled"], span[data-icon="block"], span[data-icon="msg-deleted"], [data-testid="recalled"], [data-testid="msg-recalled"], span[data-icon*="recalled"], span[data-icon*="delete"]'
    );
    const textContent = (container.textContent || '').trim();
    const hasText = isDeletionText(textContent);

    if (hasIcon || hasText) {
      let dataToRender: CachedMessage | null = null;
      const checkKeys = [stanzaId, normStanza, cleanId, normClean, fullId].filter(Boolean) as string[];

      // 1. Búsqueda en el almacén persistente (rescuedStore)
      for (const k of checkKeys) {
        if (rescuedStore.has(k)) {
          dataToRender = rescuedStore.get(k)!;
          break;
        }
      }

      // 2. Búsqueda en liveCache de la sesión
      if (!dataToRender) {
        for (const k of checkKeys) {
          if (liveCache.has(k)) {
            dataToRender = liveCache.get(k)!;
            break;
          }
        }
      }

      // 3. Si no se encontró por ID exacto, buscar si fue un mensaje removido recientemente en este chat
      if (!dataToRender && lastRemovedMessage && (Date.now() - lastRemovedTime < 8000)) {
        if (lastRemovedMessage.chatName === currentChat || currentChat === 'WhatsApp Web') {
          dataToRender = lastRemovedMessage;
        }
      }

      // ¡IMPORTANTE! NUNCA asignar recentOut[0] a ciegas. Si un mensaje no está en el almacén de rescatados,
      // NO debemos tomar un mensaje vivo que no ha sido borrado para reemplazarlo.

      // 4. Si encontramos los datos, restaurar inmediatamente
      if (dataToRender && (dataToRender.text || dataToRender.media)) {
        if (isGarbageMessageText(dataToRender.text)) {
          dataToRender.text = null;
        }
        if (dataToRender.text || dataToRender.media) {
          if (isOut) dataToRender.isOutgoing = true;
          restoreMessageInDom(container, dataToRender);
          return;
        }
      }

      // 5. Si aún no tenemos los datos:
      // Reintentar hasta 8 veces para dar tiempo a sincronizar
      const retries = parseInt(container.getAttribute('data-phantom-check-retries') || '0', 10);
      if (retries < 8) {
        container.setAttribute('data-phantom-check-retries', (retries + 1).toString());
      } else {
        container.setAttribute('data-phantom-restored', 'true');
      }
    }
  }

  const capturedStatusHashes = new Set<string>();

  function cleanWaText(str: string | null | undefined): string {
    if (!str) return '';
    return str
      .replace(/[\u2000-\u206F\uFEFF\u00A0\u180E\u200B-\u200D\u2060]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let lastClickedStatusContact: string | null = null;
  let lastClickedStatusTime = 0;

  document.addEventListener('click', (e) => {
    try {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const item = target.closest('div[role="listitem"], div[role="button"], div._ak8l, div._ak8m, div[tabindex]');
      if (item) {
        const titleEl = item.querySelector('span[title], span[dir="auto"], span._ao3e, div[title]');
        const title = cleanWaText(titleEl?.getAttribute('title') || titleEl?.textContent);
        if (title && !isInvalidSenderName(title)) {
          lastClickedStatusContact = title;
          lastClickedStatusTime = Date.now();
        }
      }
    } catch { }
  }, true);

  function isInvalidSenderName(name: string | null | undefined): boolean {
    if (!name) return true;
    const clean = cleanWaText(name);
    if (clean.length < 2) return true;
    const lower = clean.toLowerCase();

    const forbidden = [
      'estado', 'estados', 'status', 'reciente', 'recientes', 'visto', 'vistos',
      'silenciado', 'silenciados', 'muted', 'recent', 'viewed', 'whatsapp', 'whatsapp web',
      'contacto', 'contactos', 'chat', 'chats', 'hoy', 'ayer', 'today', 'yesterday',
      'hace', 'ahora', 'justo ahora', 'en línea', 'online', 'escribiendo', 'typing',
      'mensajes', 'llamadas', 'comunidades', 'canales', 'canales recomendados',
      'nuevo chat', 'nueva comunidad', 'perfil', 'configuración', 'ajustes', 'settings',
      'cerrar', 'close', 'pausar', 'pause', 'reproducir', 'play'
    ];

    if (forbidden.some(word => lower === word || lower.startsWith(word + ' ') || lower.endsWith(' ' + word))) {
      return true;
    }

    if (/^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(lower)) return true;
    if (/^\d+$/.test(lower)) return true;
    if (/^(hace\s+\d+|ayer\s+a\s+las|hoy\s+a\s+las)/i.test(lower)) return true;

    return false;
  }

  function getStatusViewerContainer(): Element | null {
    // 1. Botón de cerrar de la historia
    const closeBtn = document.querySelector(
      '[data-icon="x-viewer"], [data-testid="x-viewer"], [data-testid="status-v3-close"], [data-icon="status-close"], [data-testid="status-viewer-close"]'
    );
    if (closeBtn) {
      const viewer = closeBtn.closest('div[role="dialog"], div[tabindex="-1"], div._aigv, div[data-animate-status-v3="true"]');
      if (viewer && viewer !== document.body && !viewer.querySelector('#main, [data-id]')) return viewer;
      const parent = closeBtn.parentElement?.closest('div');
      if (parent && parent !== document.body && !parent.querySelector('#main, [data-id]')) return parent;
    }

    // 2. Diálogo modal abierto que contenga media o tarjetas de estado y no sea el chat
    const dialogs = document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]');
    for (const d of Array.from(dialogs)) {
      if (d === document.body) continue;
      if (!d.querySelector('#main, [data-id]') && d.querySelector('video, img, [data-testid*="status"]')) {
        return d;
      }
    }

    // 3. Detección por media en pantalla completa/overlay fuera del flujo de mensajes
    const allVideos = document.querySelectorAll('video');
    for (const v of Array.from(allVideos)) {
      if (v.closest('#main, [data-id], .message-in, .message-out')) continue;
      const rect = v.getBoundingClientRect();
      if ((rect.width > 160 || v.videoWidth > 160) && rect.height > 160) {
        return v.closest('div[tabindex], div[role], div._aigv') || v.parentElement;
      }
    }

    const allImages = document.querySelectorAll('img');
    for (const img of Array.from(allImages)) {
      if (img.classList.contains('emoji') || img.closest('[data-icon]') || img.closest('header') || img.closest('#main, [data-id], .message-in, .message-out')) {
        continue;
      }
      const rect = img.getBoundingClientRect();
      if (rect.width > 180 && rect.height > 180 && img.naturalWidth > 100) {
        return img.closest('div[tabindex], div[role], div._aigv') || img.parentElement;
      }
    }

    return null;
  }

  function extractStatusSender(container: Element): string | null {
    if (!container || container === document.body) return null;

    // 1. En la barra superior del visor de historias (header o Y < 140px)
    const rect = container.getBoundingClientRect();
    const candidates = container.querySelectorAll(
      'header span[dir="auto"], header div[dir="auto"], header span[title], span[title], span[dir="auto"], div[dir="auto"]'
    );

    for (const el of Array.from(candidates)) {
      const elRect = el.getBoundingClientRect();
      if ((elRect.top - rect.top) >= 0 && (elRect.top - rect.top) < 140) {
        const title = cleanWaText(el.getAttribute('title'));
        if (title && !isInvalidSenderName(title) && title.length >= 2 && title.length <= 40) {
          return title;
        }
        const text = cleanWaText(el.textContent);
        if (text && !isInvalidSenderName(text) && text.length >= 2 && text.length <= 40) {
          return text;
        }
      }
    }

    // 2. Si el usuario dio clic recientemente en un contacto en la lista de historias (< 45s)
    if (lastClickedStatusContact && (Date.now() - lastClickedStatusTime < 45000)) {
      return lastClickedStatusContact;
    }

    // 3. En el listado lateral, buscar el item activo/seleccionado
    const activeItem = document.querySelector('div[role="listitem"][aria-selected="true"], div[role="listitem"]._ak8l, div[role="listitem"]._ak8m');
    if (activeItem) {
      const nameEl = activeItem.querySelector('span[title], span[dir="auto"]');
      const name = cleanWaText(nameEl?.getAttribute('title') || nameEl?.textContent);
      if (name && !isInvalidSenderName(name)) {
        return name;
      }
    }

    return null;
  }

  async function detectAndCaptureWhatsAppStatus() {
    const container = getStatusViewerContainer();
    if (!container || container === document.body) return;

    const sender = extractStatusSender(container);
    if (!sender || isInvalidSenderName(sender)) return; // Si no hay contacto real válido, jamás capturar

    let media: { type: 'image' | 'video'; dataUrl: string } | null = null;
    let caption: string | undefined;

    // 1. Video en el visor
    const videos = Array.from(container.querySelectorAll('video')) as HTMLVideoElement[];
    const mainVideo = videos.find(v => {
      const rect = v.getBoundingClientRect();
      return (rect.width > 150 || v.videoWidth > 150) && v.readyState >= 1;
    });

    if (mainVideo) {
      const captured = await captureMedia(mainVideo);
      if (captured && captured.dataUrl) {
        // Si el fotograma es imagen JPEG, guardar como 'image', sólo como 'video' si es stream real
        media = {
          type: captured.type === 'video' ? 'video' : 'image',
          dataUrl: captured.dataUrl
        };
      }
    }

    // 2. Imagen en el visor (excluyendo la foto de perfil en el header, spinners y emojis)
    if (!media) {
      const images = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
      const mainImg = images.find(img => {
        if (img.classList.contains('emoji') || img.closest('[data-icon]')) return false;
        if (img.closest('header') || img.closest('[data-testid*="header"]')) return false; // Excluir avatar

        const src = (img.currentSrc || img.src || '').toLowerCase();
        if (src.includes('spinner') || src.includes('loading') || src.includes('circle') || src.startsWith('data:image/svg')) return false;

        const rect = img.getBoundingClientRect();
        const hasSize = (img.naturalWidth > 150 && img.naturalHeight > 150) || (rect.width > 150 && rect.height > 150);
        return hasSize && img.complete && img.naturalWidth > 0;
      });

      if (mainImg) {
        const captured = await captureMedia(mainImg);
        if (captured && captured.dataUrl) {
          media = { type: 'image', dataUrl: captured.dataUrl };
        }
      }
    }

    // 3. Caption text
    const captionEl = container.querySelector(
      'div[data-testid="status-caption"], div[class*="caption"] span, div[dir="ltr"].selectable-text'
    );
    if (captionEl && captionEl.textContent) {
      const cText = cleanWaText(captionEl.textContent);
      if (cText && cText !== sender && !isInvalidSenderName(cText)) {
        caption = cText;
      }
    }

    // 4. Estado de solo texto con fondo de color
    if (!media) {
      const textElem = container.querySelector(
        'span.selectable-text, div.selectable-text, div[dir="ltr"]._ao3e, div[dir="rtl"]._ao3e, div[class*="text-status"]'
      );
      if (textElem && textElem.textContent) {
        const statusText = cleanWaText(textElem.textContent);
        if (statusText && statusText !== sender && !isInvalidSenderName(statusText) && statusText.length >= 2) {
          let bgColor = '#128c7e';
          let cur: HTMLElement | null = textElem.parentElement;
          while (cur && cur !== container) {
            const bg = window.getComputedStyle(cur).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              bgColor = bg;
              break;
            }
            cur = cur.parentElement;
          }
          const cardUrl = renderTextStatusCard(statusText, bgColor);
          if (cardUrl) {
            media = { type: 'image', dataUrl: cardUrl };
            caption = statusText;
          }
        }
      }
    }

    if (!media || !media.dataUrl || media.dataUrl.length < 300) return;

    // Deduplication check
    const contentHash = sender + '_' + media.dataUrl.slice(50, 120) + (caption ? '_' + caption.slice(0, 20) : '');
    if (capturedStatusHashes.has(contentHash)) return;
    capturedStatusHashes.add(contentHash);

    const statusId = 'st_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    try {
      await ipcRenderer.invoke('save-saved-status', {
        id: statusId,
        sender,
        timestamp: Date.now(),
        mediaType: media.type,
        mediaUrl: media.dataUrl,
        caption,
        savedAt: Date.now()
      });
      console.log(`[Ojo de Halcón] ✓ Estado guardado exitosamente de ${sender} (${media.type})`);
    } catch (err) {
      console.warn('[Ojo de Halcón] Error guardando estado:', err);
    }
  }

  const observer = new MutationObserver((mutations) => {
    let checkStatuses = false;

    for (const m of mutations) {
      if (m.type === 'childList' && m.removedNodes.length > 0) {
        if (m.removedNodes.length > 2) {
          lastRemovedMessage = null;
          lastRemovedTime = 0;
        } else {
          m.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as Element;
              const fullId = getMessageFullId(el);
              const stanzaId = extractStanzaId(fullId);
              const normStanza = normalizeStanza(stanzaId);
              const cleanId = fullId ? fullId.replace(/_(recalled|revoked|deleted)$/i, '') : null;
              const normClean = normalizeStanza(cleanId);
              const checkKeys = [stanzaId, normStanza, cleanId, normClean].filter(Boolean) as string[];

              for (const k of checkKeys) {
                if (liveCache.has(k) || rescuedStore.has(k)) {
                  lastRemovedMessage = liveCache.get(k) || rescuedStore.get(k)!;
                  lastRemovedTime = Date.now();
                  break;
                }
              }
            }
          });
        }
      }

      if (m.type === 'childList' && m.addedNodes.length > 0) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            const msgEl = getMessageContainer(el);
            if (msgEl) {
              cacheMessageNode(msgEl);
              checkForDeletion(msgEl);
            }
            if (el.querySelectorAll) {
              el.querySelectorAll('.message-in, .message-out, [data-id]').forEach(sub => {
                const subMsg = getMessageContainer(sub);
                if (subMsg) {
                  cacheMessageNode(subMsg);
                  checkForDeletion(subMsg);
                }
              });
            }
            if (isDeletionText(el.textContent || '')) {
              const dMsg = getMessageContainer(el);
              if (dMsg) checkForDeletion(dMsg);
            }
            if (
              el.matches?.('[data-icon*="viewer"], [data-icon*="status"], video, img') ||
              el.querySelector?.('[data-icon*="viewer"], [data-icon*="status"], video, img')
            ) {
              checkStatuses = true;
            }
          }
        });
      }

      if (m.type === 'attributes' && m.attributeName === 'data-id') {
        const target = (m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement) as Element;
        const msgEl = getMessageContainer(target);
        if (msgEl) {
          cacheMessageNode(msgEl);
          checkForDeletion(msgEl);
        }
      }

      if (m.type === 'characterData' || (m.type === 'attributes' && (m.attributeName === 'data-icon' || m.attributeName === 'class'))) {
        const target = (m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement) as Element;
        const msgEl = getMessageContainer(target);
        if (msgEl) checkForDeletion(msgEl);
      }
    }

    if (checkStatuses) {
      detectAndCaptureWhatsAppStatus();
    }
  });

  function start() {
    loadRescuedStore();

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-icon', 'class', 'data-testid', 'src', 'data-id']
    });

    document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(msg => {
      const c = getMessageContainer(msg);
      if (c) {
        cacheMessageNode(c);
        checkForDeletion(c);
      }
    });

    setInterval(() => {
      loadRescuedStore();
      document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(msg => {
        const c = getMessageContainer(msg);
        if (c) {
          cacheMessageNode(c);
          checkForDeletion(c);
        }
      });
      detectAndCaptureWhatsAppStatus();
    }, 350);

    document.addEventListener('click', () => {
      setTimeout(detectAndCaptureWhatsAppStatus, 80);
      setTimeout(detectAndCaptureWhatsAppStatus, 300);
      setTimeout(detectAndCaptureWhatsAppStatus, 700);
    }, true);

    document.addEventListener('play', () => {
      setTimeout(detectAndCaptureWhatsAppStatus, 50);
      setTimeout(detectAndCaptureWhatsAppStatus, 250);
    }, true);

    document.addEventListener('loadeddata', () => {
      setTimeout(detectAndCaptureWhatsAppStatus, 50);
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

// Sincronización bidireccional con el almacén de Electron y phantom_cache.js
try {
  ipcRenderer.invoke('get-phantom-messages').then((saved: any[]) => {
    if (Array.isArray(saved) && saved.length > 0) {
      const KEY = '__OJO_DE_HALCON_RESCUED_STORE_V4__';
      const raw = localStorage.getItem(KEY);
      const existing = raw ? JSON.parse(raw) : [];
      const map = new Map<string, any>();
      existing.forEach((m: any) => { if (m && (m.id || m.coreId)) map.set(m.coreId || m.id, m); });
      saved.forEach((m: any) => {
        if (m && m.id) {
          map.set(m.id, {
            id: m.id,
            coreId: m.id,
            cleanId: m.id,
            text: m.text,
            media: m.mediaData ? { type: m.mediaType || 'image', dataUrl: m.mediaData } : null,
            sender: m.sender,
            chatName: m.chatName,
            isOutgoing: m.isOutgoing,
            timestamp: m.timestamp
          });
        }
      });
      const merged = Array.from(map.values()).slice(-400);
      localStorage.setItem(KEY, JSON.stringify(merged));
    }
  }).catch(() => {});

  ipcRenderer.on('phantom-message-updated', (event, updatedMsg) => {
    if (updatedMsg && updatedMsg.id) {
      try {
        const KEY = '__OJO_DE_HALCON_RESCUED_STORE_V4__';
        const raw = localStorage.getItem(KEY);
        const existing = raw ? JSON.parse(raw) : [];
        const map = new Map<string, any>();
        existing.forEach((m: any) => { if (m && (m.id || m.coreId)) map.set(m.coreId || m.id, m); });
        map.set(updatedMsg.id, {
          id: updatedMsg.id,
          coreId: updatedMsg.id,
          cleanId: updatedMsg.id,
          text: updatedMsg.text,
          media: updatedMsg.mediaData ? { type: updatedMsg.mediaType || 'image', dataUrl: updatedMsg.mediaData } : null,
          sender: updatedMsg.sender,
          chatName: updatedMsg.chatName,
          isOutgoing: updatedMsg.isOutgoing,
          timestamp: updatedMsg.timestamp
        });
        localStorage.setItem(KEY, JSON.stringify(Array.from(map.values()).slice(-400)));
      } catch (e) {}
    }
  });
} catch (e) {}

// Recibir mensajes desde phantom_cache.js de forma incondicional a nivel de módulo
window.addEventListener('message', (event) => {
  try {
    if (event.data?.type === 'PHANTOM_STATUS_CAPTURED' && event.data.data) {
      ipcRenderer.invoke('save-saved-status', event.data.data);
    }
    if (event.data?.type === 'PHANTOM_MESSAGE_CAPTURED' && event.data.data) {
      ipcRenderer.send('phantom-message-captured', event.data.data);
    }
  } catch (e) { }
});

let phantomGuardianStarted = false;
function tryStartPhantomGuardian() {
  if (phantomGuardianStarted) return;
  const isWa = window.location.hostname.includes('whatsapp.com') || window.location.href.includes('whatsapp.com');
  const isIg = window.location.hostname.includes('instagram.com') || window.location.href.includes('instagram.com');
  if (isWa || isIg) {
    phantomGuardianStarted = true;
    try {
      initPhantomWhatsAppGuardian();
    } catch (err) {
      console.error('[Ojo de Halcón Preload] Error inicializando:', err);
    }
  }
}

tryStartPhantomGuardian();
document.addEventListener('DOMContentLoaded', tryStartPhantomGuardian);
window.addEventListener('load', tryStartPhantomGuardian);
setInterval(tryStartPhantomGuardian, 1500);


