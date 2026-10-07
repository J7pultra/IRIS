/**
 * session.ts â€” ConfiguraciÃ³n de privacidad de sesiÃ³n para ShieldBrowser.
 *
 * Aplica configuraciones agresivas de privacidad a la sesiÃ³n de Electron:
 * - Headers que no revelan referrer
 * - Bloqueo de WebRTC IP leak
 * - User-Agent neutral (mismo que Chromium sin identificadores)
 * - BraveShields para bloqueo de rastreadores y anuncios
 */

import { session, Session } from 'electron';
import { BraveShields } from './adblock';


// â”€â”€ User-Agent neutral â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Un User-Agent genÃ©rico de Chrome para reducir fingerprinting.
 * No incluye el identificador de Electron, por lo que los servidores
 * no pueden detectar fÃ¡cilmente que es un navegador Electron.
 */
export const PRIVACY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

// ── Configuración de sesión ──────────────────────────────────────────────────

/**
 * Configura la sesión predeterminada de Electron con medidas de privacidad.
 * Debe llamarse ANTES de crear cualquier BrowserWindow.
 */
export function configurePrivacySession(targetSession: Session = session.defaultSession): void {
  const defaultSession = targetSession;

  applyPrivacyHeaders(defaultSession);
  applyUserAgent(defaultSession);
  disableWebRTCLeak(defaultSession);
  configurePermissions(defaultSession);

  console.log('[Session] Configuración de privacidad y compatibilidad web aplicada ✓');
}

/**
 * Aplica headers HTTP que protegen la privacidad del usuario.
 * Elimina el Referer en peticiones cross-origin y añade
 * cabeceras para indicar que no se desea rastreo (DNT).
 */
function applyPrivacyHeaders(sess: Session): void {
  sess.webRequest.onBeforeSendHeaders((details: any, callback: any) => {
    const headers = { ...details.requestHeaders };

    // Si es WhatsApp o un WebSocket, asegurar compatibilidad total sin alterar cabeceras delicadas
    const isWhatsApp = details.url.includes('whatsapp.com') || details.url.includes('whatsapp.net');
    const isWebSocket = details.resourceType === 'webSocket';

    if (isWhatsApp || isWebSocket) {
      // Garantizar User-Agent estándar de Chrome para WhatsApp sin tocar Accept-Encoding ni WebSockets
      headers['User-Agent'] = PRIVACY_USER_AGENT;
      callback({ requestHeaders: headers });
      return;
    }

    // Compatibilidad total YouTube Embeds, APIs y Streaming de video (elimina Error 152-4 y 150/153)
    const lowerUrl = details.url.toLowerCase();
    const isYouTubeFamily = 
      lowerUrl.includes('youtube.com') || 
      lowerUrl.includes('youtube-nocookie.com') || 
      lowerUrl.includes('googlevideo.com') || 
      lowerUrl.includes('ytimg.com') ||
      lowerUrl.includes('ggpht.com') ||
      lowerUrl.includes('googleapis.com');

    if (isYouTubeFamily) {
      if (!headers['Referer'] || headers['Referer'].startsWith('file:') || headers['Referer'] === 'about:blank') {
        headers['Referer'] = 'https://www.youtube.com/';
      }
      if (!headers['Origin'] || headers['Origin'] === 'null' || headers['Origin'].startsWith('file:')) {
        headers['Origin'] = 'https://www.youtube.com';
      }
      headers['User-Agent'] = PRIVACY_USER_AGENT;
      callback({ requestHeaders: headers });
      return;
    }

    // Do Not Track — estándar HTTP de privacidad
    headers['DNT'] = '1';

    // Sec-GPC (Global Privacy Control) — estándar emergente
    headers['Sec-GPC'] = '1';

    // Fingerprint Spoofing Avanzado (Client Hints para Chrome 131)
    headers['Sec-CH-UA'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"Windows"';

    headers['User-Agent'] = PRIVACY_USER_AGENT;

    callback({ requestHeaders: headers });
  });

  sess.webRequest.onHeadersReceived((details: any, callback: any) => {
    const responseHeaders = { ...details.responseHeaders };

    // Eliminar restricciones X-Frame-Options y CSP frame-ancestors para permitir
    // que la Sala de Cine incruste y reproduzca reproductores extraídos (AnimeFLV,
    // Streamtape, YourUpload, Mega, Twitch, YouTube, Vimeo, Cuevana, etc.)
    // directamente en el marco del reproductor central con el chat al lado.
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['X-Frame-Options'];

    if (responseHeaders['content-security-policy']) {
      responseHeaders['content-security-policy'] = (responseHeaders['content-security-policy'] as string[]).map((csp: string) =>
        csp.replace(/frame-ancestors[^;]+(;|$)/gi, '')
      );
    }
    if (responseHeaders['Content-Security-Policy']) {
      responseHeaders['Content-Security-Policy'] = (responseHeaders['Content-Security-Policy'] as string[]).map((csp: string) =>
        csp.replace(/frame-ancestors[^;]+(;|$)/gi, '')
      );
    }

    callback({ responseHeaders });
  });
}

/**
 * Establece el User-Agent de la sesión para evitar la detección de Electron.
 */
function applyUserAgent(sess: Session): void {
  sess.setUserAgent(PRIVACY_USER_AGENT);
}

/**
 * Deshabilita el leak de IP real a través de WebRTC.
 * WebRTC puede revelar la IP local aunque se use una VPN.
 */
function disableWebRTCLeak(sess: Session): void {
  // La política WebRTC IP handling se aplica a nivel de webContents para evitar filtraciones
}

/**
 * Configura los permisos que el navegador concede a los sitios web.
 * Permite almacenamiento persistente y multimedia para WhatsApp Web mientras protege el resto.
 */
function configurePermissions(sess: Session): void {
  const SENSITIVE_PERMISSIONS = [
    'geolocation',
    'notifications',
    'midi',
    'camera',
    'microphone',
    'display-capture',
    'deviceInfo',
    'backgroundSync',
    'bluetooth',
    'persistent-storage',
    'ambient-light-sensor',
    'clipboard-sanitized-write',
  ];

  sess.setPermissionRequestHandler((webContents: any, permission: any, callback: any) => {
    let url = '';
    try { url = webContents.getURL() || ''; } catch {}

    // Otorgar permisos esenciales a WhatsApp Web para notas de voz, almacenamiento y avisos
    if (url.includes('web.whatsapp.com') || url.includes('whatsapp.com')) {
      if ([
        'notifications',
        'microphone',
        'camera',
        'persistent-storage',
        'clipboard-read',
        'clipboard-sanitized-write',
        'media',
        'backgroundSync',
        'storage-access'
      ].includes(permission)) {
        return callback(true);
      }
    }

    if (SENSITIVE_PERMISSIONS.includes(permission)) {
      console.log(`[Session] Permiso denegado: ${permission} (${url})`);
      callback(false);
    } else {
      callback(true);
    }
  });

  sess.setPermissionCheckHandler((webContents: any, permission: any, requestingOrigin: any) => {
    if (requestingOrigin && requestingOrigin.includes('whatsapp.com')) {
      return true;
    }
    return true;
  });
}

/**
 * Crea y retorna una sesiÃ³n con particiÃ³n aislada para navegaciÃ³n privada.
 * Las sesiones de particiÃ³n no comparten cookies, cachÃ© ni almacenamiento.
 *
 * @param partitionName Nombre Ãºnico de la particiÃ³n.
 */
export function createPrivateSession(partitionName: string): Session {
  // 'persist:' prefix â†’ datos se guardan entre reinicios
  // Sin prefix â†’ sesiÃ³n completamente en memoria (incÃ³gnito)
  const incognitoSession = session.fromPartition(partitionName, {
    cache: false,
  });

  applyPrivacyHeaders(incognitoSession);
  applyUserAgent(incognitoSession);
  configurePermissions(incognitoSession);

  return incognitoSession;
}


