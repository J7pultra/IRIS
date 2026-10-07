import { session, ipcMain, BrowserWindow } from 'electron';
import ytDlp, { exec as ytDlpExec } from 'yt-dlp-exec';
import { YouTubeExtractor } from './youtubeExtractor';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import fetch from 'cross-fetch';
import { ConcurrentDownloader } from './downloadManager';
import { StorageService } from './storageService';
import { PRIVACY_USER_AGENT } from './session';

export interface DownloadOption {
  formatId?: string;
  type?: string;
  resolution?: string; // para video, ej: "1080p", "720p"
  label?: string;      // para audio o genérico
  url: string;         // url principal a descargar
  audioUrl?: string;   // si es video_full y el video no tiene audio, la url del mejor audio
  ext?: string;        // extensión de archivo (ej: 'mp3', 'm4a')
  size?: string;       // tamaño en MB (ej: '137.9 MB')
}

export interface StructuredMediaInfo {
  isDrmLocked: boolean;
  originalUrl: string;
  title?: string;
  thumbnail?: string;
  downloads: {
    video_full: DownloadOption[];
    audio_only: DownloadOption[];
    video_only: DownloadOption[];
  };
}

export class MediaSniffer {
  private static detectedMedia: Map<string, StructuredMediaInfo> = new Map(); // tabId -> media info

  private static scanningTabs: Set<string> = new Set();
  private static ffmpegPath: string;

  public static init(mainWindow: BrowserWindow) {
    // 1. Resolver path de ffmpeg-static
    try {
      // En desarrollo (asar=false), node_modules está disponible.
      // En producción (asar=true), node_modules/ffmpeg-static está en app.asar.unpacked
      const ffmpeg = require('ffmpeg-static');
      MediaSniffer.ffmpegPath = ffmpeg.replace('app.asar', 'app.asar.unpacked');
      console.log('[MediaSniffer] FFmpeg detectado en:', MediaSniffer.ffmpegPath);
    } catch (e) {
      console.warn('[MediaSniffer] No se pudo localizar ffmpeg-static', e);
    }

    // 2. Interceptar tráfico de red (Sniffer)
    const filter = {
      urls: [
        '*://*/*.m3u8*', '*://*/*.mpd*', '*://*/*.mp4*', '*://*/*.webm*',
        '*://*.googlevideo.com/videoplayback*'
      ]
    };

    const targetSession = session.fromPartition('persist:beta-session');
    
    targetSession.webRequest.onHeadersReceived(filter, async (details, callback) => {
      // Dejamos pasar la petición normalmente (Cero Latencia)
      callback({ cancel: false, responseHeaders: details.responseHeaders });

      const url = details.url;
      
      // Ignorar fragmentos individuales para no saturar memoria
      if (url.includes('fragment') || url.includes('seg') || url.match(/-[0-9]+\.m4s/)) {
        return;
      }

      const tabId = MediaSniffer.findTabIdByWebContentsId((details as any).webContentsId);
      console.log(`[MediaSniffer] Interceptado: ${url} (webContentsId: ${(details as any).webContentsId}, tabId: ${tabId})`);
      
      if (!tabId) return;

      if (url.includes('.m3u8') || url.includes('.mpd')) {
        // HLS o DASH -> Heurística DRM asíncrona
        MediaSniffer.analyzeManifestForDrm(details.url, tabId, mainWindow);
      } else if (url.includes('.mp4') || url.includes('.webm') || url.includes('videoplayback')) {
        // Archivo directo sin DRM visible en manifiesto
        // Verificamos que sea de video por los parámetros si es de youtube
        if (url.includes('videoplayback') && url.includes('mime=audio')) {
           console.log(`[MediaSniffer] Ignorando audio puro: ${url}`);
           return; // Ignorar streams de solo audio para no duplicar botones
        }
        
        console.log(`[MediaSniffer] Video directo detectado (Tab ${tabId}):`, details.url);
        MediaSniffer.notifyMediaDetected(tabId, mainWindow, {
          isDrmLocked: false,
          originalUrl: details.url,
          downloads: {
            video_full: [{ label: 'Calidad Adaptativa', url: details.url }],
            audio_only: [],
            video_only: []
          }
        });
      }
    });

    // Nota: 'start-media-download' se registra SOLO en ipc.ts para evitar handler duplicado.
  }

  /**
   * Peek superficial al manifiesto para detectar DRM
   */
  private static async analyzeManifestForDrm(url: string, tabId: string, mainWindow: BrowserWindow) {
    try {
      // Hacemos fetch solo de los primeros kilobytes
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s max

      const res = await fetch(url, { 
        signal: controller.signal as any,
        headers: {
          'User-Agent': PRIVACY_USER_AGENT,
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document'
        }
      });
      const text = await res.text();
      clearTimeout(timeoutId);

      // Heurística Evasión DRM
      if (
        text.includes('<ContentProtection') || 
        text.includes('urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed') || // Widevine
        text.includes('urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95') || // PlayReady
        text.includes('#EXT-X-KEY:METHOD=SAMPLE-AES') ||
        text.includes('URI="data:text/plain;base64')
      ) {
        console.log('[MediaSniffer] DRM detectado en:', url);
        MediaSniffer.notifyMediaDetected(tabId, mainWindow, {
          isDrmLocked: true,
          originalUrl: url,
          downloads: { video_full: [], audio_only: [], video_only: [] }
        });
        return;
      }

      // Si no hay DRM, extraer calidades (Simplificado para el ejemplo)
      const video_full: DownloadOption[] = [];
      if (url.endsWith('.m3u8')) {
        // Parseo muy básico de resoluciones HLS
        const regex = /RESOLUTION=(\d+x\d+)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
          video_full.push({ resolution: match[1], url: url });
        }
        if (video_full.length === 0) video_full.push({ label: 'Original (HLS)', url });
      } else {
        video_full.push({ label: 'Original (DASH)', url });
      }

      MediaSniffer.notifyMediaDetected(tabId, mainWindow, {
        isDrmLocked: false,
        originalUrl: url,
        downloads: { video_full, audio_only: [], video_only: [] }
      });

    } catch (e) {
      // Ignorar errores de fetch silenciosamente
    }
  }

  private static notifyMediaDetected(tabId: string, mainWindow: BrowserWindow, info: StructuredMediaInfo) {
    MediaSniffer.detectedMedia.set(tabId, info);
    if (info.isDrmLocked) {
      mainWindow.webContents.send('media-drm-locked', tabId);
    } else {
      const payload = {
        metadata: { title: info.title, thumbnail: info.thumbnail, originalUrl: info.originalUrl },
        formats: info.downloads
      };
      mainWindow.webContents.send('media-detected', tabId, payload);

      try {
        const { uiManager } = require('./main');
        if (uiManager && typeof uiManager.updateDownloadPopupData === 'function') {
          uiManager.updateDownloadPopupData({
            hasMedia: !info.isDrmLocked && !!info.downloads && Object.keys(info.downloads).length > 0,
            downloads: info.downloads,
            title: info.title || 'Video Detectado',
            thumbnail: info.thumbnail || '',
            metadata: {
              title: info.title || 'Video Detectado',
              thumbnail: info.thumbnail || '',
              originalUrl: info.originalUrl || ''
            }
          });
        }
      } catch {}
    }
  }

  public static getMediaForTab(tabId: string) {
    return MediaSniffer.detectedMedia.get(tabId);
  }

  public static clearMediaForTab(tabId: string) {
    MediaSniffer.detectedMedia.delete(tabId);
    MediaSniffer.scanningTabs.delete(tabId);
  }

  /**
   * Módulo de Ensamblaje Acelerado (Node.js + FFmpeg)
   */
  public static async downloadMedia(url: string, audioUrl?: string, mainWindow?: BrowserWindow, title?: string, quality?: string, ext?: string, type?: string, formatId?: string, originalUrl?: string): Promise<{ success: boolean; path?: string; error?: string }> {
    if (!MediaSniffer.ffmpegPath) {
      return { success: false, error: 'FFmpeg no instalado o no detectado.' };
    }

    const downloadsFolder = path.join(os.homedir(), 'Downloads');
    
    let baseFilename = 'Video';
    if (title) {
      baseFilename = title.replace(/[\\/:*?"<>|\[\]]/g, '').trim() || 'Video';
    }
    const suffix = quality && quality !== 'max' ? `_${quality.replace(/[<>:"/\\|?*]+/g, '').trim()}` : '';
    let finalExt = ext || 'mp4';
    if (type === 'audio_only' && !ext) finalExt = 'm4a';
    
    let filename = `${baseFilename}${suffix}.${finalExt}`;
    let outputPath = path.join(downloadsFolder, filename);

    // Manejo de Duplicados
    let counter = 1;
    while (fs.existsSync(outputPath)) {
      filename = `${baseFilename}${suffix} (${counter}).${finalExt}`;
      outputPath = path.join(downloadsFolder, filename);
      counter++;
    }

    // Generar ID único para registrar la descarga en el StorageService
    const downloadId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    
    StorageService.updateDownload({
      id: downloadId,
      filename,
      url,
      savePath: outputPath,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: 0
    });

    const broadcastProgress = (percent: number, speed: number, status: string) => {
      const { webContents } = require('electron');
      webContents.getAllWebContents().forEach((wc: any) => {
        if (!wc.isDestroyed()) {
          wc.send('download-progress', { percent, speed, status });
        }
      });
    };

    let videoTempFile: string | null = null;
    let audioTempFile: string | null = null;

    try {
      // 1. Resolver URL final y verificar si es YouTube
      let targetUrl = originalUrl || url;
      if (mainWindow) {
        try {
          const { viewManager } = require('./main');
          if (viewManager && viewManager.activeTabId) {
            const activeView = viewManager.views.get(viewManager.activeTabId);
            if (activeView) {
              const currentUrl = activeView.webContents.getURL();
              if (currentUrl && (currentUrl.includes('youtube.com') || currentUrl.includes('youtu.be'))) {
                targetUrl = currentUrl;
              }
            }
          }
        } catch (e) {}
      }

      if (targetUrl.includes('googlevideo.com') || !targetUrl.includes('http')) {
        for (const [tId, media] of MediaSniffer.detectedMedia.entries()) {
          if (media.originalUrl && (media.originalUrl.includes('youtube.com') || media.originalUrl.includes('youtu.be'))) {
            targetUrl = media.originalUrl;
            break;
          }
        }
      }

      const isYouTube = (targetUrl && (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be'))) ||
                        (url && (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('googlevideo.com'))) ||
                        (originalUrl && (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be')));

      // ── MODO YOUTUBE (Vía yt-dlp nativo con cookies, multiplexado y aceleración) ──
      if (isYouTube) {
        console.log(`[MediaSniffer] YouTube detectado, ejecutando descarga vía yt-dlp. Tipo: ${type}, Calidad: ${quality}, FormatId: ${formatId}`);
        broadcastProgress(0.05, 0, 'Iniciando descarga con yt-dlp...');

        let cookiePath: string | null = null;
        try {
          const shieldSession = session.fromPartition('persist:beta-session');
          const cookies = await shieldSession.cookies.get({ url: 'https://www.youtube.com' });
          if (cookies.length > 0) {
            cookiePath = path.join(os.tmpdir(), `yt_dl_cookies_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.txt`);
            let netscapeText = '# Netscape HTTP Cookie File\n';
            for (const c of cookies) {
              const domain = c.domain || '.youtube.com';
              const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
              const secure = c.secure ? 'TRUE' : 'FALSE';
              const expiration = c.expirationDate ? Math.round(c.expirationDate) : 0;
              netscapeText += `${domain}\t${includeSubdomains}\t${c.path}\t${secure}\t${expiration}\t${c.name}\t${c.value}\n`;
            }
            fs.writeFileSync(cookiePath, netscapeText);
          }
        } catch (e) {
          console.warn('[MediaSniffer] Error preparando cookies de YouTube:', e);
        }

        return await new Promise((resolve, reject) => {
          const ytdlpPath = require('path').resolve(
            require.resolve('yt-dlp-exec'),
            '../../bin/yt-dlp' + (process.platform === 'win32' ? '.exe' : '')
          );

          let args: string[] = [];

          if (type === 'audio_converted' && (finalExt === 'mp3' || ext === 'mp3')) {
            args = [
              '-f', 'bestaudio/best',
              '--format-sort', 'abr,tbr',
              '--extract-audio',
              '--audio-format', 'mp3',
              '--audio-quality', '0',
              '--no-playlist',
              '--embed-metadata',
              '--js-runtimes', 'node',
              '--ffmpeg-location', MediaSniffer.ffmpegPath,
              '-o', outputPath,
              targetUrl
            ];
          } else if (type === 'audio_only') {
            args = [
              '-f', formatId && formatId !== 'audio_only_unknown' ? `${formatId}/bestaudio/best` : 'bestaudio/best',
              '--format-sort', 'abr,tbr',
              '--no-playlist',
              '--embed-metadata',
              '--js-runtimes', 'node',
              '--ffmpeg-location', MediaSniffer.ffmpegPath,
              '-o', outputPath,
              targetUrl
            ];
          } else if (type === 'video_only') {
            args = [
              '-f', formatId && formatId !== 'video_only_unknown' ? `${formatId}/bestvideo` : 'bestvideo',
              '--format-sort', 'res,fps,vbr,tbr',
              '--no-playlist',
              '--embed-metadata',
              '--js-runtimes', 'node',
              '--ffmpeg-location', MediaSniffer.ffmpegPath,
              '-o', outputPath,
              targetUrl
            ];
          } else {
            // type === 'video_full' o genérico
            let formatSelector = 'bestvideo+bestaudio/best';
            if (formatId && formatId !== 'video_full_unknown' && formatId !== 'video_full_fallback') {
              formatSelector = `${formatId}+bestaudio/bestvideo+bestaudio/best`;
            } else if (quality && quality !== 'max' && quality !== 'best') {
              const heightMatch = quality.match(/(\d+)/);
              if (heightMatch) {
                const h = heightMatch[1];
                formatSelector = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/bestvideo+bestaudio/best`;
              }
            }

            args = [
              '-f', formatSelector,
              '--format-sort', 'res,fps,vbr,tbr',
              '--merge-output-format', 'mp4',
              '--no-playlist',
              '--embed-metadata',
              '--js-runtimes', 'node',
              '--ffmpeg-location', MediaSniffer.ffmpegPath,
              '-o', outputPath,
              targetUrl
            ];
          }

          if (cookiePath) {
            args.splice(args.length - 1, 0, '--cookies', cookiePath);
          }

          console.log(`[MediaSniffer] Spawn yt-dlp: ${ytdlpPath} ${args.join(' ')}`);
          const ytDlpProcess = child_process.spawn(ytdlpPath, args, {
            env: { ...process.env }
          });

          const progressRegex = /\[download\]\s+([\d\.]+)\%/;
          const speedRegex = /at\s+([\d\.]+)\s*([kKmMgG]?[iI]?[bB]\/s)/;
          let isAudioPhase = false;

          ytDlpProcess.stdout.on('data', (data) => {
            const output = data.toString();

            if (output.includes('100% of') && !isAudioPhase) {
              isAudioPhase = true;
            }

            if (output.includes('[Merger]') || output.includes('Merging formats') || output.includes('[ExtractAudio]')) {
              broadcastProgress(0.98, 0, 'Ensamblando (FFmpeg)...');
              return;
            }

            const match = output.match(progressRegex);
            if (match && match[1]) {
              const rawPercent = parseFloat(match[1]) / 100;
              let displayPercent = rawPercent;
              if (type === 'video_full' || !type) {
                displayPercent = isAudioPhase ? 0.75 + (rawPercent * 0.22) : (rawPercent * 0.75);
              }
              displayPercent = Math.min(displayPercent, 0.97);

              let speedBytes = 0;
              const sMatch = output.match(speedRegex);
              if (sMatch && sMatch[1]) {
                const num = parseFloat(sMatch[1]);
                const unit = (sMatch[2] || '').toLowerCase();
                if (unit.includes('k')) speedBytes = num * 1024;
                else if (unit.includes('m')) speedBytes = num * 1024 * 1024;
                else if (unit.includes('g')) speedBytes = num * 1024 * 1024 * 1024;
                else speedBytes = num;
              }

              broadcastProgress(displayPercent, speedBytes, isAudioPhase ? 'Descargando audio...' : 'Descargando video...');
            }
          });

          ytDlpProcess.stderr.on('data', (data) => {
            console.log(`[yt-dlp Debug]: ${data.toString().trim()}`);
          });

          const cleanup = () => {
            if (cookiePath && fs.existsSync(cookiePath)) {
              try { fs.unlinkSync(cookiePath); } catch (e) {}
            }
          };

          ytDlpProcess.on('close', (code: number) => {
            cleanup();
            if (code === 0) {
              console.log('[MediaSniffer] Descarga con yt-dlp completada exitosamente.');

              if (!fs.existsSync(outputPath)) {
                try {
                  const dir = path.dirname(outputPath);
                  const baseNoExt = path.basename(outputPath, path.extname(outputPath));
                  const files = fs.readdirSync(dir);
                  const matching = files.find(f => f.startsWith(baseNoExt));
                  if (matching) {
                    const candidate = path.join(dir, matching);
                    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
                      try {
                        fs.renameSync(candidate, outputPath);
                      } catch {
                        outputPath = candidate;
                      }
                    }
                  }
                } catch (e) {}
              }

              let finalSize = 0;
              if (fs.existsSync(outputPath)) {
                finalSize = fs.statSync(outputPath).size;
              }

              broadcastProgress(1, 0, 'Completado');
              StorageService.updateDownload({
                id: downloadId,
                filename,
                url: targetUrl,
                savePath: outputPath,
                state: 'completed',
                receivedBytes: finalSize,
                totalBytes: finalSize
              });
              resolve({ success: true, path: outputPath });
            } else {
              console.error('[MediaSniffer] Error en yt-dlp, exit code:', code);
              StorageService.updateDownload({
                id: downloadId,
                filename,
                url: targetUrl,
                savePath: outputPath,
                state: 'cancelled',
                receivedBytes: 0,
                totalBytes: 0
              });
              reject(new Error(`Fallo en la descarga de YouTube (yt-dlp Code: ${code})`));
            }
          });

          ytDlpProcess.on('error', (err: any) => {
            cleanup();
            console.error('[MediaSniffer] Fallo al iniciar yt-dlp:', err);
            StorageService.updateDownload({
              id: downloadId,
              filename,
              url: targetUrl,
              savePath: outputPath,
              state: 'cancelled',
              receivedBytes: 0,
              totalBytes: 0
            });
            reject(err);
          });
        });
      }

      // ── MODO GENÉRICO (Videos MP4 directos, HLS no-YouTube vía ConcurrentDownloader) ──
      console.log(`[MediaSniffer] Iniciando descarga multi-hilo del video genérico...`);
      videoTempFile = await ConcurrentDownloader.download(url, 'video', (p, s) => {
        const scaledP = audioUrl ? (p * 0.5) : p;
        broadcastProgress(scaledP, s, 'Descargando...');
      });
      
      if (audioUrl) {
        console.log(`[MediaSniffer] Iniciando descarga multi-hilo del audio genérico...`);
        audioTempFile = await ConcurrentDownloader.download(audioUrl, 'audio', (p, s) => {
           broadcastProgress(0.5 + (p * 0.5), s, 'Descargando...');
        });
      }

      // Si no hay audio separado y no es conversión a mp3, guardar directamente sin recodificar
      if (!audioTempFile && finalExt !== 'mp3') {
        fs.copyFileSync(videoTempFile!, outputPath);
        if (fs.existsSync(videoTempFile!)) fs.unlinkSync(videoTempFile!);
        broadcastProgress(1, 0, 'Completado');
        const finalSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
        StorageService.updateDownload({
          id: downloadId,
          filename,
          url: originalUrl || url,
          savePath: outputPath,
          state: 'completed',
          receivedBytes: finalSize,
          totalBytes: finalSize
        });
        return { success: true, path: outputPath };
      }

      console.log(`[MediaSniffer] Iniciando muxing con FFmpeg a: ${outputPath}`);
      broadcastProgress(0.95, 0, 'Ensamblando (FFmpeg)...');

      let args = ['-i', videoTempFile!];
      
      if (audioTempFile) {
        args.push('-i', audioTempFile);
      }
      
      if (finalExt === 'mp3') {
        args.push(
          '-c:a', 'libmp3lame',
          '-q:a', '0',
          '-y',
          outputPath
        );
      } else {
        args.push(
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-y',
          outputPath
        );
      }

      return await new Promise((resolve, reject) => {
        const ffmpeg = child_process.spawn(MediaSniffer.ffmpegPath, args);

        ffmpeg.stderr.on('data', (data) => {
            console.log(`[FFmpeg Debug]: ${data.toString().trim()}`);
        });

        ffmpeg.on('close', (code) => {
          if (videoTempFile && fs.existsSync(videoTempFile)) fs.unlinkSync(videoTempFile);
          if (audioTempFile && fs.existsSync(audioTempFile)) fs.unlinkSync(audioTempFile);

          if (code === 0) {
            console.log('[MediaSniffer] Muxing completado exitosamente.');
            broadcastProgress(1, 0, 'Completado');
            
            let finalSize = 0;
            if (fs.existsSync(outputPath)) {
              finalSize = fs.statSync(outputPath).size;
            }
            StorageService.updateDownload({
              id: downloadId,
              filename,
              url: originalUrl || url,
              savePath: outputPath,
              state: 'completed',
              receivedBytes: finalSize,
              totalBytes: finalSize
            });
            
            resolve({ success: true, path: outputPath });
          } else {
            console.error(`[MediaSniffer] Error fatal en FFmpeg, exit code: ${code}`);
            StorageService.updateDownload({
              id: downloadId,
              filename,
              url: originalUrl || url,
              savePath: outputPath,
              state: 'cancelled',
              receivedBytes: 0,
              totalBytes: 0
            });
            reject(new Error(`Fallo en el muxing de FFmpeg (Code: ${code})`));
          }
        });

        ffmpeg.on('error', (err) => {
          if (videoTempFile && fs.existsSync(videoTempFile)) fs.unlinkSync(videoTempFile);
          if (audioTempFile && fs.existsSync(audioTempFile)) fs.unlinkSync(audioTempFile);
          console.error('[MediaSniffer] Fallo al lanzar FFmpeg:', err);
          StorageService.updateDownload({
            id: downloadId,
            filename,
            url: originalUrl || url,
            savePath: outputPath,
            state: 'cancelled',
            receivedBytes: 0,
            totalBytes: 0
          });
          reject(err);
        });
      });
    } catch (err: any) {
      if (videoTempFile && fs.existsSync(videoTempFile)) fs.unlinkSync(videoTempFile);
      if (audioTempFile && fs.existsSync(audioTempFile)) fs.unlinkSync(audioTempFile);
      console.error('[MediaSniffer] Error en descarga:', err);
      StorageService.updateDownload({
        id: downloadId,
        filename,
        url: originalUrl || url,
        savePath: outputPath,
        state: 'cancelled',
        receivedBytes: 0,
        totalBytes: 0
      });
      throw err;
    }
  }

  private static findTabIdByWebContentsId(id: number | undefined): string | null {
    if (!id) return null;
    const { viewManager } = require('./main');
    if (viewManager) {
      return viewManager.findTabIdByWebContentsId(id);
    }
    return null;
  }

  private static extractYouTubeId(url: string): string | null {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  /**
   * Escanea activamente la página actual para encontrar reproductores de video ocultos o
   * encriptados que escapan al sniffer de red (como YouTube via Service Workers).
   */
  public static async scanPage(tabId: string, mainWindow: BrowserWindow) {
    const { viewManager } = require('./main');
    if (!viewManager) return;
    const view = viewManager.views.get(tabId);
    if (!view) return;

    try {
      const url = view.webContents.getURL();
      
      const cached = MediaSniffer.detectedMedia.get(tabId);
      if (cached) {
        const cachedYtId = MediaSniffer.extractYouTubeId(cached.originalUrl);
        const currentYtId = MediaSniffer.extractYouTubeId(url);

        if (cached.originalUrl === url || (cachedYtId && currentYtId && cachedYtId === currentYtId)) {
          // Ya tenemos este video cacheado, enviamos directo sin re-escanear
          MediaSniffer.notifyMediaDetected(tabId, mainWindow, cached);
          return;
        } else {
          // Caché obsoleta por navegación a un video diferente
          MediaSniffer.clearMediaForTab(tabId);
        }
      }

      if (MediaSniffer.scanningTabs.has(tabId)) {
        return;
      }
      
      if (url.includes('youtube.com/watch') || url.includes('youtu.be/')) {
        MediaSniffer.scanningTabs.add(tabId);
        mainWindow.webContents.send('sniffing-start', tabId);
        try {
          let downloads = null;

          // Intento 1: Extracción Nativa ultrarrápida en RAM (0ms, sin child processes)
          try {
            const ytResponseStr = await view.webContents.executeJavaScript('JSON.stringify(window.ytInitialPlayerResponse || {})').catch(() => '{}');
            const ytResponse = JSON.parse(ytResponseStr);
            
            const streamingData = ytResponse.streamingData;
            if (streamingData && (streamingData.formats || streamingData.adaptiveFormats)) {
              const allFormats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
              
              let decipherFn: Function | null = null;
              const hasCipher = allFormats.some((f: any) => f.signatureCipher);
              if (hasCipher) {
                const playerUrl = await view.webContents.executeJavaScript('document.querySelector("script[src*=\\"/base.js\\"]")?.src').catch(() => null);
                if (playerUrl) {
                  decipherFn = await YouTubeExtractor.getDecipherFunction(playerUrl);
                }
              }

              const parsedFormats = allFormats.map((f: any) => {
                if (f.url) return f;
                if (f.signatureCipher && decipherFn) {
                  const params = new URLSearchParams(f.signatureCipher);
                  const s = params.get('s');
                  const sp = params.get('sp') || 'sig';
                  const fUrl = params.get('url');
                  if (s && fUrl) {
                    try {
                      const decodedS = decodeURIComponent(s);
                      const sig = decipherFn(decodedS);
                      f.url = `${fUrl}&${sp}=${encodeURIComponent(sig)}`;
                      return f;
                    } catch (e) { }
                  }
                }
                return null;
              }).filter((f: any) => f && f.url);

              if (parsedFormats.length > 0) {
                downloads = MediaSniffer.formatYouTubeDownloads(parsedFormats);
              }
            }
          } catch (e) { }

          let info: any = null;

          // Intento 2: Fallback a yt-dlp solo si la extracción en RAM no obtuvo formatos completos
          if (!downloads) {
            console.log(`[MediaSniffer] YouTube detectado, extrayendo manifiesto vía yt-dlp (Fallback)...`);
          
          let cookiePath: string | null = null;
          let execResult: any;

          try {
            // Extracción y Exportación de Cookies (El Puente anti-bot)
            const shieldSession = session.fromPartition('persist:beta-session');
            const cookies = await shieldSession.cookies.get({ url: 'https://www.youtube.com' });
            if (cookies.length > 0) {
              cookiePath = path.join(os.tmpdir(), `yt_cookies_${Date.now()}.txt`);
              // Formato Netscape HTTP Cookie File
              let netscapeText = '# Netscape HTTP Cookie File\n';
              for (const c of cookies) {
                const domain = c.domain || '.youtube.com';
                const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
                const secure = c.secure ? 'TRUE' : 'FALSE';
                const expiration = c.expirationDate ? Math.round(c.expirationDate) : 0;
                netscapeText += `${domain}\t${includeSubdomains}\t${c.path}\t${secure}\t${expiration}\t${c.name}\t${c.value}\n`;
              }
              fs.writeFileSync(cookiePath, netscapeText);
            }

            const options: any = {
              dumpJson: true,
              noWarnings: true,
              quiet: true, // Forzar quiet para evitar polución de logs
              preferFreeFormats: true,
              noPlaylist: true, // Evitar descargas múltiples de playlists
              jsRuntimes: 'node',
            };

            if (cookiePath) {
              options.cookies = cookiePath;
            }

            execResult = await ytDlpExec(url, options);
          } finally {
            if (cookiePath && fs.existsSync(cookiePath)) {
              try { fs.unlinkSync(cookiePath); } catch (e) {}
            }
          }
          
          const output = execResult.stdout;
          
          // Buscar de forma robusta la línea que contenga el JSON válido
          const lines = output.split('\n');
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed && parsed.formats) {
                info = parsed;
                break;
              }
            } catch (err) {}
          }
          
          if (!info) {
             throw new Error('No se pudo encontrar un JSON válido en la salida de yt-dlp.');
          }
          
            if (info && info.formats) {
              downloads = MediaSniffer.formatYouTubeDownloads(info.formats);
            }
          }

          if (downloads && (downloads.video_full.length > 0 || downloads.audio_only.length > 0)) {
            console.log(`[MediaSniffer] YouTube descifrado (Tab ${tabId}) estructurado correctamente.`);
            MediaSniffer.notifyMediaDetected(tabId, mainWindow, {
              isDrmLocked: false,
              originalUrl: url,
              title: info ? info.title : undefined,
              thumbnail: info ? info.thumbnail : undefined,
              downloads
            });
            return;
          }
        } catch (e) {
          console.error(`[MediaSniffer] Error resolviendo YouTube vía yt-dlp:`, e);
        } finally {
          MediaSniffer.scanningTabs.delete(tabId);
          mainWindow.webContents.send('sniffing-end', tabId);
        }
      }

      // Heurística General (Busca etiquetas <video> con src o fuentes)
      const scriptGen = `
        (function() {
          const videos = Array.from(document.querySelectorAll('video'));
          for (let v of videos) {
            if (v.src && !v.src.startsWith('blob:')) return { formats: [{ resolution: 'Directo (DOM)', url: v.src }], title: document.title };
            const sources = Array.from(v.querySelectorAll('source'));
            for (let s of sources) {
              if (s.src && !s.src.startsWith('blob:')) return { formats: [{ resolution: 'Directo (DOM)', url: s.src }], title: document.title };
            }
          }
          return null;
        })();
      `;
      const genResult = await view.webContents.executeJavaScript(scriptGen);
      if (genResult && genResult.formats && genResult.formats.length > 0) {
        let title = genResult.title;
        if (title && title.includes('- YouTube')) {
          title = title.replace('- YouTube', '').trim();
        }
        
        console.log(`[MediaSniffer] Video genérico detectado activamente (Tab ${tabId}).`);
        MediaSniffer.notifyMediaDetected(tabId, mainWindow, {
          isDrmLocked: false,
          originalUrl: url,
          title: title,
          thumbnail: undefined,
          downloads: {
            video_full: genResult.formats,
            audio_only: [],
            video_only: []
          }
        });
      }

    } catch(e) {
      // Ignorar errores si la inyección falla (p.ej. página cerrada)
    }
  }

  public static formatYouTubeDownloads(formats: any[]): any {
    const downloads = {
      video_full: [] as DownloadOption[],
      audio_only: [] as DownloadOption[],
      video_only: [] as DownloadOption[]
    };
    
    // Filtrar pistas de solo audio estrictamente
    const audioFormats = formats.filter((f: any) => 
      f.vcodec === 'none'
    );
    audioFormats.sort((a: any, b: any) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    const bestAudio = audioFormats.length > 0 ? audioFormats[0].url : undefined;
    const bestAudioSize = audioFormats.length > 0 ? (audioFormats[0].filesize || audioFormats[0].filesize_approx || 0) : 0;

    audioFormats.forEach((f: any) => {
       // yt-dlp reporta 'abr' y 'tbr' directamente en kbps
       const kbps = Math.round(f.abr || f.tbr || 128);
       
       let ext = f.ext || 'm4a';
       if (f.acodec && f.acodec.includes('opus')) ext = 'webm';
       else if (f.mimeType && f.mimeType.includes('webm')) ext = 'webm';
       
       const sizeBytes = f.filesize || f.filesize_approx || 0;
       const sizeMB = sizeBytes > 0 ? (sizeBytes / 1024 / 1024).toFixed(1) + ' MB' : 'Desconocido';
       
       let qualityLabel = 'Baja Calidad';
       if (kbps > 100) qualityLabel = 'Mejor Calidad';
       else if (kbps > 60) qualityLabel = 'Media Calidad';

       // Formato Nativo
       downloads.audio_only.push({
         formatId: f.format_id || 'audio_only_unknown',
         label: `Audio (${ext}) | ${qualityLabel}`,
         type: 'audio_only',
         ext: ext,
         size: sizeMB,
         url: f.url
       });
       
       // Inyección de MP3 virtual si es buena calidad o si es el único disponible
       if (kbps > 60) {
         downloads.audio_only.push({
           formatId: f.format_id || 'audio_only_unknown',
           label: `Audio (mp3) | ${qualityLabel}`,
           type: 'audio_converted',
           ext: 'mp3',
           size: sizeMB,
           url: f.url
         });
       }
    });
    
    // Deduplicar audio (conservando el primero que es el de mayor bitrate debido al sort)
    const uniqueAudio = new Map();
    downloads.audio_only.forEach(item => {
      if (!uniqueAudio.has(item.label)) uniqueAudio.set(item.label, item);
    });
    downloads.audio_only = Array.from(uniqueAudio.values());
    
    // Filtrar pistas de video
    const videoFormats = formats.filter((f: any) => 
      (f.vcodec && f.vcodec !== 'none') || (f.mimeType && f.mimeType.includes('video/'))
    );
    
    // Ordenar para MÁXIMA NITIDEZ Y CALIDAD:
    // 1. Mayor Resolución (ej: 4320p 8K > 2160p 4K > 1440p 2K > 1080p > 720p > 480p)
    // 2. Mayor FPS (60fps > 50fps > 30fps)
    // 3. MAYOR BITRATE (TBR / VBR) - Prioridad absoluta a la tasa de bits para máxima fidelidad
    // 4. Códec de mayor fidelidad de textura (VP9 / AV1 > H.264)
    videoFormats.sort((a: any, b: any) => {
      const hA = a.height || 0;
      const hB = b.height || 0;
      if (hB !== hA) return hB - hA;

      const fpsA = a.fps || 0;
      const fpsB = b.fps || 0;
      if (fpsB !== fpsA) return fpsB - fpsA;

      const brA = a.tbr || a.vbr || 0;
      const brB = b.tbr || b.vbr || 0;
      if (brB !== brA) return brB - brA;

      const codecScore = (c: string) => {
        if (!c) return 0;
        if (c.includes('vp09') || c.includes('vp9')) return 3;
        if (c.includes('av01') || c.includes('av1')) return 2;
        if (c.includes('avc') || c.includes('h264')) return 1;
        return 0;
      };
      return codecScore(b.vcodec) - codecScore(a.vcodec);
    });

    const uniqueVideoFull = new Map();
    const uniqueVideoOnly = new Map();

    videoFormats.forEach((f: any) => {
      const hasAudio = (f.acodec && f.acodec !== 'none');
      const finalAudioUrl = hasAudio ? undefined : bestAudio;
      
      let fpsStr = (f.fps && f.fps > 30) ? Math.round(f.fps).toString() : '';
      let heightStr = f.height ? `${f.height}p` : '';
      let resBase = heightStr ? `${heightStr}${fpsStr}` : (f.format_note || 'Video');
      
      let res = resBase || 'Mejor Calidad';

      let sizeBytes = f.filesize || f.filesize_approx || 0;
      if (!hasAudio && bestAudioSize > 0 && sizeBytes > 0) {
        sizeBytes += bestAudioSize;
      }
      const sizeMB = sizeBytes > 0 
        ? (sizeBytes >= 1024 * 1024 * 1024 
            ? (sizeBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB' 
            : (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB')
        : '';

      let label = res;
      if (f.height === 1080 && (f.tbr > 7000 || f.vbr > 7000 || f.format_id === '617')) {
        label = `${res} (Máxima Nitidez / Premium)`;
      } else if (f.height >= 2160) {
        label = `${res} (Ultra HD 4K)`;
      } else if (f.height >= 1440) {
        label = `${res} (Quad HD 2K)`;
      }

      if (!uniqueVideoFull.has(resBase)) {
        uniqueVideoFull.set(resBase, {
          formatId: f.format_id || 'video_full_unknown',
          label: label,
          type: 'video_full',
          size: sizeMB,
          url: f.url,
          audioUrl: finalAudioUrl
        });
      }

      if (!uniqueVideoOnly.has(resBase)) {
        uniqueVideoOnly.set(resBase, {
          formatId: f.format_id || 'video_only_unknown',
          label: label,
          type: 'video_only',
          size: sizeMB,
          url: f.url
        });
      }
    });

    downloads.video_full = Array.from(uniqueVideoFull.values());
    downloads.video_only = Array.from(uniqueVideoOnly.values());
    
    // Fallback absoluto por si el agrupado fallara y videoFormats tuviera items:
    if (downloads.video_full.length === 0 && videoFormats.length > 0) {
      const best = videoFormats[0];
      downloads.video_full.push({
        formatId: best.format_id || 'video_full_fallback',
        label: best.height ? `${best.height}p (Fallback)` : 'Directo (Fallback)',
        type: 'video_full',
        url: best.url,
        audioUrl: bestAudio
      });
    }
    
    return downloads;
  }
}
