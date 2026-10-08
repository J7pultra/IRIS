/**
 * gazeManager.ts
 *
 * Coordinador Maestro del Módulo de Accesibilidad Visual para NavegadorBeta.
 *
 * Responsabilidades:
 * 1. Control del Toggle Maestro y persistencia (`enableGazeNavigation`, `gazeCalibrated`, `gazeProfile`).
 * 2. Gestión de ciclo de vida de hardware (activación limpia y liberación instantánea de cámara web).
 * 3. Detección de "Primera Vez" y apertura automática del asistente de calibración `gaze-calibration.html`.
 * 4. Control del icono indicador en la barra de herramientas (Inactivo: gris, Calibrando: amarillo, Activo: verde).
 * 5. Orquestación del GazeTracker, GazeOverlay y el bus de eventos AccessibilityEventBus.
 */

import { GazeTracker } from './gazeTracker';
import { GazeOverlay } from './gazeOverlay';
import { CalibrationModel } from './calibrationModel';
import { AccessibilityEventBus } from './accessibilityEventBus';

export type GazeStatus = 'inactive' | 'calibrating' | 'active';

export class GazeManager {
  private static instance: GazeManager | null = null;
  private tracker: GazeTracker | null = null;
  private overlay: GazeOverlay | null = null;
  private bus: AccessibilityEventBus;

  private isEnabled: boolean = false;
  private isCalibrated: boolean = false;
  private status: GazeStatus = 'inactive';
  private currentProfile: any = null;

  private toolbarBtn: HTMLElement | null = null;

  private constructor() {
    this.bus = AccessibilityEventBus.getInstance();
    this.init();
  }

  public static getInstance(): GazeManager {
    if (!GazeManager.instance) {
      GazeManager.instance = new GazeManager();
      if (typeof window !== 'undefined') {
        (window as any).GazeManager = GazeManager.instance;
      }
    }
    return GazeManager.instance;
  }

  /**
   * Inicializa el estado desde los ajustes persistentes
   */
  public async init(): Promise<void> {
    try {
      const api = (window as any).betaAPI;
      let settings: any = {};
      if (api?.settings?.get) {
        settings = await api.settings.get() || {};
      }

      this.isEnabled = !!settings.enableGazeNavigation;
      this.isCalibrated = !!settings.gazeCalibrated;
      this.currentProfile = settings.gazeProfile || {
        sensitivityX: 1.0,
        sensitivityY: 1.0,
        deadzone: 18,
        dwellTime: 1000,
        dwellRadius: 32,
        blinkClickEnabled: true,
        earThreshold: 0.20,
        soundFeedbackEnabled: true
      };

      this.bindBusEvents();
      this.setupToolbarElement();

      // Si está configurado como activo y calibrado al arrancar
      if (this.isEnabled && this.isCalibrated) {
        await this.startTracking();
      } else {
        this.updateStatus('inactive');
      }
    } catch (err) {
      console.error('[GazeManager] Error durante inicialización:', err);
      this.updateStatus('inactive');
    }
  }

  /**
   * Conecta los elementos de UI de la barra superior (toolbar)
   */
  public setupToolbarElement(): void {
    if (typeof document === 'undefined') return;

    this.toolbarBtn = document.getElementById('btn-gaze-toolbar');
    if (this.toolbarBtn) {
      this.toolbarBtn.onclick = () => this.handleToolbarClick();
    }
    this.updateToolbarUi();
  }

  /**
   * Conmuta el estado de navegación por mirada (Toggle Maestro)
   */
  public async toggle(forceState?: boolean): Promise<boolean> {
    const newState = forceState !== undefined ? forceState : !this.isEnabled;

    if (newState === this.isEnabled && this.status !== 'inactive') {
      return this.isEnabled;
    }

    if (newState) {
      // Intentando activar: verificar si está calibrado
      if (!this.isCalibrated) {
        // Primera vez o recalibración requerida: NO activar tracking directo
        await this.openCalibration();
        return false;
      } else {
        // Calibrado: Activar directamente
        await this.startTracking();
        return true;
      }
    } else {
      // Desactivar: apagar cámara y limpiar UI
      await this.stopTracking();
      return false;
    }
  }

  /**
   * Abre la vista independiente de calibración (gaze-calibration.html)
   */
  public async openCalibration(): Promise<void> {
    this.updateStatus('calibrating');

    try {
      const api = (window as any).betaAPI;
      if (api?.gaze?.openCalibration) {
        await api.gaze.openCalibration();
      } else {
        // Fallback: abrir en ventana o pestaña secundaria
        window.open('gaze-calibration.html', '_blank', 'width=1280,height=800,frame=false');
      }
    } catch (err) {
      console.error('[GazeManager] Error al abrir calibración:', err);
      this.updateStatus('inactive');
    }
  }

  /**
   * Inicia el pipeline de tracking y el overlay del cursor
   */
  public async startTracking(): Promise<boolean> {
    this.isEnabled = true;
    this.updateStatus('active');

    // 1. Guardar estado en configuración persistente
    this.persistSettings({
      enableGazeNavigation: true,
      gazeCalibrated: true
    });

    // 2. Instanciar GazeTracker
    if (!this.tracker) {
      const savedModel = this.currentProfile?.calibrationModel || null;
      this.tracker = new GazeTracker(
        {
          sensitivityX: this.currentProfile?.sensitivityX || 1.0,
          sensitivityY: this.currentProfile?.sensitivityY || 1.0,
          deadzone: this.currentProfile?.deadzone || 18,
          earThreshold: this.currentProfile?.earThreshold || 0.20,
          blinkClickEnabled: this.currentProfile?.blinkClickEnabled !== false
        },
        savedModel
      );
    }

    const preferredDeviceId = this.currentProfile?.cameraId;
    let started = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      started = await this.tracker.start(preferredDeviceId);
      if (started) break;
      await new Promise(r => setTimeout(r, 450));
    }
    if (!started && preferredDeviceId) {
      // Fallback si la cámara calibrada fue desconectada
      started = await this.tracker.start();
    }
    if (!started) {
      console.warn('[GazeManager] No se pudo iniciar GazeTracker (cámara no disponible).');
      await this.stopTracking();
      return false;
    }

    // 3. Iniciar GazeOverlay en la ventana actual
    if (!this.overlay) {
      this.overlay = new GazeOverlay({
        dwellTime: this.currentProfile?.dwellTime || 1000,
        dwellRadius: this.currentProfile?.dwellRadius || 32,
        cooldown: 500
      });
    }

    this.bus.broadcast('gaze-status', { status: 'active', calibrated: true });
    return true;
  }

  /**
   * Detiene el tracking, libera inmediatamente la cámara y retira los overlays
   */
  public async stopTracking(): Promise<void> {
    this.isEnabled = false;
    this.updateStatus('inactive');

    // 1. Persistir configuración
    this.persistSettings({
      enableGazeNavigation: false
    });

    // 2. Detener y liberar la cámara web física (apagar LED)
    if (this.tracker) {
      this.tracker.stop();
      this.tracker = null;
    }

    // 3. Eliminar overlays inyectados del DOM
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }

    this.bus.broadcast('gaze-status', { status: 'inactive' });
  }

  /**
   * Aplica un nuevo perfil de calibración guardado
   */
  public async applyCalibrationProfile(profile: any): Promise<void> {
    this.currentProfile = { ...this.currentProfile, ...profile };
    this.isCalibrated = true;
    this.isEnabled = true;

    // Persistir en disco
    await this.persistSettings({
      enableGazeNavigation: true,
      gazeCalibrated: true,
      gazeProfile: this.currentProfile
    });

    // Si ya estaba corriendo el tracker, actualizar su modelo y filtros
    if (this.tracker) {
      if (profile.calibrationModel) {
        this.tracker.setCalibrationModel(new CalibrationModel(profile.calibrationModel));
      }
      this.tracker.updateConfig({
        sensitivityX: profile.sensitivityX,
        sensitivityY: profile.sensitivityY,
        deadzone: profile.deadzone,
        earThreshold: profile.earThreshold,
        blinkClickEnabled: profile.blinkClickEnabled
      });
    }

    if (this.overlay) {
      this.overlay.updateConfig({
        dwellTime: profile.dwellTime,
        dwellRadius: profile.dwellRadius
      });
    }

    // Asegurar que la ventana de calibración cerró y liberó el hardware en Windows
    await new Promise(r => setTimeout(r, 400));
    await this.startTracking();
  }

  private handleToolbarClick(): void {
    if (this.status === 'inactive') {
      if (!this.isCalibrated) {
        this.openCalibration();
      } else {
        this.startTracking();
      }
    } else if (this.status === 'calibrating') {
      this.openCalibration();
    } else {
      // Activo -> Desactivar limpiamente
      this.stopTracking();
    }
  }

  private updateStatus(newStatus: GazeStatus): void {
    this.status = newStatus;
    this.updateToolbarUi();
  }

  private updateToolbarUi(): void {
    if (!this.toolbarBtn) {
      this.toolbarBtn = document.getElementById('btn-gaze-toolbar');
    }
    if (!this.toolbarBtn) return;

    this.toolbarBtn.classList.remove('gaze-inactive', 'gaze-calibrating', 'gaze-active');

    let titleText = 'Navegación Visual (Mirada = Cursor) — Inactivo';
    let dotColor = '#94a3b8'; // Gris

    if (this.status === 'active') {
      this.toolbarBtn.classList.add('gaze-active');
      titleText = 'Navegación Visual (Mirada = Cursor) — Activo (60 FPS)';
      dotColor = '#22c55e'; // Verde
    } else if (this.status === 'calibrating') {
      this.toolbarBtn.classList.add('gaze-calibrating');
      titleText = 'Navegación Visual — Calibrando o requiere calibración';
      dotColor = '#f59e0b'; // Amarillo
    } else {
      this.toolbarBtn.classList.add('gaze-inactive');
    }

    this.toolbarBtn.title = titleText;

    const badge = this.toolbarBtn.querySelector('.gaze-status-dot') as HTMLElement;
    if (badge) {
      badge.style.backgroundColor = dotColor;
    }
  }

  private bindBusEvents(): void {
    // Escuchar solicitudes de calibración completada
    this.bus.on('calibration-completed', (data: any) => {
      if (data && data.profile) {
        this.applyCalibrationProfile(data.profile);
      }
    });

    this.bus.on('gaze-calibration-closed', () => {
      if (!this.isEnabled) {
        this.updateStatus('inactive');
      }
    });

    this.bus.on('gaze-toggle', (data: any) => {
      this.toggle(data?.enabled);
    });
  }

  private async persistSettings(partial: any): Promise<void> {
    try {
      const api = (window as any).betaAPI;
      if (api?.settings?.update) {
        await api.settings.update(partial);
      }
    } catch (err) {
      console.warn('[GazeManager] Error guardando ajustes persistentes:', err);
    }
  }

  public getStatus(): GazeStatus {
    return this.status;
  }

  public isTrackingActive(): boolean {
    return this.status === 'active';
  }

  public getProfile(): any {
    return this.currentProfile;
  }
}

export const gazeManager = GazeManager.getInstance();
