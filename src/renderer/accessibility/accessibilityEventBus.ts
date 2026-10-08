/**
 * accessibilityEventBus.ts
 *
 * Arquitectura orientada a eventos para el subsistema de accesibilidad de NavegadorBeta.
 * Desacopla completamente el módulo de seguimiento de mirada (Gaze Tracking)
 * del módulo de reconocimiento de voz y otros módulos de accesibilidad.
 */

export type AccessibilityEventType =
  | 'click'
  | 'scroll'
  | 'navigate'
  | 'gaze-pos'
  | 'dwell-start'
  | 'dwell-progress'
  | 'dwell-click'
  | 'blink-click'
  | 'gaze-status'
  | 'gaze-toggle'
  | 'voice-command'
  | 'calibration-request'
  | 'calibration-completed';

export interface AccessibilityClickEvent {
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  source?: 'gaze-dwell' | 'gaze-blink' | 'voice' | 'manual';
  timestamp?: number;
}

export interface AccessibilityScrollEvent {
  direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';
  amount?: number;
  source?: 'gaze' | 'voice' | 'manual';
}

export interface AccessibilityGazePosEvent {
  x: number;
  y: number;
  rawX: number;
  rawY: number;
  isFixated: boolean;
  velocity: number;
  timestamp: number;
}

export interface AccessibilityDwellProgressEvent {
  progress: number; // 0.0 a 1.0
  x: number;
  y: number;
  dwellTime: number;
}

export interface AccessibilityBlinkClickEvent {
  x: number;
  y: number;
  duration: number; // ms
  ear: number;
  eye: 'both' | 'left' | 'right';
}

export interface AccessibilityStatusEvent {
  status: 'inactive' | 'calibrating' | 'active';
  error?: string;
  calibrated?: boolean;
}

export interface AccessibilityVoiceCommandEvent {
  command: string;
  text?: string;
  params?: Record<string, any>;
  confidence?: number;
}

type EventCallback = (data: any) => void;

export class AccessibilityEventBus {
  private static instance: AccessibilityEventBus | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private ipcAttached: boolean = false;

  private constructor() {
    this.setupIpcBridge();
  }

  public static getInstance(): AccessibilityEventBus {
    if (!AccessibilityEventBus.instance) {
      AccessibilityEventBus.instance = new AccessibilityEventBus();
      // Exponer globalmente en window para compatibilidad entre módulos
      if (typeof window !== 'undefined') {
        (window as any).AccessibilityEventBus = AccessibilityEventBus.instance;
      }
    }
    return AccessibilityEventBus.instance;
  }

  /**
   * Suscribirse a un evento
   */
  public on(event: AccessibilityEventType | string, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Retorna función de desuscripción limpia
    return () => {
      this.off(event, callback);
    };
  }

  /**
   * Suscribirse a un evento una única vez
   */
  public once(event: AccessibilityEventType | string, callback: EventCallback): () => void {
    const wrapped: EventCallback = (data: any) => {
      this.off(event, wrapped);
      callback(data);
    };
    return this.on(event, wrapped);
  }

  /**
   * Desuscribir callback
   */
  public off(event: AccessibilityEventType | string, callback: EventCallback): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Disparar un evento localmente en el bus
   */
  public emit(event: AccessibilityEventType | string, data: any = {}): void {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[AccessibilityEventBus] Error en listener de '${event}':`, err);
        }
      });
    }
  }

  /**
   * Difundir un evento tanto localmente como a través del proceso principal (IPC)
   * a todas las ventanas y vistas del navegador.
   */
  public broadcast(event: AccessibilityEventType | string, data: any = {}): void {
    // 1. Emitir localmente
    this.emit(event, data);

    // 2. Difundir por IPC si está disponible betaAPI
    try {
      const api = (window as any).betaAPI;
      if (api?.gaze?.broadcast) {
        api.gaze.broadcast({ type: event, data });
      }
    } catch (err) {
      console.warn('[AccessibilityEventBus] Error al emitir broadcast IPC:', err);
    }
  }

  /**
   * Conectar el bus a eventos IPC entrantes desde otras ventanas o el proceso principal
   */
  private setupIpcBridge(): void {
    if (this.ipcAttached || typeof window === 'undefined') return;

    try {
      const api = (window as any).betaAPI;
      if (api?.gaze?.onEvent) {
        api.gaze.onEvent((payload: { type: string; data: any }) => {
          if (payload && payload.type) {
            // Emitir solo a los listeners locales sin re-difundir por IPC
            this.emit(payload.type, payload.data);
          }
        });
        this.ipcAttached = true;
      }
    } catch {}
  }
}

// Instancia singleton por defecto
export const accessibilityBus = AccessibilityEventBus.getInstance();
