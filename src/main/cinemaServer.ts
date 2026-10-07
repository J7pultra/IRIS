import * as http from 'http';

/**
 * CinemaServer — Servidor HTTP local ultra-ligero para reproducir contenido multimedia y YouTube
 * sin violaciones de origen (protocolo file://), eliminando de raíz el Error 152-4 y 150/153.
 */
export class CinemaServer {
  private static server: http.Server | null = null;
  private static port: number = 0;

  public static async start(): Promise<number> {
    if (this.server && this.port > 0) {
      return this.port;
    }

    return new Promise((resolve) => {
      try {
        this.server = http.createServer((req, res) => {
          const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

          if (urlObj.pathname === '/player' || urlObj.pathname === '/player.html') {
            const videoId = urlObj.searchParams.get('v') || '';
            const autoplay = urlObj.searchParams.get('autoplay') === '1' ? '1' : '0';
            const startSec = parseInt(urlObj.searchParams.get('start') || '0', 10);

            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Referrer-Policy': 'strict-origin-when-cross-origin'
            });

            res.end(this.renderPlayerHtml(videoId, autoplay, startSec));
            return;
          }

          if (urlObj.pathname === '/twitch') {
            const channel = urlObj.searchParams.get('channel') || '';
            const video = urlObj.searchParams.get('video') || '';
            const clip = urlObj.searchParams.get('clip') || '';

            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            });

            res.end(this.renderTwitchHtml(channel, video, clip));
            return;
          }

          if (urlObj.pathname === '/video') {
            const videoUrl = urlObj.searchParams.get('url') || '';
            const autoplay = urlObj.searchParams.get('autoplay') === '1';

            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            });

            res.end(this.renderDirectVideoHtml(videoUrl, autoplay));
            return;
          }

          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        });

        // Escucha en 127.0.0.1 en puerto dinámico (puerto 0 para que el SO asigne uno libre)
        this.server.listen(0, '127.0.0.1', () => {
          const addr = this.server?.address();
          if (addr && typeof addr === 'object') {
            this.port = addr.port;
            console.log(`[CinemaServer] Servidor HTTP local iniciado con éxito en http://127.0.0.1:${this.port} ✓`);
            resolve(this.port);
          } else {
            resolve(0);
          }
        });

        this.server.on('error', (err) => {
          console.error('[CinemaServer] Error en servidor HTTP local:', err);
          resolve(0);
        });
      } catch (err) {
        console.error('[CinemaServer] Excepción al arrancar servidor:', err);
        resolve(0);
      }
    });
  }

  public static getPort(): number {
    return this.port;
  }

  public static stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
      this.port = 0;
    }
  }

  private static renderPlayerHtml(videoId: string, autoplay: string, startSec: number): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>Cinema Player</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #player-mount, iframe {
      width: 100%;
      height: 100%;
      border: none;
      position: absolute;
      top: 0;
      left: 0;
    }
    #fallback-container {
      display: none;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      background: #000;
      color: #fff;
      font-family: sans-serif;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 20px;
    }
    .fallback-btn {
      margin-top: 14px;
      padding: 10px 18px;
      background: #ef4444;
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div id="player-mount"></div>

  <div id="fallback-container">
    <h3>⚠️ Este video tiene restricciones de inserción del autor</h3>
    <p style="margin-top: 8px; color: #94a3b8; font-size: 13px;">El autor de este video ha desactivado su reproducción en reproductores embebidos (Código 150/101).</p>
    <button class="fallback-btn" id="open-tab-btn">Mirar en Pestaña</button>
  </div>

  <script>
    (function() {
      const urlParams = new URLSearchParams(window.location.search);
      const vId = urlParams.get('v') || '${videoId}';
      const auto = (urlParams.get('autoplay') === '1' || '${autoplay}' === '1');
      const start = parseInt(urlParams.get('start') || '${startSec}' || '0', 10);

      let player = null;
      let isReady = false;
      let lastKnownTime = start;

      window.onYouTubeIframeAPIReady = function() {
        try {
          player = new YT.Player('player-mount', {
            width: '100%',
            height: '100%',
            videoId: vId,
            host: 'https://www.youtube.com',
            playerVars: {
              autoplay: auto ? 1 : 0,
              controls: 1,
              start: start,
              rel: 0,
              enablejsapi: 1,
              modestbranding: 1,
              playsinline: 1,
              origin: window.location.origin
            },
            events: {
              onReady: function(e) {
                isReady = true;
                window.parent.postMessage({ source: 'cinema-player-frame', event: 'ready' }, '*');
                if (auto) {
                  try { e.target.playVideo(); } catch(err) {}
                }
              },
              onStateChange: function(e) {
                window.parent.postMessage({ source: 'cinema-player-frame', event: 'stateChange', data: e.data }, '*');
              },
              onError: function(e) {
                console.warn('[CinemaPlayerFrame] Error reportado por YouTube:', e.data);
                window.parent.postMessage({ source: 'cinema-player-frame', event: 'error', data: e.data }, '*');
                if (e.data === 150 || e.data === 101) {
                  const fb = document.getElementById('fallback-container');
                  if (fb) fb.style.display = 'flex';
                }
              }
            }
          });
        } catch (err) {
          console.error('[CinemaPlayerFrame] Error inicializando YT.Player:', err);
          mountDirectIframe(vId, auto, start);
        }
      };

      function mountDirectIframe(vid, shouldPlay, startSec) {
        const mount = document.getElementById('player-mount');
        if (!mount) return;
        mount.innerHTML = '<iframe ' +
          'id="direct-yt-iframe" ' +
          'src="https://www.youtube.com/embed/' + encodeURIComponent(vid) + '?autoplay=' + (shouldPlay ? '1' : '0') + '&controls=1&start=' + startSec + '&rel=0&enablejsapi=1&origin=' + encodeURIComponent(window.location.origin) + '" ' +
          'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ' +
          'referrerpolicy="strict-origin-when-cross-origin" ' +
          'allowfullscreen>' +
          '</iframe>';
      }

      // Escucha de comandos desde la UI del navegador (renderer.ts)
      window.addEventListener('message', function(ev) {
        if (!ev.data || ev.data.source !== 'cinema-parent') return;
        const cmd = ev.data.command;

        try {
          if (cmd === 'loadVideo') {
            if (player && typeof player.loadVideoById === 'function') {
              player.loadVideoById({
                videoId: ev.data.videoId,
                startSeconds: ev.data.startSeconds || 0
              });
              if (ev.data.play) {
                try { player.playVideo(); } catch(e) {}
              } else {
                try { player.pauseVideo(); } catch(e) {}
              }
            } else {
              window.location.href = '/player?v=' + encodeURIComponent(ev.data.videoId) + '&autoplay=' + (ev.data.play ? '1' : '0') + '&start=' + (ev.data.startSeconds || 0);
            }
          } else if (cmd === 'play') {
            if (player && typeof player.playVideo === 'function') player.playVideo();
          } else if (cmd === 'pause') {
            if (player && typeof player.pauseVideo === 'function') player.pauseVideo();
          } else if (cmd === 'seek') {
            if (player && typeof player.seekTo === 'function') player.seekTo(ev.data.time, true);
          } else if (cmd === 'getTime') {
            let t = 0;
            if (player && typeof player.getCurrentTime === 'function') {
              try { t = player.getCurrentTime(); } catch(e) {}
            }
            lastKnownTime = t;
            window.parent.postMessage({
              source: 'cinema-player-frame',
              event: 'timeUpdate',
              time: t,
              reqId: ev.data.reqId
            }, '*');
          }
        } catch(e) {
          console.warn('[CinemaPlayerFrame] Error ejecutando comando:', cmd, e);
        }
      });

      document.getElementById('open-tab-btn')?.addEventListener('click', function() {
        window.parent.postMessage({ source: 'cinema-player-frame', event: 'openInTab', videoId: vId }, '*');
      });

      // Reportar periódicamente el tiempo de reproducción para sincronización P2P fluida
      setInterval(function() {
        if (player && typeof player.getCurrentTime === 'function' && isReady) {
          try {
            const t = player.getCurrentTime();
            if (typeof t === 'number' && !isNaN(t)) {
              lastKnownTime = t;
              window.parent.postMessage({ source: 'cinema-player-frame', event: 'timeUpdate', time: t }, '*');
            }
          } catch(e) {}
        }
      }, 1000);

      // Cargar script de la API oficial de YouTube con fallback
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScript = document.getElementsByTagName('script')[0];
      firstScript.parentNode.insertBefore(tag, firstScript);

      // Si después de 3.5 segundos la API de YT no respondió, montar iframe directo
      setTimeout(function() {
        if (!player && !isReady) {
          console.warn('[CinemaPlayerFrame] Timeout cargando YouTube API, activando fallback directo');
          mountDirectIframe(vId, auto, start);
        }
      }, 3500);
    })();
  </script>
</body>
</html>`;
  }

  private static renderTwitchHtml(channel: string, video: string, clip: string): string {
    let src = '';
    if (clip) {
      src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip)}&parent=127.0.0.1&parent=localhost&autoplay=true`;
    } else if (video) {
      src = `https://player.twitch.tv/?video=${encodeURIComponent(video)}&parent=127.0.0.1&parent=localhost&autoplay=true`;
    } else {
      src = `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=127.0.0.1&parent=localhost&autoplay=true`;
    }

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${src}" allowfullscreen allow="autoplay; fullscreen"></iframe>
</body>
</html>`;
  }

  private static renderDirectVideoHtml(videoUrl: string, autoplay: boolean): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; display: flex; align-items: center; justify-content: center; }
    video { width: 100%; height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <video id="cinema-video" src="${videoUrl}" controls ${autoplay ? 'autoplay' : ''}></video>
  <script>
    (function() {
      const v = document.getElementById('cinema-video');
      let isRemote = false;
      v.addEventListener('play', function() {
        if (isRemote) return;
        window.parent.postMessage({ source: 'cinema-direct-frame', event: 'play', time: v.currentTime }, '*');
      });
      v.addEventListener('pause', function() {
        if (isRemote) return;
        window.parent.postMessage({ source: 'cinema-direct-frame', event: 'pause', time: v.currentTime }, '*');
      });
      v.addEventListener('seeked', function() {
        if (isRemote) return;
        window.parent.postMessage({ source: 'cinema-direct-frame', event: 'seek', time: v.currentTime }, '*');
      });
      window.addEventListener('message', function(e) {
        if (e.data && e.data.source === 'cinema-host-cmd') {
          isRemote = true;
          setTimeout(function() { isRemote = false; }, 400);
          if (e.data.action === 'play') {
            if (typeof e.data.time === 'number' && Math.abs(v.currentTime - e.data.time) > 1.2) v.currentTime = e.data.time;
            v.play().catch(function(){});
          } else if (e.data.action === 'pause') {
            if (typeof e.data.time === 'number' && Math.abs(v.currentTime - e.data.time) > 1.2) v.currentTime = e.data.time;
            v.pause();
          } else if (e.data.action === 'seek') {
            if (typeof e.data.time === 'number') v.currentTime = e.data.time;
          }
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
