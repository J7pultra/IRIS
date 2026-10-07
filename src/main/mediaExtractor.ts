import { BrowserWindow } from 'electron';

export interface ExtractedMediaServer {
  server: string;
  title: string;
  url: string;
  code?: string;
}

export interface ExtractedMediaResult {
  success: boolean;
  type: 'youtube' | 'twitch' | 'vimeo' | 'dailymotion' | 'direct' | 'embed' | 'animeflv';
  title: string;
  url: string;
  embedUrl: string;
  thumb?: string;
  icon: string;
  platformName: string;
  servers?: ExtractedMediaServer[];
  channel?: string;
  vodId?: string;
  clipId?: string;
}

export class MediaExtractor {
  /**
   * Extrae automáticamente el reproductor de video limpio de cualquier plataforma
   * (AnimeFLV, Cuevana, Twitch, YouTube, Vimeo, Dailymotion, Directos o sitios de streaming)
   * para montarlo directamente en el marco del reproductor central con el chat al lado.
   */
  public static async extract(rawUrl: string): Promise<ExtractedMediaResult> {
    const url = (rawUrl || '').trim();

    // 1. YouTube
    const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/i);
    if (ytMatch) {
      const ytId = ytMatch[1];
      let title = `YouTube • ${ytId}`;
      try {
        const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`);
        if (oembed.ok) {
          const dat = await oembed.json();
          if (dat.title) title = dat.title;
        }
      } catch {}
      return {
        success: true,
        type: 'youtube',
        title,
        url,
        embedUrl: `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1`,
        thumb: `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`,
        icon: '🔴',
        platformName: 'YouTube'
      };
    }

    // 2. Twitch (Streams en vivo, VODs o Clips)
    const twitchClipMatch = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^/]+\/clip\/)([a-zA-Z0-9_-]+)/i);
    const twitchVodMatch = url.match(/(?:twitch\.tv\/videos\/)([0-9]+)/i);
    const twitchChannelMatch = url.match(/(?:twitch\.tv\/)(?!videos\/|directory\/|clip\/)([a-zA-Z0-9_]+)/i);
    if (twitchClipMatch) {
      const clipId = twitchClipMatch[1];
      return {
        success: true,
        type: 'twitch',
        title: `Twitch Clip • ${clipId}`,
        url,
        embedUrl: `https://clips.twitch.tv/embed?clip=${clipId}&parent=127.0.0.1&parent=localhost&autoplay=true`,
        icon: '💜',
        platformName: 'Twitch Clip',
        clipId
      };
    } else if (twitchVodMatch) {
      const vodId = twitchVodMatch[1];
      return {
        success: true,
        type: 'twitch',
        title: `Twitch VOD • ${vodId}`,
        url,
        embedUrl: `https://player.twitch.tv/?video=${vodId}&parent=127.0.0.1&parent=localhost&autoplay=true`,
        icon: '💜',
        platformName: 'Twitch VOD',
        vodId
      };
    } else if (twitchChannelMatch) {
      const channel = twitchChannelMatch[1];
      return {
        success: true,
        type: 'twitch',
        title: `Twitch • ${channel}`,
        url,
        embedUrl: `https://player.twitch.tv/?channel=${channel}&parent=127.0.0.1&parent=localhost&autoplay=true`,
        icon: '💜',
        platformName: 'Twitch',
        channel
      };
    }

    // 3. Vimeo
    const vimeoMatch = url.match(/(?:vimeo\.com\/)([0-9]+)/i);
    if (vimeoMatch) {
      const vimeoId = vimeoMatch[1];
      return {
        success: true,
        type: 'vimeo',
        title: `Vimeo • ${vimeoId}`,
        url,
        embedUrl: `https://player.vimeo.com/video/${vimeoId}?autoplay=1`,
        icon: '🎥',
        platformName: 'Vimeo'
      };
    }

    // 4. Dailymotion
    const dmMatch = url.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/i);
    if (dmMatch) {
      const dmId = dmMatch[1];
      return {
        success: true,
        type: 'dailymotion',
        title: `Dailymotion • ${dmId}`,
        url,
        embedUrl: `https://www.dailymotion.com/embed/video/${dmId}?autoplay=1`,
        icon: '📺',
        platformName: 'Dailymotion'
      };
    }

    // 5. Video directo o HLS (.mp4, .webm, .m3u8, .ogv, .mov, .mkv)
    const isDirectVideo = /\.(mp4|webm|m3u8|ogv|mov|mkv)(\?.*)?$/i.test(url) ||
      url.includes('.m3u8') ||
      url.includes('/video.mp4') ||
      url.includes('/stream');
    if (isDirectVideo) {
      let filename = 'Video Directo';
      try {
        const u = new URL(url);
        filename = decodeURIComponent(u.pathname.split('/').pop() || 'Video');
      } catch {}
      return {
        success: true,
        type: 'direct',
        title: filename,
        url,
        embedUrl: url,
        icon: '📹',
        platformName: url.includes('.m3u8') ? 'HLS Stream' : 'Video Directo'
      };
    }

    // 6. Servidores directos de Embed conocidos (YourUpload, Streamtape, Mega, Ok.ru, Fembed)
    if (url.includes('yourupload.com/watch/') || url.includes('yourupload.com/embed/')) {
      const id = url.split('/').pop()?.split('?')[0];
      return {
        success: true,
        type: 'embed',
        title: 'Video • YourUpload',
        url,
        embedUrl: `https://www.yourupload.com/embed/${id}`,
        icon: '🍿',
        platformName: 'YourUpload'
      };
    }
    if (url.includes('streamtape.com/v/') || url.includes('streamtape.com/e/')) {
      const parts = url.split('/');
      const id = parts[4] || parts.pop()?.split('?')[0];
      return {
        success: true,
        type: 'embed',
        title: 'Video • Streamtape',
        url,
        embedUrl: `https://streamtape.com/e/${id}`,
        icon: '🍿',
        platformName: 'Streamtape'
      };
    }
    if (url.includes('mega.nz/embed/') || url.includes('mega.nz/file/')) {
      const embedUrl = url.replace('/file/', '/embed/');
      return {
        success: true,
        type: 'embed',
        title: 'Video • MEGA',
        url,
        embedUrl,
        icon: '💾',
        platformName: 'MEGA'
      };
    }

    // 7. Extracción de AnimeFLV, Cuevana, Pelisplus u otras webs de streaming en segundo plano
    const isAnimeFlv = url.includes('animeflv.net');
    const isMovieSite = url.includes('cuevana') || url.includes('pelis') || url.includes('repelis') || url.includes('anime');

    if (isAnimeFlv || isMovieSite || url.startsWith('http')) {
      try {
        const extracted = await this.extractFromBackgroundWindow(url);
        if (extracted) {
          return extracted;
        }
      } catch (err) {
        console.warn('[MediaExtractor] Error extrayendo en segundo plano:', err);
      }
    }

    // 8. Fallback: Embeber directamente como marco de video
    let domain = 'Web';
    try {
      domain = new URL(url).hostname.replace('www.', '');
    } catch {}

    return {
      success: true,
      type: 'embed',
      title: `${domain}`,
      url,
      embedUrl: url,
      icon: '🌐',
      platformName: domain
    };
  }

  /**
   * Carga la página web en una ventana Chromium oculta durante 2-4 segundos
   * para pasar Cloudflare y extraer automáticamente el reproductor de video (AnimeFLV var videos, etc.)
   */
  private static extractFromBackgroundWindow(targetUrl: string): Promise<ExtractedMediaResult | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 768,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:beta-session'
        }
      });

      win.setMenu(null);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try { win.destroy(); } catch {}
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 7000);

      win.webContents.on('did-finish-load', async () => {
        // Dar 600ms para que se inicialicen scripts de la página
        await new Promise(r => setTimeout(r, 600));
        if (resolved) return;

        try {
          const result = await win.webContents.executeJavaScript(`
            (function() {
              // 1. AnimeFLV (var videos = { SUB: [...] })
              if (typeof videos !== 'undefined' && videos && videos.SUB && Array.isArray(videos.SUB)) {
                var rawTitle = (document.querySelector('h1.Title') || document.querySelector('title'))?.innerText || document.title;
                var cleanTitle = rawTitle.replace(/\\s+/g, ' ').replace('AnimeFLV', '').replace(/[-|•]/g, '').trim();

                // Buscar el mejor servidor disponible
                var chosen = videos.SUB.find(function(s) { return s.server === 'yu' || s.server === 'yourupload'; })
                  || videos.SUB.find(function(s) { return s.server === 'streamtape'; })
                  || videos.SUB.find(function(s) { return s.server === 'mega'; })
                  || videos.SUB.find(function(s) { return s.server === 'sfast'; })
                  || videos.SUB[0];

                var embedCode = chosen ? (chosen.code || chosen.url) : '';
                // Formatear si viene como URL o código
                if (embedCode && !embedCode.startsWith('http') && embedCode.includes('src="')) {
                  var m = embedCode.match(/src="([^"]+)"/);
                  if (m) embedCode = m[1];
                }

                var serversList = videos.SUB.map(function(s) {
                  var c = s.code || s.url || '';
                  if (c && !c.startsWith('http') && c.includes('src="')) {
                    var m2 = c.match(/src="([^"]+)"/);
                    if (m2) c = m2[1];
                  }
                  return {
                    server: s.server,
                    title: s.title || s.server,
                    url: c,
                    code: c
                  };
                }).filter(function(s) { return s.url && s.url.startsWith('http'); });

                return {
                  title: cleanTitle || 'Episodio de Anime',
                  embedUrl: embedCode,
                  servers: serversList,
                  platform: 'AnimeFLV',
                  icon: '🍿'
                };
              }

              // 2. Reproductores iframes de Cuevana, Pelisplus, etc.
              var ifr = document.querySelector('#video_box iframe, .CpCnC iframe, .embed-responsive iframe, iframe[src*="embed"], iframe[src*="stream"], iframe[src*="player"], iframe[src*="tape"], iframe[src*="yourupload"], iframe[src*="mega"]');
              if (ifr && ifr.src) {
                return {
                  title: document.title.replace(/\\s+/g, ' ').trim(),
                  embedUrl: ifr.src,
                  servers: [{ server: 'embed', title: 'Servidor Principal', url: ifr.src, code: ifr.src }],
                  platform: 'Cine Web',
                  icon: '🍿'
                };
              }

              // 3. Etiqueta video directa
              var v = document.querySelector('video');
              if (v && v.src) {
                return {
                  title: document.title.replace(/\\s+/g, ' ').trim(),
                  embedUrl: v.src,
                  isDirect: true,
                  servers: [{ server: 'direct', title: 'Video Directo', url: v.src, code: v.src }],
                  platform: 'Video Web',
                  icon: '📹'
                };
              }

              return null;
            })()
          `);

          if (result && result.embedUrl) {
            clearTimeout(timer);
            cleanup();
            resolve({
              success: true,
              type: result.platform === 'AnimeFLV' ? 'animeflv' : (result.isDirect ? 'direct' : 'embed'),
              title: result.title,
              url: targetUrl,
              embedUrl: result.embedUrl,
              icon: result.icon || '🍿',
              platformName: result.platform || 'Streaming',
              servers: result.servers
            });
            return;
          }
        } catch (e) {
          console.warn('[MediaExtractor] Error en executeJavaScript:', e);
        }
      });

      win.loadURL(targetUrl).catch(() => {
        clearTimeout(timer);
        cleanup();
        resolve(null);
      });
    });
  }
}
