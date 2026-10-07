import { ipcRenderer } from 'electron';

export interface CinemaAction {
  type: 'play' | 'pause' | 'seek' | 'url' | 'rate' | 'chat' | 'handshake' | 'guest_info' | 'player_sync_state' | 'control_mode_update' | 'participants_update' | 'control_denied' | 'room_full' | 'chat_history' | 'reaction';
  currentTime?: number;
  url?: string;
  rate?: number;
  timestamp?: number;
  id?: string;
  text?: string;
  sender?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'sticker' | 'gif';
  mode?: 'player' | 'browser';
  hostName?: string;
  guestName?: string;
  payload?: any;
  maxParticipants?: number;
  controlMode?: 'host_only' | 'everyone';
  participants?: any[];
  message?: string;
  messages?: any[];
  emoji?: string;
}

export interface CinemaParticipant {
  id: string;
  name: string;
  isHost: boolean;
}

export class CinemaPeerManager {
  private peer: any = null;
  // Mapa de conexiones activas en el Host: peerId -> DataConnection
  private connections: Map<string, any> = new Map();
  // Conexión del Invitado hacia el Host
  private hostConnection: any = null;
  // Registro de participantes: peerId -> CinemaParticipant
  private participants: Map<string, CinemaParticipant> = new Map();

  // Historial de chat y último estado de reproducción sincronizado (Estilo Rave)
  private chatHistory: any[] = [];
  private lastPlayerSyncState: any = null;

  public inRoom: boolean = false;
  public roomId: string | null = null;
  public isHost: boolean = false;
  public partnerConnected: boolean = false;
  public maxParticipants: number = 6;
  public controlMode: 'host_only' | 'everyone' = 'host_only';
  public username: string = 'Usuario';
  public roomMode: 'player' | 'browser' = 'player';

  private localAudioStream: MediaStream | null = null;
  private activeCalls: Map<string, any> = new Map();
  private remoteAudioElements: Map<string, HTMLAudioElement> = new Map();

  constructor() {
    this.registerIpc();
  }

  private registerIpc() {
    // Escuchar acciones que envía la pestaña local (play, pause, etc.) para transmitirlas
    ipcRenderer.on('cinema-p2p-send', (event, action: CinemaAction) => {
      this.sendAction(action);
    });
  }

  public getPeerClass(): any {
    try {
      const mod = require('peerjs');
      return mod.Peer || mod.default || mod;
    } catch {
      return (window as any).Peer;
    }
  }

  private normalizePeerId(code: string): string {
    const clean = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normalized = clean.startsWith('CINE') ? clean : `CINE${clean}`;
    return `wbcine-${normalized}`;
  }

  private getParticipantsArray(): CinemaParticipant[] {
    return Array.from(this.participants.values());
  }

  public async createRoom(
    rawRoomId: string,
    maxParticipants: number = 6,
    controlMode: 'host_only' | 'everyone' = 'host_only',
    username: string = 'Anfitrión'
  ): Promise<boolean> {
    const PeerClass = this.getPeerClass();
    if (!PeerClass) {
      console.error('[CinemaPeer] PeerJS no está cargado');
      return false;
    }

    this.cleanup();
    this.chatHistory = [];
    this.lastPlayerSyncState = null;
    this.maxParticipants = Math.max(2, Math.min(8, Number(maxParticipants) || 6));
    this.controlMode = controlMode === 'everyone' ? 'everyone' : 'host_only';
    this.username = username || 'Anfitrión';

    const peerId = this.normalizePeerId(rawRoomId);
    console.log(`[CinemaPeer] Creando sala como Host (${peerId}), Capacidad: ${this.maxParticipants}, Control: ${this.controlMode}`);

    return new Promise((resolve) => {
      try {
        this.peer = new PeerClass(peerId, {
          debug: 1,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' }
            ]
          }
        });

        this.peer.on('open', (id: string) => {
          console.log(`[CinemaPeer] Sala abierta en cloud PeerJS: ${id}`);
          this.inRoom = true;
          this.roomId = rawRoomId;
          this.isHost = true;
          this.participants.set('host', { id: 'host', name: this.username, isHost: true });
          resolve(true);
        });

        this.peer.on('connection', (conn: any) => {
          // Validar límite máximo de participantes (Topología Estrella)
          if (this.connections.size >= (this.maxParticipants - 1)) {
            console.warn(`[CinemaPeer] Sala llena (${this.connections.size + 1}/${this.maxParticipants}). Rechazando conexión.`);
            conn.on('open', () => {
              try {
                conn.send({
                  type: 'room_full',
                  maxParticipants: this.maxParticipants
                });
              } catch {}
              setTimeout(() => {
                try { conn.close(); } catch {}
              }, 500);
            });
            return;
          }

          console.log('[CinemaPeer] ¡Conexión P2P entrante de participante recibida!');
          this.setupHostConnection(conn);
        });

        // Soporte para llamadas de voz entrantes (Micrófono)
        this.peer.on('call', (call: any) => {
          console.log(`[CinemaPeer] Llamada de audio entrante recibida de ${call.peer}`);
          if (this.localAudioStream) {
            call.answer(this.localAudioStream);
          } else {
            call.answer();
          }
          this.setupCall(call, call.peer);
        });

        this.peer.on('error', (err: any) => {
          console.error('[CinemaPeer] Error en Peer Host:', err);
          if (!this.inRoom) resolve(false);
        });
      } catch (err) {
        console.error('[CinemaPeer] Error instanciando Peer Host:', err);
        resolve(false);
      }
    });
  }

  private setupHostConnection(conn: any) {
    conn.on('open', () => {
      console.log(`[CinemaPeer] Canal WebRTC DataChannel ABIERTO con participante: ${conn.peer}`);
      this.connections.set(conn.peer, conn);
      this.partnerConnected = true;

      // Enviar handshake inicial con todos los datos y configuración de la sala
      try {
        conn.send({
          type: 'handshake',
          mode: this.roomMode,
          hostName: this.username,
          maxParticipants: this.maxParticipants,
          controlMode: this.controlMode,
          participants: this.getParticipantsArray(),
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('[CinemaPeer] Error enviando handshake a participante:', err);
      }

      // Si el Host ya tiene el micrófono activado, conectar voz con el nuevo participante
      if (this.localAudioStream) {
        try {
          const call = this.peer.call(conn.peer, this.localAudioStream);
          this.setupCall(call, conn.peer);
        } catch (callErr) {
          console.warn('[CinemaPeer] Error llamando a nuevo participante con voz:', callErr);
        }
      }
    });

    conn.on('data', (action: CinemaAction) => {
      // 1. Información de usuario del invitado
      if (action.type === 'guest_info') {
        const guestName = action.guestName || 'Invitado';
        this.participants.set(conn.peer, {
          id: conn.peer,
          name: guestName,
          isHost: false
        });
        const pList = this.getParticipantsArray();
        this.broadcast({
          type: 'participants_update',
          participants: pList
        });
        ipcRenderer.send('cinema-participants-updated', pList);
        ipcRenderer.send('cinema-partner-status', true);

        // [Rave Sync] Enviar estado actual del reproductor al nuevo invitado inmediatamente
        if (this.lastPlayerSyncState) {
          try {
            conn.send({
              type: 'player_sync_state',
              payload: this.lastPlayerSyncState,
              timestamp: Date.now()
            });
          } catch (e) {
            console.warn('[CinemaPeer] Error enviando player_sync_state a nuevo invitado:', e);
          }
        }

        // [Rave Chat] Enviar historial completo de conversación previa al nuevo invitado
        if (this.chatHistory.length > 0) {
          try {
            conn.send({
              type: 'chat_history',
              messages: this.chatHistory,
              timestamp: Date.now()
            });
          } catch (e) {
            console.warn('[CinemaPeer] Error enviando chat_history a nuevo invitado:', e);
          }
        }
        return;
      }

      // 2. Comprobar permisos estilo Rave: Si está en 'host_only', solo el anfitrión puede controlar
      const isControlAction = action.type === 'player_sync_state' || action.type === 'play' || action.type === 'pause' || action.type === 'seek' || action.type === 'url';
      if (isControlAction) {
        if (this.controlMode === 'host_only') {
          console.warn(`[CinemaPeer] Acción de reproducción rechazada de ${conn.peer} (Modo: Solo Anfitrión)`);
          try {
            conn.send({
              type: 'control_denied',
              message: 'Solo el anfitrión tiene el control de reproducción en esta sala.'
            });
          } catch {}
          return;
        }

        // Si es colaborativo ('everyone'), el Host guarda estado, aplica la acción y la retransmite al resto
        if (action.type === 'player_sync_state') {
          this.lastPlayerSyncState = action.payload;
        }
        ipcRenderer.send('cinema-p2p-received', action);
        this.broadcast(action, conn.peer);
        return;
      }

      // 3. Mensajes de Chat P2P (Siempre permitidos a todos los participantes)
      if (action.type === 'chat') {
        this.chatHistory.push(action);
        ipcRenderer.send('cinema-p2p-received', action);
        this.broadcast(action, conn.peer);
        return;
      }

      // 4. Reacciones flotantes de Emojis estilo Rave
      if (action.type === 'reaction') {
        if (action.emoji) {
          ipcRenderer.send('cinema-reaction-received', action.emoji);
          this.broadcast(action, conn.peer);
        }
        return;
      }

      // 5. Otras acciones
      ipcRenderer.send('cinema-p2p-received', action);
    });

    conn.on('close', () => {
      console.log(`[CinemaPeer] Participante desconectado: ${conn.peer}`);
      this.connections.delete(conn.peer);
      this.participants.delete(conn.peer);
      this.partnerConnected = this.connections.size > 0;

      const pList = this.getParticipantsArray();
      this.broadcast({
        type: 'participants_update',
        participants: pList
      });
      ipcRenderer.send('cinema-participants-updated', pList);
      ipcRenderer.send('cinema-partner-status', this.partnerConnected);
    });

    conn.on('error', (err: any) => {
      console.error(`[CinemaPeer] Error en DataConnection (${conn.peer}):`, err);
    });
  }

  public async joinRoom(rawRoomId: string, username: string = 'Invitado'): Promise<boolean> {
    const PeerClass = this.getPeerClass();
    if (!PeerClass) {
      console.error('[CinemaPeer] PeerJS no está cargado');
      return false;
    }

    this.cleanup();
    this.chatHistory = [];
    this.lastPlayerSyncState = null;
    this.username = username || 'Invitado';

    const targetPeerId = this.normalizePeerId(rawRoomId);
    console.log(`[CinemaPeer] Conectando como Invitado a Host: ${targetPeerId}`);

    return new Promise((resolve) => {
      try {
        this.peer = new PeerClass(undefined, {
          debug: 1,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' }
            ]
          }
        });

        this.peer.on('open', (myId: string) => {
          console.log(`[CinemaPeer] Guest peer abierto (${myId}), conectando a ${targetPeerId}...`);
          this.hostConnection = this.peer.connect(targetPeerId, { reliable: true });
          this.setupGuestConnection(this.hostConnection);
          this.inRoom = true;
          this.roomId = rawRoomId;
          this.isHost = false;
          resolve(true);
        });

        // Soporte para llamadas de voz entrantes (Micrófono)
        this.peer.on('call', (call: any) => {
          console.log('[CinemaPeer] Llamada de voz entrante recibida en el Invitado');
          if (this.localAudioStream) {
            call.answer(this.localAudioStream);
          } else {
            call.answer();
          }
          this.setupCall(call, call.peer);
        });

        this.peer.on('error', (err: any) => {
          console.error('[CinemaPeer] Error en joinRoom:', err);
          if (!this.inRoom) resolve(false);
        });
      } catch (err) {
        console.error('[CinemaPeer] Error en joinRoom:', err);
        resolve(false);
      }
    });
  }

  private setupGuestConnection(conn: any) {
    conn.on('open', () => {
      console.log('[CinemaPeer] Canal WebRTC P2P con el Anfitrión ABIERTO ✓');
      this.partnerConnected = true;
      conn.send({
        type: 'guest_info',
        guestName: this.username,
        timestamp: Date.now()
      });
      ipcRenderer.send('cinema-partner-status', true);
    });

    conn.on('data', (action: CinemaAction) => {
      // 1. Notificación de sala llena
      if (action.type === 'room_full') {
        console.warn('[CinemaPeer] La sala a la que se intentó unir está llena.');
        ipcRenderer.send('cinema-room-full', action.maxParticipants || 6);
        this.cleanup();
        return;
      }

      // 2. Control denegado (Rave style: Solo Anfitrión)
      if (action.type === 'control_denied') {
        ipcRenderer.send('cinema-control-denied', action.message || 'Solo el anfitrión tiene el control de reproducción.');
        return;
      }

      // 3. Actualización de permisos de la sala
      if (action.type === 'control_mode_update') {
        this.controlMode = action.controlMode === 'everyone' ? 'everyone' : 'host_only';
        ipcRenderer.send('cinema-p2p-received', action);
        return;
      }

      // 4. Actualización de participantes
      if (action.type === 'participants_update' && action.participants) {
        ipcRenderer.send('cinema-participants-updated', action.participants);
        return;
      }

      // 5. Handshake del anfitrión
      if (action.type === 'handshake') {
        if (action.maxParticipants) this.maxParticipants = action.maxParticipants;
        if (action.controlMode) this.controlMode = action.controlMode;
        if (action.mode) this.roomMode = action.mode;
        if (action.participants) {
          ipcRenderer.send('cinema-participants-updated', action.participants);
        }
        ipcRenderer.send('cinema-p2p-received', action);
        return;
      }

      // 6. Historial de conversación recibido del anfitrión (Rave Chat Sync)
      if (action.type === 'chat_history' && Array.isArray(action.messages)) {
        this.chatHistory = action.messages;
        ipcRenderer.send('cinema-chat-history-received', action.messages);
        return;
      }

      // 7. Reacciones flotantes de Emojis estilo Rave recibidas
      if (action.type === 'reaction' && action.emoji) {
        ipcRenderer.send('cinema-reaction-received', action.emoji);
        return;
      }

      // 8. Resto de eventos sincronizados (chat individual, player_sync_state, etc.)
      if (action.type === 'chat') {
        this.chatHistory.push(action);
      }
      ipcRenderer.send('cinema-p2p-received', action);
    });

    conn.on('close', () => {
      console.log('[CinemaPeer] Conexión P2P cerrada con el Anfitrión');
      this.partnerConnected = false;
      ipcRenderer.send('cinema-partner-status', false);
    });

    conn.on('error', (err: any) => {
      console.error('[CinemaPeer] Error en DataConnection con Anfitrión:', err);
    });
  }

  public broadcast(action: CinemaAction, excludePeerId?: string) {
    for (const [peerId, conn] of this.connections) {
      if (excludePeerId && peerId === excludePeerId) continue;
      try {
        if (conn && conn.open) {
          conn.send(action);
        }
      } catch (err) {
        console.warn(`[CinemaPeer] Error al retransmitir a ${peerId}:`, err);
      }
    }
  }

  public sendAction(action: CinemaAction) {
    if (action.type === 'chat') {
      this.chatHistory.push(action);
    }
    if (action.type === 'player_sync_state') {
      this.lastPlayerSyncState = action.payload;
    }

    if (this.isHost) {
      // El host retransmite la acción a todos los participantes conectados
      this.broadcast(action);
    } else {
      // El invitado envía la acción directamente al Host
      if (this.hostConnection && this.partnerConnected) {
        try {
          this.hostConnection.send(action);
        } catch (err) {
          console.error('[CinemaPeer] Error enviando acción al Host:', err);
        }
      }
    }
  }

  public updateControlMode(mode: 'host_only' | 'everyone') {
    this.controlMode = mode;
    if (this.isHost) {
      this.broadcast({
        type: 'control_mode_update',
        controlMode: mode
      });
    }
  }

  public async toggleMicrophone(active: boolean): Promise<boolean> {
    if (active) {
      try {
        this.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (this.peer) {
          if (this.isHost) {
            // Llamar a todos los participantes conectados
            for (const [peerId] of this.connections) {
              try {
                const call = this.peer.call(peerId, this.localAudioStream);
                this.setupCall(call, peerId);
              } catch (e) {
                console.warn(`[CinemaPeer] Error llamando por voz a ${peerId}:`, e);
              }
            }
          } else if (this.hostConnection && this.partnerConnected) {
            // Llamar al anfitrión
            const targetPeerId = this.hostConnection.peer;
            const call = this.peer.call(targetPeerId, this.localAudioStream);
            this.setupCall(call, targetPeerId);
          }
        }
        return true;
      } catch (err) {
        console.error('[CinemaPeer] Error activando micrófono:', err);
        return false;
      }
    } else {
      if (this.localAudioStream) {
        this.localAudioStream.getTracks().forEach(t => t.stop());
        this.localAudioStream = null;
      }
      for (const [callId, call] of this.activeCalls) {
        try { call.close(); } catch {}
      }
      this.activeCalls.clear();
      return false;
    }
  }

  private setupCall(call: any, peerId: string) {
    this.activeCalls.set(peerId, call);

    call.on('stream', (remoteStream: MediaStream) => {
      console.log(`[CinemaPeer] Stream de audio remoto conectado para: ${peerId}`);
      let audioEl = this.remoteAudioElements.get(peerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
        this.remoteAudioElements.set(peerId, audioEl);
      }
      audioEl.srcObject = remoteStream;
    });

    call.on('close', () => {
      console.log(`[CinemaPeer] Llamada de voz finalizada con: ${peerId}`);
      const audioEl = this.remoteAudioElements.get(peerId);
      if (audioEl) {
        audioEl.srcObject = null;
        audioEl.remove();
        this.remoteAudioElements.delete(peerId);
      }
      this.activeCalls.delete(peerId);
    });

    call.on('error', (err: any) => {
      console.error(`[CinemaPeer] Error en llamada de voz con ${peerId}:`, err);
    });
  }

  public cleanup() {
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach(t => t.stop());
      this.localAudioStream = null;
    }
    for (const [callId, call] of this.activeCalls) {
      try { call.close(); } catch {}
    }
    this.activeCalls.clear();

    for (const [peerId, audioEl] of this.remoteAudioElements) {
      try {
        audioEl.srcObject = null;
        audioEl.remove();
      } catch {}
    }
    this.remoteAudioElements.clear();

    for (const [peerId, conn] of this.connections) {
      try { conn.close(); } catch {}
    }
    this.connections.clear();
    this.participants.clear();

    if (this.hostConnection) {
      try { this.hostConnection.close(); } catch {}
      this.hostConnection = null;
    }

    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }

    this.inRoom = false;
    this.roomId = null;
    this.isHost = false;
    this.partnerConnected = false;
    this.chatHistory = [];
    this.lastPlayerSyncState = null;
  }
}

export const cinemaPeerInstance = new CinemaPeerManager();
