import { app } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  timestamp: number;
  favicon?: string;
}

export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  addedAt: number;
}

export interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  speed?: number;
  timestamp?: number;
}

export interface SettingsState {
  aiApiKey: string;
  aiPersonaContext: string;
  semanticTabsEnabled: boolean;
  adblockEnabled: boolean;
  hibernationEnabled: boolean;
  hibernationTimeoutMinutes: number;
  prerenderEnabled: boolean;
  hardwareAcceleration: boolean;
  phantomCacheEnabled: boolean;
  theme: 'dark' | 'light';
  searchEngine: string;
  efficiencyMode?: boolean;
  uiAnimations?: boolean;
  showBookmarksBar?: boolean;
  adultBlockerEnabled?: boolean;
  adultBlockerPassword?: string;
  pomodoroEnabled?: boolean;
  pomodoroPassword?: string;
  pomodoroTimeLimit?: number;
  timeMachineEnabled?: boolean;
  splitAudioEnabled?: boolean;
  aiMediaTranslatorEnabled?: boolean;
  warnOnCloseMultipleTabs?: boolean;
  enableGazeNavigation?: boolean;
  gazeCalibrated?: boolean;
  gazeProfile?: GazeProfile;
}

export interface GazeProfile {
  sensitivityX: number;
  sensitivityY: number;
  deadzone: number;
  dwellTime: number;
  dwellRadius: number;
  blinkClickEnabled: boolean;
  earThreshold: number;
  soundFeedbackEnabled?: boolean;
  cameraId?: string;
  cameraLabel?: string;
  calibrationModel?: {
    coeffX: number[];
    coeffY: number[];
    points: { eyeX: number; eyeY: number; screenX: number; screenY: number }[];
  };
}

export interface PhantomMessage {
  id: string;
  platform: 'whatsapp' | 'instagram';
  sender: string;
  chatName: string;
  text?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  mediaData?: string; // base64 or local filepath
  timestamp: number;
  isDeleted: boolean;
  deletedAt?: number;
  isOutgoing?: boolean;
}

export interface SavedStatus {
  id: string;
  sender: string;
  avatar?: string;
  timestamp: number;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  caption?: string;
  savedAt: number;
}

interface BrowserBetaData {
  history: HistoryItem[];
  bookmarks: BookmarkItem[];
  downloads: DownloadItem[];
  settings: SettingsState;
  phantomMessages: PhantomMessage[];
  savedStatuses: SavedStatus[];
}

const DEFAULT_SETTINGS: SettingsState = {
  aiApiKey: '',
  aiPersonaContext: 'Soy un profesional proactivo, interesado en tecnología, desarrollo y aprendizaje rápido.',
  semanticTabsEnabled: true,
  adblockEnabled: true,
  hibernationEnabled: true,
  hibernationTimeoutMinutes: 15,
  prerenderEnabled: true,
  hardwareAcceleration: true,
  phantomCacheEnabled: true,
  theme: 'dark',
  searchEngine: 'https://www.google.com/search?q=',
  efficiencyMode: true,
  uiAnimations: true,
  showBookmarksBar: true,
  adultBlockerEnabled: false,
  adultBlockerPassword: '',
  pomodoroEnabled: false,
  pomodoroPassword: '',
  pomodoroTimeLimit: 25,
  timeMachineEnabled: false,
  splitAudioEnabled: false,
  aiMediaTranslatorEnabled: false,
  warnOnCloseMultipleTabs: true,
  enableGazeNavigation: false,
  gazeCalibrated: false,
  gazeProfile: {
    sensitivityX: 1.0,
    sensitivityY: 1.0,
    deadzone: 18,
    dwellTime: 1000,
    dwellRadius: 32,
    blinkClickEnabled: true,
    earThreshold: 0.20,
    soundFeedbackEnabled: true
  }
};

export class StorageService {
  private static dataPath = path.join(app.getPath('userData'), 'beta-data.json');
  private static data: BrowserBetaData = {
    history: [],
    bookmarks: [],
    downloads: [],
    settings: DEFAULT_SETTINGS,
    phantomMessages: [],
    savedStatuses: []
  };
  private static saveTimeout: NodeJS.Timeout | null = null;
  private static readonly MAX_HISTORY_ITEMS = 2500;
  private static readonly MAX_PHANTOM_MESSAGES = 1000;

  static async init() {
    try {
      const fileContent = await fs.readFile(this.dataPath, 'utf-8');
      const parsed = JSON.parse(fileContent);
      
      // Sanitizar historial y marcadores antiguos para eliminar 'Cargando...' y urls internas
      const cleanHistory = (parsed.history || [])
        .filter((h: any) => h.url && !h.url.startsWith('beta://') && h.url !== 'about:blank')
        .map((h: any) => {
          if (!h.title || h.title.trim().toLowerCase() === 'cargando...' || h.title.trim().toLowerCase() === 'cargando') {
            try {
              h.title = new URL(h.url).hostname.replace(/^www\./, '');
            } catch {
              h.title = h.url;
            }
          }
          return h;
        });

      const cleanBookmarks = (parsed.bookmarks || [])
        .filter((b: any) => b.url && !b.url.startsWith('beta://') && b.url !== 'about:blank');

      // Sanitizar estados: purgar capturas accidentales con 'Estados'
      const cleanStatuses = (parsed.savedStatuses || []).filter((s: any) => {
        if (!s || !s.sender) return false;
        const snd = s.sender.trim().toLowerCase();
        if (snd === 'estados' || snd === 'status' || snd === 'contacto') return false;
        if (!s.mediaUrl || s.mediaUrl.length < 200) return false;
        return true;
      });

      // Sanitizar mensajes: purgar capturas corruptas/basura y separar horas pegadas al texto
      const cleanMessages = (parsed.phantomMessages || [])
        .filter((m: any) => {
          if (!m || !m.sender) return false;
          const snd = m.sender.trim().toLowerCase();
          if (snd === 'contacto de prueba') return false;
          if (StorageService.isGarbageMessage(m)) return false;
          return true;
        })
        .map((m: any) => {
          if (m.text) {
            m.text = StorageService.stripTrailingTimestamp(m.text);
          }
          return m;
        })
        .filter((m: any) => (m.text && m.text.length > 0) || m.mediaData);

      this.data = {
        history: cleanHistory,
        bookmarks: cleanBookmarks,
        downloads: parsed.downloads || [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        phantomMessages: cleanMessages,
        savedStatuses: cleanStatuses
      };

      if (cleanStatuses.length !== (parsed.savedStatuses || []).length || cleanMessages.length !== (parsed.phantomMessages || []).length) {
        await this.saveNow();
      }

      console.log('[Storage] Base de datos de NavegadorBeta cargada y sanitizada ✓');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        console.log('[Storage] Archivo de datos no existe, inicializando defaults...');
        await this.saveNow();
      } else {
        console.error('[Storage] Error leyendo base de datos:', err);
      }
    }
  }

  private static scheduleSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveNow();
    }, 1500);
  }

  private static async saveNow() {
    try {
      await fs.writeFile(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Storage] Error guardando base de datos:', err);
    }
  }

  // --- Historial ---
  static addHistory(url: string, title: string, favicon?: string) {
    if (!url || url === 'about:blank' || url.startsWith('devtools://') || url.startsWith('beta://')) return;

    let cleanTitle = title;
    if (!cleanTitle || cleanTitle.trim().toLowerCase() === 'cargando...' || cleanTitle.trim().toLowerCase() === 'cargando') {
      try {
        cleanTitle = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        cleanTitle = url;
      }
    }

    const lastItem = this.data.history[0];
    if (lastItem && lastItem.url === url) {
      lastItem.title = cleanTitle || lastItem.title;
      lastItem.favicon = favicon || lastItem.favicon;
      lastItem.timestamp = Date.now();
    } else {
      this.data.history.unshift({
        id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
        url,
        title: cleanTitle || url,
        timestamp: Date.now(),
        favicon
      });
    }

    if (this.data.history.length > this.MAX_HISTORY_ITEMS) {
      this.data.history = this.data.history.slice(0, this.MAX_HISTORY_ITEMS);
    }

    this.scheduleSave();
  }

  static getHistory(): HistoryItem[] {
    return this.data.history;
  }

  static clearHistory(timeThreshold: number = 0) {
    if (timeThreshold === 0) {
      this.data.history = [];
    } else {
      this.data.history = this.data.history.filter(item => item.timestamp < timeThreshold);
    }
    this.saveNow();
  }

  // --- Marcadores ---
  static addBookmark(url: string, title: string): boolean {
    const exists = this.data.bookmarks.find(b => b.url === url);
    if (!exists) {
      this.data.bookmarks.unshift({
        id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
        url,
        title: title || url,
        addedAt: Date.now()
      });
      this.scheduleSave();
      return true;
    }
    this.data.bookmarks = this.data.bookmarks.filter(b => b.url !== url);
    this.scheduleSave();
    return false;
  }

  static getBookmarks(): BookmarkItem[] {
    return this.data.bookmarks;
  }

  // --- Descargas ---
  static updateDownload(item: DownloadItem) {
    const index = this.data.downloads.findIndex(d => d.id === item.id);
    if (index >= 0) {
      this.data.downloads[index] = item;
    } else {
      this.data.downloads.unshift(item);
    }
    this.scheduleSave();
  }

  static getDownloads(): DownloadItem[] {
    return this.data.downloads;
  }

  // --- Ajustes ---
  static getSettings(): SettingsState {
    return this.data.settings;
  }

  static updateSettings(partial: Partial<SettingsState>): SettingsState {
    this.data.settings = { ...this.data.settings, ...partial };
    this.scheduleSave();
    return this.data.settings;
  }

  // --- Ojo de Halcón (Phantom Cache) ---
  static stripTrailingTimestamp(str: string): string {
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

  static isGarbageMessage(m: any): boolean {
    if (!m) return true;
    const txt = (m.text || '').trim();
    if (!txt && !m.mediaData) return true;
    if (txt) {
      if (/ic-search|ic-more-vert|ic-attach|ic-mic|Escribe un mensaje/i.test(txt)) return true;
      if (/tail-in|tail-out|recalled/i.test(txt)) return true;
      if (/Usa WhatsApp en tu teléfono para ver mensajes anteriores/i.test(txt)) return true;
      if (/^(?:este\s+mensaje\s+fue\s+eliminado|se\s+elimin[oó]\s+este\s+mensaje|this\s+message\s+was\s+deleted|you\s+deleted\s+this\s+message)\.?$/i.test(txt) && !m.mediaData) return true;
    }
    return false;
  }

  static savePhantomMessage(msg: PhantomMessage) {
    if (!msg) return;
    if (this.isGarbageMessage(msg)) return;

    if (msg.text) {
      msg.text = this.stripTrailingTimestamp(msg.text);
    }
    if (!msg.text && !msg.mediaData) return;

    if (msg.isOutgoing === undefined) {
      msg.isOutgoing = msg.sender === 'Tú' || msg.sender === 'You' || (msg.id && msg.id.startsWith('true_')) ? true : false;
    }

    if (!this.data.phantomMessages) this.data.phantomMessages = [];

    // Deduplicación por id o por contenido idéntico reciente en el mismo chat
    const existingIndex = this.data.phantomMessages.findIndex(m => 
      m.id === msg.id || 
      (m.sender === msg.sender && m.chatName === msg.chatName && m.text && m.text === msg.text && Math.abs(m.timestamp - msg.timestamp) < 5000)
    );

    if (existingIndex >= 0) {
      this.data.phantomMessages[existingIndex] = {
        ...this.data.phantomMessages[existingIndex],
        ...msg,
        // Mantener texto o multimedia previo si el nuevo viene vacío
        text: msg.text || this.data.phantomMessages[existingIndex].text,
        mediaData: msg.mediaData || this.data.phantomMessages[existingIndex].mediaData,
        isOutgoing: msg.isOutgoing !== undefined ? msg.isOutgoing : this.data.phantomMessages[existingIndex].isOutgoing
      };
    } else {
      this.data.phantomMessages.unshift(msg);
      if (this.data.phantomMessages.length > this.MAX_PHANTOM_MESSAGES) {
        this.data.phantomMessages = this.data.phantomMessages.slice(0, this.MAX_PHANTOM_MESSAGES);
      }
    }
    this.scheduleSave();
  }

  static getPhantomMessages(): PhantomMessage[] {
    return this.data.phantomMessages;
  }

  static deletePhantomMessage(id: string) {
    this.data.phantomMessages = this.data.phantomMessages.filter(m => m.id !== id);
    this.scheduleSave();
  }

  static clearPhantomMessages() {
    this.data.phantomMessages = [];
    this.saveNow();
  }

  // --- Estados Guardados (WhatsApp Statuses) ---
  static saveStatus(status: SavedStatus) {
    if (!status || !status.sender) return;
    const cleanSender = status.sender
      .replace(/[\u2000-\u206F\uFEFF\u00A0\u180E\u200B-\u200D\u2060]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanSender.length < 2) return;

    const lower = cleanSender.toLowerCase();
    const forbidden = [
      'estado', 'estados', 'status', 'reciente', 'recientes', 'visto', 'vistos',
      'silenciado', 'silenciados', 'muted', 'recent', 'viewed', 'whatsapp',
      'contacto', 'contactos'
    ];
    if (forbidden.some(f => lower === f || lower.startsWith(f + ' ') || lower.endsWith(' ' + f))) return;
    if (!status.mediaUrl || status.mediaUrl.length < 200) return;

    // Normalizar mediaType
    if (status.mediaUrl.startsWith('data:image/') || status.mediaUrl.startsWith('data:video/')) {
      status.mediaType = status.mediaUrl.startsWith('data:video/') ? 'video' : 'image';
    }

    status.sender = cleanSender;

    if (!this.data.savedStatuses) this.data.savedStatuses = [];

    // Deduplicación inteligente: evitar duplicar el mismo estado del mismo contacto
    const existingIndex = this.data.savedStatuses.findIndex(s => 
      s.id === status.id ||
      (s.sender.toLowerCase() === cleanSender.toLowerCase() && s.mediaUrl === status.mediaUrl) ||
      (s.sender.toLowerCase() === cleanSender.toLowerCase() && 
       Math.abs(s.timestamp - status.timestamp) < 5000 && 
       (s.caption || '') === (status.caption || ''))
    );

    if (existingIndex >= 0) {
      this.data.savedStatuses[existingIndex] = {
        ...this.data.savedStatuses[existingIndex],
        ...status
      };
    } else {
      this.data.savedStatuses.unshift(status);
      if (this.data.savedStatuses.length > 500) {
        this.data.savedStatuses = this.data.savedStatuses.slice(0, 500);
      }
    }
    this.scheduleSave();
  }

  static getSavedStatuses(): SavedStatus[] {
    return this.data.savedStatuses || [];
  }

  static deleteStatus(id: string) {
    if (!this.data.savedStatuses) return;
    this.data.savedStatuses = this.data.savedStatuses.filter(s => s.id !== id);
    this.scheduleSave();
  }

  static deleteStatusesByContact(contactName: string) {
    if (!this.data.savedStatuses || !contactName) return;
    const clean = contactName.trim().toLowerCase();
    this.data.savedStatuses = this.data.savedStatuses.filter(s => 
      (s.sender || '').trim().toLowerCase() !== clean
    );
    this.scheduleSave();
  }

  static clearStatuses() {
    this.data.savedStatuses = [];
    this.saveNow();
  }
}
