import { net, session, ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export class ConcurrentDownloader {
  private static MAX_CONCURRENCY = 4;
  private static MAX_RETRIES = 3;
  private static CHUNK_SIZE = 5 * 1024 * 1024; // 5MB limit por chunk

  private static getHeaders() {
    return {
      'User-Agent': session.defaultSession.getUserAgent(),
      'Referer': 'https://www.youtube.com/'
    };
  }

  /**
   * Descarga un archivo de forma multi-hilo o single-hilo dependiendo de Accept-Ranges.
   */
  public static async download(url: string, prefix: string, onProgress: (percent: number, speed: number) => void): Promise<string> {
    const tempFile = path.join(os.tmpdir(), `${prefix}_${crypto.randomBytes(6).toString('hex')}.tmp`);
    
    const headers = this.getHeaders();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const headRes = await net.fetch(url, { 
        method: 'HEAD',
        headers,
        signal: controller.signal as any 
      });
      clearTimeout(timeoutId);

      const totalLengthStr = headRes.headers.get('content-length');
      const totalLength = parseInt(totalLengthStr || '0', 10);
      const acceptsRanges = headRes.headers.get('accept-ranges') === 'bytes';

      if (!acceptsRanges || totalLength === 0) {
        console.log(`[DownloadManager] Descarga en 1 hilo (No soporta ranges o tamaño desconocido) para ${prefix}`);
        await this.downloadSingle(url, tempFile, totalLength, onProgress);
        return tempFile;
      }

      console.log(`[DownloadManager] Descarga Multi-hilo en cola (chunks de 5MB) para ${prefix}. Tamaño: ${(totalLength / 1024 / 1024).toFixed(2)} MB`);
      await this.downloadConcurrent(url, tempFile, totalLength, onProgress);
      return tempFile;
    } catch (err) {
      console.error(`[DownloadManager] Error iniciando descarga:`, err);
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      throw err;
    }
  }

  private static async downloadSingle(url: string, dest: string, totalLength: number, onProgress: (percent: number, speed: number) => void): Promise<void> {
    const headers = this.getHeaders();
    const res = await net.fetch(url, { headers });
    
    if (!res.ok) throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('Response body is null');

    const writer = fs.createWriteStream(dest);
    let downloaded = 0;
    
    const reader = res.body.getReader();
    let lastEmitTime = Date.now();
    let lastEmitBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        await new Promise<void>((resolve, reject) => {
          writer.write(value, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        downloaded += value.length;
        if (totalLength > 0) {
          const now = Date.now();
          if (now - lastEmitTime > 200) {
            const speed = (downloaded - lastEmitBytes) / ((now - lastEmitTime) / 1000);
            onProgress(downloaded / totalLength, speed);
            lastEmitTime = now;
            lastEmitBytes = downloaded;
          }
        }
      }
    } catch (err) {
      writer.close();
      throw err;
    } finally {
      writer.close();
    }
  }

  private static async downloadConcurrent(url: string, dest: string, totalLength: number, onProgress: (percent: number, speed: number) => void): Promise<void> {
    const fd = fs.openSync(dest, 'w');
    fs.ftruncateSync(fd, totalLength);

    // 1. Fragmentación Segura (Chunking) en bloques de 5MB
    const queue: { start: number, end: number }[] = [];
    for (let start = 0; start < totalLength; start += this.CHUNK_SIZE) {
      const end = Math.min(start + this.CHUNK_SIZE - 1, totalLength - 1);
      queue.push({ start, end });
    }

    let downloadedBytes = 0;
    const controller = new AbortController();
    let isAborted = false;
    
    let lastEmitTime = Date.now();
    let lastEmitBytes = 0;

    // 2. Definir la función que procesa un bloque específico (con retry)
    const downloadChunk = async (start: number, end: number, attempt = 1): Promise<void> => {
      if (isAborted) return;
      
      const headers = { 
        ...this.getHeaders(),
        'Range': `bytes=${start}-${end}`
      };
      
      let chunkDownloadedBytes = 0;

      try {
        const res = await net.fetch(url, { 
          headers,
          signal: controller.signal as any 
        });

        if (!res.ok) throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('Response body is null');

        const reader = res.body.getReader();
        let currentPos = start;

        while (true) {
          if (isAborted) {
            await reader.cancel();
            break;
          }

          const { done, value } = await reader.read();
          if (done) {
            if (currentPos <= end) {
              throw new Error('Stream ended before chunk was fully downloaded');
            }
            break;
          }

          fs.writeSync(fd, value, 0, value.length, currentPos);
          currentPos += value.length;
          downloadedBytes += value.length;
          chunkDownloadedBytes += value.length;
          
          const now = Date.now();
          if (now - lastEmitTime > 200) {
            const speed = (downloadedBytes - lastEmitBytes) / ((now - lastEmitTime) / 1000);
            onProgress(downloadedBytes / totalLength, speed);
            lastEmitTime = now;
            lastEmitBytes = downloadedBytes;
          }
        }
      } catch (err: any) {
        if (isAborted) return;
        
        if (err.name === 'AbortError') {
          return;
        }

        if (attempt <= this.MAX_RETRIES) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.warn(`[DownloadManager] Reintentando chunk ${start}-${end} (Intento ${attempt}/${this.MAX_RETRIES}) en ${delay}ms...`);
          
          downloadedBytes -= chunkDownloadedBytes;
          
          await new Promise(r => setTimeout(r, delay));
          return downloadChunk(start, end, attempt + 1);
        } else {
          console.error(`[DownloadManager] Chunk ${start}-${end} falló permanentemente tras ${this.MAX_RETRIES} intentos.`);
          // 3. Aborto global y emisión de evento
          isAborted = true;
          controller.abort();
          throw new Error('DownloadFailedNetwork');
        }
      }
    };

    // 4. Pool de Trabajadores Concurrentes (Worker Pool)
    const worker = async () => {
      while (queue.length > 0 && !isAborted) {
        const chunk = queue.shift();
        if (chunk) {
          await downloadChunk(chunk.start, chunk.end);
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < this.MAX_CONCURRENCY; i++) {
      workers.push(worker());
    }

    try {
      await Promise.all(workers);
      if (isAborted) {
         throw new Error('DownloadFailedNetwork');
      }
    } catch (err) {
      isAborted = true;
      controller.abort();
      
      // Notificar al frontend usando los WebContents abiertos
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('download-failed', { message: 'Fallo de red persistente con el CDN.' });
        }
      });
      
      throw err;
    } finally {
      fs.closeSync(fd);
    }
  }
}
