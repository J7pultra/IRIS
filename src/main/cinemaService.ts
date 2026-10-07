import { ipcMain, BrowserWindow } from 'electron';
import { viewManager } from './main';
import { CinemaServer } from './cinemaServer';
import { MediaExtractor } from './mediaExtractor';

export interface CinemaParticipant {
  id: string;
  name: string;
  isHost: boolean;
}

export interface CinemaChatMessage {
  id: string;
  sender: string;
  isMe: boolean;
  text: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'sticker' | 'gif';
  time: string;
}

export interface CinemaStatus {
  inRoom: boolean;
  roomId: string | null;
  isHost: boolean;
  partnerConnected: boolean;
  lightsDimmed: boolean;
  expiresAt: number | null;
  isLocked: boolean;
  mode: 'player' | 'browser';
  username?: string;
  partnerName?: string;
  maxParticipants: number;
  participantsCount: number;
  controlMode: 'host_only' | 'everyone';
  participants: CinemaParticipant[];
}

export class CinemaService {
  public static status: CinemaStatus = {
    inRoom: false,
    roomId: null,
    isHost: false,
    partnerConnected: false,
    lightsDimmed: false,
    expiresAt: null,
    isLocked: false,
    mode: 'player',
    username: undefined,
    partnerName: undefined,
    maxParticipants: 6,
    participantsCount: 0,
    controlMode: 'host_only',
    participants: []
  };

  public static lastRemoteSyncUrl: string = '';
  private static mainWindow: BrowserWindow | null = null;
  private static expirationTimeout: NodeJS.Timeout | null = null;

  public static initialize(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.registerIpc();
    CinemaServer.start().catch((err: any) => {
      console.warn('[CinemaService] Error iniciando CinemaServer:', err);
    });
  }

  public static getStatus(): CinemaStatus {
    return { ...this.status };
  }

  /**
   * Genera un código criptográficamente seguro de alta entropía (32^6 = 1.07 mil millones de combinaciones)
   * Excluye caracteres ambiguos (0, O, 1, I, L) para lectura rápida sin errores.
   */
  public static generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CINE-${code}`;
  }

  public static createRoom(
    mode: 'player' | 'browser' = 'player',
    username?: string,
    maxParticipants: number = 6,
    controlMode: 'host_only' | 'everyone' = 'host_only'
  ): CinemaStatus {
    this.cleanupExpiration();
    this.lastRemoteSyncUrl = '';
    const roomId = this.generateRoomCode();
    const expiresAt = Date.now() + 30 * 60 * 1000; // Expira en 30 minutos si nadie se une
    const safeMax = Math.max(2, Math.min(8, Number(maxParticipants) || 6));
    const safeMode = mode || 'player';
    const safeControl = controlMode === 'everyone' ? 'everyone' : 'host_only';
    const hostName = username || 'Anfitrión';

    this.expirationTimeout = setTimeout(() => {
      if (this.status.inRoom && !this.status.partnerConnected) {
        console.log('[CinemaService] Sala expirada por inactividad.');
        this.leaveRoom();
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-room-expired');
        }
      }
    }, 30 * 60 * 1000);

    const initialParticipants: CinemaParticipant[] = [
      { id: 'host', name: hostName, isHost: true }
    ];

    this.status = {
      inRoom: true,
      roomId,
      isHost: true,
      partnerConnected: false,
      lightsDimmed: this.status.lightsDimmed,
      expiresAt,
      isLocked: false,
      mode: safeMode,
      username: hostName,
      partnerName: undefined,
      maxParticipants: safeMax,
      participantsCount: 1,
      controlMode: safeControl,
      participants: initialParticipants
    };
    this.broadcastStatus();
    return this.getStatus();
  }

  public static joinRoom(code: string, username?: string): CinemaStatus {
    this.cleanupExpiration();
    const cleanCode = code.trim().toUpperCase();
    const guestName = username || 'Invitado';

    this.status = {
      inRoom: true,
      roomId: cleanCode,
      isHost: false,
      partnerConnected: false,
      lightsDimmed: this.status.lightsDimmed,
      expiresAt: null,
      isLocked: false,
      mode: 'player', // Se actualizará al recibir el handshake del host
      username: guestName,
      partnerName: undefined,
      maxParticipants: 6,
      participantsCount: 1,
      controlMode: 'host_only',
      participants: [{ id: 'me', name: guestName, isHost: false }]
    };
    this.broadcastStatus();
    return this.getStatus();
  }

  public static leaveRoom(): CinemaStatus {
    this.cleanupExpiration();
    this.lastRemoteSyncUrl = '';
    this.status = {
      inRoom: false,
      roomId: null,
      isHost: false,
      partnerConnected: false,
      lightsDimmed: false,
      expiresAt: null,
      isLocked: false,
      mode: 'player',
      username: undefined,
      partnerName: undefined,
      maxParticipants: 6,
      participantsCount: 0,
      controlMode: 'host_only',
      participants: []
    };
    this.applyLightsToActiveTab(false);
    this.broadcastStatus();
    return this.getStatus();
  }

  public static updateControlMode(mode: 'host_only' | 'everyone'): CinemaStatus {
    if (this.status.inRoom && this.status.isHost) {
      this.status.controlMode = mode === 'everyone' ? 'everyone' : 'host_only';
      this.syncVideoAction({
        type: 'control_mode_update',
        controlMode: this.status.controlMode,
        timestamp: Date.now()
      });
      this.broadcastStatus();
    }
    return this.getStatus();
  }

  public static updateParticipants(participants: CinemaParticipant[]) {
    if (!this.status.inRoom) return;
    this.status.participants = Array.isArray(participants) ? participants : [];
    this.status.participantsCount = this.status.participants.length;
    this.status.partnerConnected = this.status.participantsCount > 1;

    // Calcular partnerName descriptivo si hay otros miembros
    if (this.status.isHost) {
      const guests = this.status.participants.filter(p => !p.isHost);
      if (guests.length === 1) {
        this.status.partnerName = guests[0].name;
      } else if (guests.length > 1) {
        this.status.partnerName = `${guests[0].name} y ${guests.length - 1} más`;
      } else {
        this.status.partnerName = undefined;
      }
    } else {
      const host = this.status.participants.find(p => p.isHost);
      this.status.partnerName = host ? host.name : 'Anfitrión';
    }

    if (this.status.partnerConnected) {
      this.cleanupExpiration();
    }
    this.broadcastStatus();
  }

  private static cleanupExpiration() {
    if (this.expirationTimeout) {
      clearTimeout(this.expirationTimeout);
      this.expirationTimeout = null;
    }
  }

  public static toggleLights(enabled?: boolean): boolean {
    if (enabled !== undefined) {
      this.status.lightsDimmed = enabled;
    } else {
      this.status.lightsDimmed = !this.status.lightsDimmed;
    }
    this.applyLightsToActiveTab(this.status.lightsDimmed);
    this.broadcastStatus();
    return this.status.lightsDimmed;
  }

  public static applyLightsToActiveTab(dimmed: boolean) {
    try {
      if (viewManager) {
        const activeTabId = viewManager.activeTabId;
        if (activeTabId) {
          const view = viewManager.views.get(activeTabId);
          if (view && view.webContents && !view.webContents.isDestroyed()) {
            view.webContents.send('cinema-set-lights', dimmed);
          }
        }
      }
    } catch (err) {
      console.error('[CinemaService] Error aplicando luces apagadas:', err);
    }
  }

  public static syncVideoAction(action: any) {
    if (!this.status.inRoom) return;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('cinema-p2p-send', action);
    }
  }

  public static applyReceivedSync(action: any) {
    try {
      // 1. Handshake inicial del Host al Invitado
      if (action.type === 'handshake') {
        if (!this.status.isHost) {
          this.status.mode = action.mode || 'player';
          if (action.hostName) this.status.partnerName = action.hostName;
          if (action.maxParticipants) this.status.maxParticipants = action.maxParticipants;
          if (action.controlMode) this.status.controlMode = action.controlMode;
          if (Array.isArray(action.participants)) {
            this.status.participants = action.participants;
            this.status.participantsCount = action.participants.length;
            this.status.partnerConnected = this.status.participantsCount > 1;
          }
          this.broadcastStatus();

          // Si el modo es co-navegación ('browser') y hay una URL activa
          if (this.status.mode === 'browser' && action.url && !action.url.startsWith('beta://')) {
            this.lastRemoteSyncUrl = action.url;
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('cinema-sync-navigate', {
                url: action.url,
                mode: 'browser'
              });
            }
          }
          if (typeof action.currentTime === 'number') {
            setTimeout(() => {
              this.applyReceivedSync({
                type: action.isPlaying ? 'play' : 'pause',
                currentTime: action.currentTime,
                timestamp: Date.now()
              });
            }, 1800);
          }
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('cinema-room-mode-updated', this.getStatus());
          }
        }
        return;
      }

      // 2. Información del invitado recibida por el Host
      if (action.type === 'guest_info') {
        if (this.status.isHost && action.guestName) {
          this.status.partnerName = action.guestName;
          this.broadcastStatus();
        }
        return;
      }

      // 3. Actualización de permisos de la sala (Rave style: Solo Anfitrión / Todos)
      if (action.type === 'control_mode_update') {
        this.status.controlMode = action.controlMode === 'everyone' ? 'everyone' : 'host_only';
        this.broadcastStatus();
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-control-mode-updated', this.status.controlMode);
        }
        return;
      }

      // 4. Actualización de lista de participantes
      if (action.type === 'participants_update' && Array.isArray(action.participants)) {
        this.updateParticipants(action.participants);
        return;
      }

      // 5. Control denegado por permisos
      if (action.type === 'control_denied') {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-control-denied', action.message || 'Solo el anfitrión tiene el control de reproducción.');
        }
        return;
      }

      // 6. Sala llena
      if (action.type === 'room_full') {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-room-full', action.maxParticipants || 6);
        }
        return;
      }

      // 7. Mensajes de chat P2P (texto o multimedia)
      if (action.type === 'chat') {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-chat-message', {
            id: action.id,
            sender: action.sender || this.status.partnerName || 'Amigo',
            isMe: false,
            text: action.text || '',
            mediaUrl: action.mediaUrl,
            mediaType: action.mediaType,
            time: new Date(action.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
        }
        return;
      }

      // 7.1. Reacciones flotantes estilo Rave
      if (action.type === 'reaction') {
        if (this.mainWindow && !this.mainWindow.isDestroyed() && action.emoji) {
          this.mainWindow.webContents.send('cinema-reaction', action.emoji);
        }
        return;
      }

      // 7.2. Historial de conversación sincronizado
      if (action.type === 'chat_history') {
        if (this.mainWindow && !this.mainWindow.isDestroyed() && Array.isArray(action.messages)) {
          const myName = this.status.username || (this.status.isHost ? 'Anfitrión' : 'Invitado');
          const formatted = action.messages.map((m: any) => ({
            id: m.id,
            sender: (m.sender === myName || (this.status.isHost && m.sender === 'Anfitrión')) ? 'Tú' : (m.sender || 'Amigo'),
            isMe: (m.sender === myName || (this.status.isHost && m.sender === 'Anfitrión')),
            text: m.text || '',
            mediaUrl: m.mediaUrl,
            mediaType: m.mediaType,
            time: new Date(m.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }));
          this.mainWindow.webContents.send('cinema-chat-history', formatted);
        }
        return;
      }

      // 8. Sincronización de estado de la Sala Multimedia (cola de videos, play, pause, seek)
      if (action.type === 'player_sync_state') {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-player-sync-received', action.payload);
        }
        return;
      }

      // 9. Cambio de URL en Co-Navegación
      if (action.type === 'url' && action.url) {
        this.lastRemoteSyncUrl = action.url;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('cinema-sync-navigate', {
            url: action.url,
            mode: 'browser'
          });
        }
        return;
      }

      // 10. Eventos sobre la etiqueta <video> en pestañas reales
      if (!viewManager) return;
      const activeTabId = viewManager.activeTabId;
      if (!activeTabId) return;

      const view = viewManager.views.get(activeTabId);
      if (!view || !view.webContents || view.webContents.isDestroyed()) return;

      view.webContents.send('cinema-apply-sync', action);

      const frameSyncScript = `
        (function() {
          try {
            var action = ${JSON.stringify(action)};
            var v = document.querySelector('video');
            if (!v) {
              var allV = document.querySelectorAll('video');
              if (allV.length > 0) v = allV[0];
            }
            if (!v) return;
            window.__isRemoteSync = true;
            setTimeout(function() { window.__isRemoteSync = false; }, 400);

            if (action.type === 'play') {
              if (typeof action.currentTime === 'number' && Math.abs(v.currentTime - action.currentTime) > 1.2) {
                v.currentTime = action.currentTime;
              }
              v.play().catch(function() {});
            } else if (action.type === 'pause') {
              if (typeof action.currentTime === 'number' && Math.abs(v.currentTime - action.currentTime) > 1.2) {
                v.currentTime = action.currentTime;
              }
              v.pause();
            } else if (action.type === 'seek') {
              if (typeof action.currentTime === 'number') {
                v.currentTime = action.currentTime;
              }
            } else if (action.type === 'rate') {
              if (typeof action.rate === 'number') {
                v.playbackRate = action.rate;
              }
            }
          } catch(e) {}
        })();
      `;

      try {
        const applyToFrameTree = (frame: any) => {
          if (!frame) return;
          try { frame.executeJavaScript(frameSyncScript).catch(() => {}); } catch {}
          if (frame.frames && Array.isArray(frame.frames)) {
            frame.frames.forEach(applyToFrameTree);
          }
        };
        if (view.webContents.mainFrame) {
          applyToFrameTree(view.webContents.mainFrame);
        }
      } catch {}
    } catch (err) {
      console.error('[CinemaService] Error aplicando sincronización recibida:', err);
    }
  }

  public static broadcastStatus() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('cinema-status-updated', this.getStatus());
    }
    try {
      const { uiManager } = require('./main');
      if (uiManager && typeof uiManager.updateMenuPopupData === 'function') {
        uiManager.updateMenuPopupData('cinema', this.getStatus());
      }
    } catch { }
  }

  private static registerIpc() {
    ipcMain.handle('cinema-get-status', () => {
      return this.getStatus();
    });

    ipcMain.handle('cinema-create-room', (event, mode?: 'player' | 'browser', username?: string, maxParticipants?: number, controlMode?: 'host_only' | 'everyone') => {
      return this.createRoom(mode, username, maxParticipants, controlMode);
    });

    ipcMain.handle('cinema-join-room', (event, code: string, username?: string) => {
      return this.joinRoom(code, username);
    });

    ipcMain.handle('cinema-leave-room', () => {
      return this.leaveRoom();
    });

    ipcMain.handle('cinema-update-control-mode', (event, controlMode: 'host_only' | 'everyone') => {
      return this.updateControlMode(controlMode);
    });

    ipcMain.handle('cinema-toggle-lights', (event, enabled?: boolean) => {
      return this.toggleLights(enabled);
    });

    ipcMain.on('cinema-partner-status', async (event, connected: boolean) => {
      this.status.partnerConnected = connected;
      if (connected) {
        this.status.isLocked = true;
        this.cleanupExpiration();

        if (this.status.isHost) {
          // El Host envía inmediatamente el handshake de estado inicial al invitado
          let activeUrl: string | undefined = undefined;
          let currentVideoState: { time?: number; isPlaying?: boolean } | null = null;
          if (this.status.mode === 'browser' && viewManager && viewManager.activeTabId) {
            const view = viewManager.views.get(viewManager.activeTabId);
            if (view && view.webContents && !view.webContents.isDestroyed()) {
              activeUrl = view.webContents.getURL();
              try {
                currentVideoState = await view.webContents.executeJavaScript(`
                  (function() {
                    var v = document.querySelector('video');
                    if (!v) return null;
                    return { time: v.currentTime, isPlaying: !v.paused };
                  })()
                `).catch(() => null);
              } catch {}
            }
          }

          this.syncVideoAction({
            type: 'handshake',
            mode: this.status.mode,
            hostName: this.status.username || 'Anfitrión',
            maxParticipants: this.status.maxParticipants,
            controlMode: this.status.controlMode,
            participants: this.status.participants,
            url: activeUrl,
            currentTime: currentVideoState?.time,
            isPlaying: currentVideoState?.isPlaying,
            timestamp: Date.now()
          });
        } else {
          // El invitado envía su nombre al anfitrión
          this.syncVideoAction({
            type: 'guest_info',
            guestName: this.status.username || 'Invitado',
            timestamp: Date.now()
          });
        }
      }
      this.broadcastStatus();
    });

    ipcMain.on('cinema-participants-updated', (event, list: CinemaParticipant[]) => {
      this.updateParticipants(list);
    });

    ipcMain.on('cinema-control-denied', (event, message: string) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('cinema-control-denied', message);
      }
    });

    ipcMain.on('cinema-room-full', (event, max: number) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('cinema-room-full', max);
      }
    });

    ipcMain.on('cinema-p2p-received', (event, action: any) => {
      this.applyReceivedSync(action);
    });

    // Enviar mensaje de chat de texto
    ipcMain.on('cinema-send-chat', (event, text: string) => {
      if (!this.status.inRoom || !text || !text.trim()) return;
      const cleanText = text.trim();
      const msgAction = {
        type: 'chat',
        id: `chat_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        sender: this.status.username || (this.status.isHost ? 'Anfitrión' : 'Invitado'),
        text: cleanText,
        timestamp: Date.now()
      };

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('cinema-chat-message', {
          id: msgAction.id,
          sender: 'Tú',
          isMe: true,
          text: cleanText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        this.mainWindow.webContents.send('cinema-p2p-send', msgAction);
      }
    });

    // Enviar mensaje de chat con sticker / imagen
    ipcMain.on('cinema-send-media', (event, { mediaUrl, mediaType }: { mediaUrl: string; mediaType: 'image' | 'sticker' | 'gif' }) => {
      if (!this.status.inRoom || !mediaUrl) return;
      const msgAction = {
        type: 'chat',
        id: `media_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        sender: this.status.username || (this.status.isHost ? 'Anfitrión' : 'Invitado'),
        text: '',
        mediaUrl,
        mediaType,
        timestamp: Date.now()
      };

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('cinema-chat-message', {
          id: msgAction.id,
          sender: 'Tú',
          isMe: true,
          text: '',
          mediaUrl,
          mediaType,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        this.mainWindow.webContents.send('cinema-p2p-send', msgAction);
      }
    });

    // Sincronización de estado de Sala Multimedia (cola de video, tiempo, estado de play)
    ipcMain.on('cinema-player-sync-send', (event, payload: any) => {
      if (this.status.inRoom) {
        this.syncVideoAction({
          type: 'player_sync_state',
          payload,
          timestamp: Date.now()
        });
      }
    });

    // Historial de conversación recibido desde WebRTC
    ipcMain.on('cinema-chat-history-received', (event, messages: any[]) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed() && Array.isArray(messages)) {
        const myName = this.status.username || (this.status.isHost ? 'Anfitrión' : 'Invitado');
        const formatted = messages.map((m: any) => ({
          id: m.id,
          sender: (m.sender === myName || (this.status.isHost && m.sender === 'Anfitrión')) ? 'Tú' : (m.sender || 'Amigo'),
          isMe: (m.sender === myName || (this.status.isHost && m.sender === 'Anfitrión')),
          text: m.text || '',
          mediaUrl: m.mediaUrl,
          mediaType: m.mediaType,
          time: new Date(m.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }));
        this.mainWindow.webContents.send('cinema-chat-history', formatted);
      }
    });

    // Reacción con emojis estilo Rave recibida
    ipcMain.on('cinema-reaction-received', (event, emoji: string) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed() && emoji) {
        this.mainWindow.webContents.send('cinema-reaction', emoji);
      }
    });

    // Enviar reacción con emojis estilo Rave
    ipcMain.on('cinema-reaction-send', (event, emoji: string) => {
      if (!this.status.inRoom || !emoji) return;
      this.syncVideoAction({
        type: 'reaction',
        emoji,
        sender: this.status.username || (this.status.isHost ? 'Anfitrión' : 'Invitado'),
        timestamp: Date.now()
      });
    });

    // Eventos enviados desde la página web reproducida (view-preload)
    ipcMain.on('cinema-video-event', (event, action: any) => {
      if (this.status.inRoom) {
        this.syncVideoAction(action);
      }
    });

    ipcMain.handle('cinema-get-server-port', async () => {
      let port = CinemaServer.getPort();
      if (!port) {
        port = await CinemaServer.start();
      }
      return port;
    });

    ipcMain.handle('cinema-extract-media', async (event, url: string) => {
      try {
        return await MediaExtractor.extract(url);
      } catch (err) {
        console.error('[CinemaService] Error en cinema-extract-media:', err);
        return null;
      }
    });
  }
}
