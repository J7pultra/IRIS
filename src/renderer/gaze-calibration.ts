/**
 * gaze-calibration.ts
 *
 * Lógica del Asistente Inmersivo de Calibración Visual (Estilo AMD Privacy View / Eyeware Beam).
 * Maneja las 3 etapas secuenciales:
 *   Etapa A: Postura y Detección de Rostro
 *   Etapa B: Matriz de Calibración Activa de 9 Puntos
 *   Etapa C: Ajustes Finos de Sensibilidad y Zona Muerta
 */

const CalibrationModelRef = (window as any).CalibrationModel;
const GazeTrackerRef = (window as any).GazeTracker;
const GazeOverlayRef = (window as any).GazeOverlay;
const AccessibilityEventBusRef = (window as any).AccessibilityEventBus;

class CalibrationWizard {
  private tracker: any = null;
  private overlay: any = null;
  private calibrationModel: any;
  private collectedSamples: any[] = [];

  // Puntos de la matriz de calibración: El Punto 1 es el Centro para registrar la línea base de fijación natural
  private readonly POINTS = [
    { xRatio: 0.50, yRatio: 0.50, name: 'Punto Central (Línea Base 1/9)' },
    { xRatio: 0.50, yRatio: 0.12, name: 'Superior Centro (2/9)' },
    { xRatio: 0.88, yRatio: 0.12, name: 'Superior Derecha (3/9)' },
    { xRatio: 0.88, yRatio: 0.50, name: 'Centro Derecha (4/9)' },
    { xRatio: 0.88, yRatio: 0.88, name: 'Inferior Derecha (5/9)' },
    { xRatio: 0.50, yRatio: 0.88, name: 'Inferior Centro (6/9)' },
    { xRatio: 0.12, yRatio: 0.88, name: 'Inferior Izquierda (7/9)' },
    { xRatio: 0.12, yRatio: 0.50, name: 'Centro Izquierda (8/9)' },
    { xRatio: 0.12, yRatio: 0.12, name: 'Superior Izquierda (9/9)' }
  ];

  private currentPointIndex: number = 0;
  private pointRafId: number | null = null;
  private isPointTransitioning: boolean = false;
  private activePointLockHandler: ((e: MouseEvent) => void) | null = null;
  private stageBKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private baselineGaze: { eyeX: number; eyeY: number } | null = null;
  private isHospitalMode: boolean = false;

  // Ajustes en tiempo real
  private sensitivityX: number = 1.0;
  private sensitivityY: number = 1.0;
  private deadzone: number = 18;
  private dwellTime: number = 1000;
  private blinkClickEnabled: boolean = true;
  private soundChimeEnabled: boolean = true;

  // Contadores del minijuego
  private buttonClicks: number[] = [0, 0, 0, 0];

  // Selección de Cámara
  private selectedDeviceId: string | null = null;
  private selectedDeviceLabel: string = '';
  private postureMonitoringActive: boolean = false;

  constructor() {
    const CalibClass = (window as any).CalibrationModel || CalibrationModelRef;
    this.calibrationModel = new CalibClass();
    this.init();
  }

  private async init(): Promise<void> {
    this.bindDomElements();
    await this.startStageA();
  }

  private bindDomElements(): void {
    // Botón de cerrar
    const btnClose = document.getElementById('btn-close-wizard');
    if (btnClose) {
      btnClose.onclick = () => this.cancelAndClose();
    }

    // Botón iniciar matriz
    const btnStart = document.getElementById('btn-start-matrix');
    if (btnStart) {
      btnStart.onclick = () => this.startStageB();
    }

    // Selector de Modo (Estándar vs Clínico/Hospital)
    const btnStd = document.getElementById('btn-mode-standard');
    const btnHosp = document.getElementById('btn-mode-hospital');
    if (btnStd && btnHosp) {
      btnStd.onclick = () => {
        this.isHospitalMode = false;
        btnStd.classList.add('active');
        btnHosp.classList.remove('active');
        const sub = document.getElementById('posture-subtitle');
        if (sub) sub.textContent = 'Ubícate frente a la pantalla a una distancia de 45 a 80 cm en posición estándar.';
      };
      btnHosp.onclick = () => {
        this.isHospitalMode = true;
        btnHosp.classList.add('active');
        btnStd.classList.remove('active');
        const sub = document.getElementById('posture-subtitle');
        if (sub) sub.textContent = 'Modo Clínico activado: adaptado para personas en cama o recostadas (distancia de 35 a 150 cm) con compensación de inclinación de cabeza.';
      };
    }

    // Selector de Cámara y Reintento
    const selCamera = document.getElementById('sel-camera-device') as HTMLSelectElement;
    if (selCamera) {
      selCamera.onchange = async () => {
        const newId = selCamera.value;
        if (newId && newId !== this.selectedDeviceId) {
          await this.switchCamera(newId);
        }
      };
    }

    const btnRefreshCam = document.getElementById('btn-refresh-cameras');
    if (btnRefreshCam) {
      btnRefreshCam.onclick = async () => {
        await this.populateCameraDropdown();
      };
    }

    const btnRetryCam = document.getElementById('btn-retry-camera');
    if (btnRetryCam) {
      btnRetryCam.onclick = async () => {
        await this.startStageA(this.selectedDeviceId || undefined);
      };
    }

    // Sliders de Etapa C
    const rngSensX = document.getElementById('rng-sens-x') as HTMLInputElement;
    const rngSensY = document.getElementById('rng-sens-y') as HTMLInputElement;
    const rngDeadzone = document.getElementById('rng-deadzone') as HTMLInputElement;
    const rngDwell = document.getElementById('rng-dwell') as HTMLInputElement;
    const chkBlink = document.getElementById('chk-blink-click') as HTMLInputElement;
    const chkSound = document.getElementById('chk-sound-chime') as HTMLInputElement;

    if (rngSensX) {
      rngSensX.oninput = () => {
        this.sensitivityX = parseFloat(rngSensX.value);
        document.getElementById('lbl-sens-x')!.textContent = `${this.sensitivityX.toFixed(1)}x`;
        this.updateStageCLiveConfig();
      };
    }

    if (rngSensY) {
      rngSensY.oninput = () => {
        this.sensitivityY = parseFloat(rngSensY.value);
        document.getElementById('lbl-sens-y')!.textContent = `${this.sensitivityY.toFixed(1)}x`;
        this.updateStageCLiveConfig();
      };
    }

    if (rngDeadzone) {
      rngDeadzone.oninput = () => {
        this.deadzone = parseInt(rngDeadzone.value, 10);
        document.getElementById('lbl-deadzone')!.textContent = `${this.deadzone} px`;
        this.updateStageCLiveConfig();
      };
    }

    if (rngDwell) {
      rngDwell.oninput = () => {
        this.dwellTime = parseInt(rngDwell.value, 10);
        document.getElementById('lbl-dwell')!.textContent = `${this.dwellTime} ms`;
        this.updateStageCLiveConfig();
      };
    }

    if (chkBlink) {
      chkBlink.onchange = () => {
        this.blinkClickEnabled = chkBlink.checked;
        this.updateStageCLiveConfig();
      };
    }

    if (chkSound) {
      chkSound.onchange = () => {
        this.soundChimeEnabled = chkSound.checked;
      };
    }

    // Botones de acción final
    const btnRecalib = document.getElementById('btn-recalibrate');
    if (btnRecalib) {
      btnRecalib.onclick = () => this.startStageB();
    }

    const btnSave = document.getElementById('btn-save-start');
    if (btnSave) {
      btnSave.onclick = () => this.saveAndFinish();
    }

    // Botones de prueba interactiva
    [1, 2, 3, 4].forEach(i => {
      const btn = document.getElementById(`test-btn-${i}`);
      if (btn) {
        btn.onclick = () => this.handleTestButtonClick(i - 1);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ETAPA A: POSTURA Y ALINEACIÓN DE ROSTRO CON SELECTOR DE CÁMARA
  // ══════════════════════════════════════════════════════════════════════════
  private async startStageA(preferredDeviceId?: string): Promise<void> {
    this.showStage('stage-a');
    this.updateStepper(1);

    this.postureMonitoringActive = false;

    if (this.tracker) {
      this.tracker.stop();
      this.tracker = null;
    }

    const valCentered = document.getElementById('val-centered');
    const valDist = document.getElementById('val-distance');
    const valLight = document.getElementById('val-lighting');
    const cameraErrorBanner = document.getElementById('camera-error-banner');
    const cameraBox = document.getElementById('camera-box');
    const btnStart = document.getElementById('btn-start-matrix') as HTMLButtonElement;

    if (valCentered) valCentered.textContent = 'Iniciando cámara...';
    if (valDist) valDist.textContent = 'Midiendo...';
    if (valLight) valLight.textContent = 'Analizando...';
    if (btnStart) btnStart.disabled = true;

    // Iniciar GazeTracker
    const TrackerClass = (window as any).GazeTracker || GazeTrackerRef;
    this.tracker = new TrackerClass();
    const success = await this.tracker.start(preferredDeviceId || this.selectedDeviceId || undefined);

    this.selectedDeviceId = this.tracker.getCurrentDeviceId();
    this.selectedDeviceLabel = this.tracker.getCurrentDeviceLabel();

    // Actualizar menú desplegable de cámaras disponibles
    await this.populateCameraDropdown();

    const video = document.getElementById('preview-video') as HTMLVideoElement;
    const internalVideo = this.tracker.getVideoElement();

    if (success && video && internalVideo && internalVideo.srcObject) {
      video.srcObject = internalVideo.srcObject;
      video.play().catch(e => console.warn('[Calibration] Video play warning:', e));

      if (cameraErrorBanner) cameraErrorBanner.style.display = 'none';

      // Iniciar bucle de postura
      this.postureMonitoringActive = true;
      this.monitorPosture();
    } else {
      if (video) video.srcObject = null;
      if (valCentered) valCentered.textContent = 'Cámara no detectada';
      if (cameraErrorBanner) cameraErrorBanner.style.display = 'flex';
      if (cameraBox) {
        cameraBox.classList.remove('posture-ok', 'posture-warn');
        cameraBox.classList.add('posture-error');
      }
    }
  }

  private async switchCamera(newDeviceId: string): Promise<void> {
    console.log(`[CalibrationWizard] Cambiando a cámara: ${newDeviceId}`);
    this.selectedDeviceId = newDeviceId;
    await this.startStageA(newDeviceId);
  }

  private async populateCameraDropdown(): Promise<void> {
    const selCamera = document.getElementById('sel-camera-device') as HTMLSelectElement;
    if (!selCamera) return;

    try {
      const TrackerClass = (window as any).GazeTracker || GazeTrackerRef;
      const cameras = await TrackerClass.getAvailableCameras();

      selCamera.innerHTML = '';

      if (cameras.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No se encontraron cámaras';
        selCamera.appendChild(opt);
        return;
      }

      cameras.forEach((cam: { deviceId: string; label: string }, idx: number) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Cámara ${idx + 1}`;
        if (cam.deviceId === this.selectedDeviceId) {
          opt.selected = true;
        }
        selCamera.appendChild(opt);
      });

      if (!this.selectedDeviceId && cameras.length > 0) {
        this.selectedDeviceId = cameras[0].deviceId;
        selCamera.value = cameras[0].deviceId;
      } else if (this.selectedDeviceId) {
        selCamera.value = this.selectedDeviceId;
      }
    } catch (e) {
      console.warn('[CalibrationWizard] Error al poblar lista de cámaras:', e);
    }
  }

  private monitorPosture = (): void => {
    if (!this.postureMonitoringActive || !this.tracker) return;

    const posture = this.tracker.getPosture();
    const cameraBox = document.getElementById('camera-box');
    const dotCentered = document.getElementById('dot-centered');
    const valCentered = document.getElementById('val-centered');
    const dotDist = document.getElementById('dot-distance');
    const valDist = document.getElementById('val-distance');
    const dotLight = document.getElementById('dot-lighting');
    const valLight = document.getElementById('val-lighting');
    const btnStart = document.getElementById('btn-start-matrix') as HTMLButtonElement;

    // Centrado
    const isCenteredOk = posture.isCentered || (this.isHospitalMode && posture.isFaceDetected);
    if (isCenteredOk) {
      dotCentered?.classList.add('ok');
      valCentered!.textContent = this.isHospitalMode ? 'Encuadre asistido ✓' : 'Centrado ✓';
    } else {
      dotCentered?.classList.remove('ok');
      valCentered!.textContent = posture.isFaceDetected ? 'Ajusta tu centro' : 'Buscando rostro...';
    }

    // Distancia
    const distCm = posture.headDistanceCm;
    const isDistOk = this.isHospitalMode
      ? (distCm >= 30 && distCm <= 160)
      : (distCm >= 35 && distCm <= 100);

    if (isDistOk) {
      dotDist?.classList.add('ok');
      if (distCm > 75) {
        valDist!.textContent = `${distCm} cm ✓ Modo Asistido`;
      } else {
        valDist!.textContent = `${distCm} cm ✓ Óptima`;
      }
    } else {
      dotDist?.classList.remove('ok');
      valDist!.textContent = distCm > 160 ? `${distCm} cm (Muy lejos)` : `${distCm} cm (Muy cerca)`;
    }

    // Iluminación
    if (posture.isLightingGood) {
      dotLight?.classList.add('ok');
      valLight!.textContent = 'Buena luz ✓';
    } else {
      dotLight?.classList.remove('ok');
      valLight!.textContent = 'Poca iluminación';
    }

    // Estado visual del recuadro de cámara
    if (cameraBox) {
      cameraBox.classList.remove('posture-ok', 'posture-warn', 'posture-error');
      if (posture.isFaceDetected && (isDistOk || posture.readyForCalibration)) {
        cameraBox.classList.add('posture-ok');
      } else if (posture.isFaceDetected) {
        cameraBox.classList.add('posture-warn');
      } else {
        cameraBox.classList.add('posture-error');
      }
    }

    // Habilitar botón de siguiente paso (no bloquear a usuarios recostados o en cama)
    if (btnStart) {
      btnStart.disabled = !posture.isFaceDetected;
    }

    if (this.postureMonitoringActive) {
      requestAnimationFrame(this.monitorPosture);
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ETAPA B: MATRIZ DE CALIBRACIÓN ACTIVA (9 PUNTOS)
  // ══════════════════════════════════════════════════════════════════════════
  private startStageB(): void {
    this.showStage('stage-b');
    this.updateStepper(2);
    this.collectedSamples = [];
    this.currentPointIndex = 0;
    this.isPointTransitioning = false;

    // Permitir confirmación manual inmediata mediante tecla Espacio o Enter
    this.setupStageBKeyboard();

    this.presentCalibrationPoint(0);
  }

  private setupStageBKeyboard(): void {
    if (this.stageBKeydownHandler) {
      window.removeEventListener('keydown', this.stageBKeydownHandler);
    }
    this.stageBKeydownHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.code === 'Enter') {
        e.preventDefault();
        if (!this.isPointTransitioning && this.currentPointIndex < this.POINTS.length) {
          this.lockCurrentPoint(this.currentPointIndex, true);
        }
      }
    };
    window.addEventListener('keydown', this.stageBKeydownHandler);
  }

  private presentCalibrationPoint(index: number): void {
    if (index >= this.POINTS.length) {
      // Todos los 9 puntos han sido calibrados
      this.finishStageB();
      return;
    }

    if (this.pointRafId !== null) {
      cancelAnimationFrame(this.pointRafId);
      this.pointRafId = null;
    }

    this.currentPointIndex = index;
    const pt = this.POINTS[index];

    const pointEl = document.getElementById('active-point');
    const counterEl = document.getElementById('point-counter');
    const ringEl = document.getElementById('matrix-progress-ring') as any;
    const closingRingEl = document.getElementById('point-closing-ring');
    const gazeDotEl = document.getElementById('calib-gaze-dot');
    const statusEl = document.getElementById('calib-gaze-status');

    if (counterEl) {
      counterEl.textContent = `${pt.name} (${index + 1}/9)`;
    }

    if (pointEl) {
      pointEl.style.left = `${pt.xRatio * 100}%`;
      pointEl.style.top = `${pt.yRatio * 100}%`;
      pointEl.className = 'calib-point waiting';

      // Soporte estilo Eyeware Beam: clic en el objetivo para fijar manualmente de inmediato
      if (this.activePointLockHandler) {
        pointEl.removeEventListener('click', this.activePointLockHandler);
      }
      this.activePointLockHandler = (e: MouseEvent) => {
        e.stopPropagation();
        if (!this.isPointTransitioning) {
          this.lockCurrentPoint(index, true);
        }
      };
      pointEl.addEventListener('click', this.activePointLockHandler);
    }

    if (closingRingEl) {
      closingRingEl.style.transform = 'scale(1.7)';
    }

    if (ringEl) {
      ringEl.style.strokeDashoffset = '175.9';
    }

    if (gazeDotEl) {
      gazeDotEl.className = 'gaze-dot-indicator waiting';
    }

    if (statusEl) {
      statusEl.textContent = 'Enfoca la mirada en el círculo...';
    }

    // Pequeño retardo de asentamiento ocular (250ms) antes de iniciar bucle de detección
    setTimeout(() => {
      if (this.currentPointIndex === index && !this.isPointTransitioning) {
        this.runGazeCalibrationLoop(index);
      }
    }, 250);
  }

  /**
   * Bucle de calibración activa guiada por mirada (Estilo AMD Privacy View / Eyeware Beam):
   * El círculo exterior se contrae progresivamente hacia el centro SOLAMENTE cuando los ojos
   * del usuario están estables, abiertos y dirigidos al punto objetivo.
   * Si el usuario desvía la mirada o parpadea, el círculo se expande y el progreso se drena.
   */
  private runGazeCalibrationLoop(pointIdx: number): void {
    const pointEl = document.getElementById('active-point');
    const closingRingEl = document.getElementById('point-closing-ring');
    const ringEl = document.getElementById('matrix-progress-ring') as any;
    const gazeDotEl = document.getElementById('calib-gaze-dot');
    const statusEl = document.getElementById('calib-gaze-status');

    let chargeProgress = 0.0;
    const pointSamples: { eyeX: number; eyeY: number }[] = [];
    let lastTime = performance.now();
    const target = this.POINTS[pointIdx];

    const step = (now: number) => {
      if (this.currentPointIndex !== pointIdx || this.isPointTransitioning) {
        return;
      }

      const dt = Math.min(now - lastTime, 100);
      lastTime = now;

      const frame = this.tracker ? this.tracker.getLatestFrameData() : null;
      const posture = frame?.posture || (this.tracker ? this.tracker.getPosture() : null);

      // 1. Validar detección de rostro
      if (!posture || !posture.isFaceDetected || !frame) {
        chargeProgress = Math.max(0, chargeProgress - dt / 350);
        this.updatePointVisuals(pointEl, closingRingEl, ringEl, gazeDotEl, statusEl, chargeProgress, 'lost', 'Rostro u ojos no detectados — Alinéate');
        this.pointRafId = requestAnimationFrame(step);
        return;
      }

      // 2. Validar ojos abiertos (no parpadeo cerrado)
      if (frame.isBlinking || (frame.ear !== undefined && frame.ear < 0.20)) {
        chargeProgress = Math.max(0, chargeProgress - dt / 850);
        this.updatePointVisuals(pointEl, closingRingEl, ringEl, gazeDotEl, statusEl, chargeProgress, 'waiting', 'Ojos cerrados / Parpadeo detectado...');
        this.pointRafId = requestAnimationFrame(step);
        return;
      }

      // 3. Evaluar fijación y coherencia direccional con el objetivo (AMD Privacy View)
      const isLookingAtTarget = this.evaluateGazeTargetCoherence(frame, target);

      if (isLookingAtTarget) {
        // Mirada fijada coherentemente en el objetivo: CONTRAER CÍRCULO Y LLENAR PROGRESO
        chargeProgress = Math.min(1.0, chargeProgress + dt / 880); // ~880ms de fijación sostenida
        pointSamples.push({ eyeX: frame.rawEyeX, eyeY: frame.rawEyeY });
        if (pointSamples.length > 50) {
          pointSamples.shift();
        }

        const percent = Math.round(chargeProgress * 100);
        this.updatePointVisuals(pointEl, closingRingEl, ringEl, gazeDotEl, statusEl, chargeProgress, 'focusing', `Fijando mirada... (${percent}%)`);
      } else {
        // Desvío de mirada o sacada brusca: DRENAR Y EXPANDIR CÍRCULO
        chargeProgress = Math.max(0, chargeProgress - dt / 450);
        this.updatePointVisuals(pointEl, closingRingEl, ringEl, gazeDotEl, statusEl, chargeProgress, 'waiting', 'Mirando hacia otro lado — Enfoca el centro');
      }

      // 4. ¿Completado al 100%?
      if (chargeProgress >= 1.0) {
        this.lockCurrentPoint(pointIdx, false, pointSamples);
        return;
      }

      this.pointRafId = requestAnimationFrame(step);
    };

    this.pointRafId = requestAnimationFrame(step);
  }

  /**
   * Evalúa la coherencia de cuadrante y estabilidad ocular del frame actual con respecto al objetivo.
   */
  private evaluateGazeTargetCoherence(frame: any, target: { xRatio: number; yRatio: number }): boolean {
    if (!frame) return false;

    // 1. Debe haber rostro detectado y ojos abiertos (descartar parpadeo o cierre ocular)
    if (!frame.posture?.isFaceDetected || frame.isBlinking || (frame.ear !== undefined && frame.ear < 0.20)) {
      return false;
    }

    // 2. Descartar sacadas bruscas o movimientos oculares rápidos
    if (frame.velocity !== undefined && frame.velocity > 1400) {
      return false;
    }

    const rawEyeX = frame.rawEyeX;
    const rawEyeY = frame.rawEyeY;
    if (typeof rawEyeX !== 'number' || typeof rawEyeY !== 'number') return false;

    const targetDX = target.xRatio - 0.5;
    const targetDY = target.yRatio - 0.5;
    const eyeDX = rawEyeX - 0.5;
    const eyeDY = rawEyeY - 0.5;

    // Validación Horizontal:
    // Si el punto está a la izquierda (targetDX < -0.2), los ojos DEBEN orientarse hacia la izquierda
    if (targetDX < -0.2) {
      if (eyeDX > -0.012) return false; // Si mira al centro o a la derecha, rechazar
    } else if (targetDX > 0.2) {
      // Si el punto está a la derecha (targetDX > 0.2), los ojos DEBEN orientarse hacia la derecha
      if (eyeDX < 0.012) return false; // Si mira al centro o a la izquierda, rechazar
    } else {
      // Columna central (|targetDX| <= 0.2): ojos no deben estar en extremos laterales
      if (Math.abs(eyeDX) > 0.12) return false;
    }

    // Validación Vertical:
    // Si el punto está arriba (targetDY < -0.2), los ojos DEBEN orientarse hacia arriba
    if (targetDY < -0.2) {
      if (eyeDY > -0.012) return false;
    } else if (targetDY > 0.2) {
      // Si el punto está abajo (targetDY > 0.2), los ojos DEBEN orientarse hacia abajo
      if (eyeDY < 0.012) return false;
    } else {
      // Fila central (|targetDY| <= 0.2): ojos no deben estar en extremos verticales
      if (Math.abs(eyeDY) > 0.12) return false;
    }

    return true;
  }

  private updatePointVisuals(
    pointEl: HTMLElement | null,
    closingRingEl: HTMLElement | null,
    ringEl: any,
    gazeDotEl: HTMLElement | null,
    statusEl: HTMLElement | null,
    progress: number,
    state: 'focusing' | 'waiting' | 'lost',
    statusText: string
  ): void {
    if (pointEl && !pointEl.classList.contains('locked')) {
      pointEl.className = `calib-point ${state}`;
    }

    if (closingRingEl) {
      // El anillo exterior se contrae desde scale 1.70 hasta scale 0.72 conforme se fija la mirada
      const scale = Math.max(0.72, 1.70 - (progress * 0.98));
      closingRingEl.style.transform = `scale(${scale.toFixed(3)})`;
    }

    if (ringEl) {
      const circumference = 175.9;
      ringEl.style.strokeDashoffset = `${(circumference * (1.0 - progress)).toFixed(1)}`;
    }

    if (gazeDotEl) {
      gazeDotEl.className = `gaze-dot-indicator ${state}`;
    }

    if (statusEl) {
      statusEl.textContent = statusText;
    }
  }

  private lockCurrentPoint(pointIdx: number, isManual: boolean, samples?: { eyeX: number; eyeY: number }[]): void {
    if (this.isPointTransitioning || this.currentPointIndex !== pointIdx) {
      return;
    }
    this.isPointTransitioning = true;

    if (this.pointRafId !== null) {
      cancelAnimationFrame(this.pointRafId);
      this.pointRafId = null;
    }

    const pointEl = document.getElementById('active-point');
    const ringEl = document.getElementById('matrix-progress-ring') as any;
    const closingRingEl = document.getElementById('point-closing-ring');
    const gazeDotEl = document.getElementById('calib-gaze-dot');
    const statusEl = document.getElementById('calib-gaze-status');

    if (this.activePointLockHandler && pointEl) {
      pointEl.removeEventListener('click', this.activePointLockHandler);
      this.activePointLockHandler = null;
    }

    if (this.soundChimeEnabled) {
      this.playConfirmationChime();
    }

    if (pointEl) {
      pointEl.className = 'calib-point locked burst';
    }
    if (closingRingEl) {
      closingRingEl.style.transform = 'scale(0.72)';
    }
    if (ringEl) {
      ringEl.style.strokeDashoffset = '0';
    }
    if (gazeDotEl) {
      gazeDotEl.className = 'gaze-dot-indicator locked';
    }
    if (statusEl) {
      statusEl.textContent = isManual
        ? `¡Punto ${pointIdx + 1} Confirmado Manualmente!`
        : `¡Punto ${pointIdx + 1} Calibrado!`;
    }

    const target = this.POINTS[pointIdx];
    let avgEyeX: number;
    let avgEyeY: number;

    if (samples && samples.length > 0) {
      // Tomar los samples capturados durante el cierre del anillo
      const recentSamples = samples.slice(-25);
      avgEyeX = recentSamples.reduce((sum, s) => sum + s.eyeX, 0) / recentSamples.length;
      avgEyeY = recentSamples.reduce((sum, s) => sum + s.eyeY, 0) / recentSamples.length;
    } else {
      const frame = this.tracker ? this.tracker.getLatestFrameData() : null;
      if (frame && frame.rawEyeX !== undefined && frame.rawEyeY !== undefined) {
        avgEyeX = frame.rawEyeX;
        avgEyeY = frame.rawEyeY;
      } else {
        avgEyeX = 0.5 + (target.xRatio - 0.5) * 0.45;
        avgEyeY = 0.5 + (target.yRatio - 0.5) * 0.45;
      }
    }

    const screenX = target.xRatio * window.innerWidth;
    const screenY = target.yRatio * window.innerHeight;

    this.collectedSamples.push({
      eyeX: avgEyeX,
      eyeY: avgEyeY,
      screenX,
      screenY
    });

    // Avanzar suavemente al siguiente punto tras apreciar la animación de éxito
    setTimeout(() => {
      this.isPointTransitioning = false;
      this.presentCalibrationPoint(pointIdx + 1);
    }, 280);
  }

  private finishStageB(): void {
    if (this.stageBKeydownHandler) {
      window.removeEventListener('keydown', this.stageBKeydownHandler);
      this.stageBKeydownHandler = null;
    }

    // Ajustar modelo polinomial
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    this.calibrationModel.fit(this.collectedSamples, screenW, screenH);

    if (this.tracker) {
      this.tracker.setCalibrationModel(this.calibrationModel);
    }

    // Pasar a Etapa C
    this.startStageC();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ETAPA C: AJUSTES FINOS & MINIJUEGO DE PRUEBA
  // ══════════════════════════════════════════════════════════════════════════
  private startStageC(): void {
    this.showStage('stage-c');
    this.updateStepper(3);

    // Iniciar GazeOverlay en la pantalla de prueba
    if (!this.overlay) {
      const OverlayClass = (window as any).GazeOverlay || GazeOverlayRef;
      this.overlay = new OverlayClass({
        dwellTime: this.dwellTime,
        dwellRadius: this.deadzone + 12
      });
    }

    this.updateStageCLiveConfig();
  }

  private updateStageCLiveConfig(): void {
    if (this.tracker) {
      this.tracker.updateConfig({
        sensitivityX: this.sensitivityX,
        sensitivityY: this.sensitivityY,
        deadzone: this.deadzone,
        blinkClickEnabled: this.blinkClickEnabled
      });
    }

    if (this.overlay) {
      this.overlay.updateConfig({
        dwellTime: this.dwellTime,
        dwellRadius: this.deadzone + 12
      });
    }
  }

  private handleTestButtonClick(index: number): void {
    this.buttonClicks[index]++;
    const cntEl = document.getElementById(`test-cnt-${index + 1}`);
    const btnEl = document.getElementById(`test-btn-${index + 1}`);

    if (cntEl) {
      cntEl.textContent = `${this.buttonClicks[index]} clics ✓`;
    }

    if (btnEl) {
      btnEl.classList.add('clicked');
      setTimeout(() => btnEl.classList.remove('clicked'), 300);
    }

    if (this.soundChimeEnabled) {
      this.playConfirmationChime();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FINALIZACIÓN Y GUARDADO
  // ══════════════════════════════════════════════════════════════════════════
  private async saveAndFinish(): Promise<void> {
    const profile = {
      sensitivityX: this.sensitivityX,
      sensitivityY: this.sensitivityY,
      deadzone: this.deadzone,
      dwellTime: this.dwellTime,
      dwellRadius: this.deadzone + 12,
      blinkClickEnabled: this.blinkClickEnabled,
      soundFeedbackEnabled: this.soundChimeEnabled,
      earThreshold: 0.20,
      cameraId: this.selectedDeviceId || undefined,
      cameraLabel: this.selectedDeviceLabel || undefined,
      calibrationModel: this.calibrationModel.getModelData()
    };

    try {
      const api = (window as any).betaAPI;
      if (api?.settings?.update) {
        await api.settings.update({
          enableGazeNavigation: true,
          gazeCalibrated: true,
          gazeProfile: profile
        });
      }

      // 1. Detener primero el tracking y apagar la cámara en la ventana de calibración
      this.cleanup();

      // 2. Dar 350ms a Windows para que el controlador de la cámara libere el hardware
      await new Promise(r => setTimeout(r, 350));

      // 3. Difundir evento de calibración completa
      const BusClass = (window as any).AccessibilityEventBus || AccessibilityEventBusRef;
      const bus = BusClass.getInstance();
      bus.broadcast('calibration-completed', { profile });

      // 4. Cerrar ventana de calibración
      if (api?.gaze?.closeCalibration) {
        await api.gaze.closeCalibration();
      } else {
        window.close();
      }
    } catch (err) {
      console.error('[CalibrationWizard] Error al guardar perfil:', err);
    }
  }

  private cancelAndClose(): void {
    this.cleanup();
    try {
      const api = (window as any).betaAPI;
      if (api?.gaze?.closeCalibration) {
        api.gaze.closeCalibration();
      } else {
        window.close();
      }
    } catch {}
  }

  private cleanup(): void {
    this.postureMonitoringActive = false;
    if (this.pointRafId !== null) {
      cancelAnimationFrame(this.pointRafId);
      this.pointRafId = null;
    }
    if (this.stageBKeydownHandler) {
      window.removeEventListener('keydown', this.stageBKeydownHandler);
      this.stageBKeydownHandler = null;
    }
    const video = document.getElementById('preview-video') as HTMLVideoElement;
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch {}
    }
    if (this.tracker) {
      this.tracker.stop();
      this.tracker = null;
    }
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }
  }

  private showStage(stageId: string): void {
    document.querySelectorAll('.stage-view').forEach(s => s.classList.remove('active'));
    document.getElementById(stageId)?.classList.add('active');
  }

  private updateStepper(step: number): void {
    const s1 = document.getElementById('step-nav-1');
    const s2 = document.getElementById('step-nav-2');
    const s3 = document.getElementById('step-nav-3');

    s1?.classList.remove('active', 'completed');
    s2?.classList.remove('active', 'completed');
    s3?.classList.remove('active', 'completed');

    if (step === 1) {
      s1?.classList.add('active');
    } else if (step === 2) {
      s1?.classList.add('completed');
      s2?.classList.add('active');
    } else if (step === 3) {
      s1?.classList.add('completed');
      s2?.classList.add('completed');
      s3?.classList.add('active');
    }
  }

  private playConfirmationChime(): void {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.1); // G5

      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.19);
    } catch {}
  }
}

// Inicializar cuando el DOM esté listo
window.addEventListener('DOMContentLoaded', () => {
  new CalibrationWizard();
});
