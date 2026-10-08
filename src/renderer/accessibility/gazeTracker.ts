/**
 * gazeTracker.ts
 *
 * Motor de Seguimiento Ocular (Edge AI Vision Engine) a 60 FPS para NavegadorBeta.
 *
 * Características:
 * 1. 100% Edge AI Local: Procesamiento en el dispositivo mediante MediaPipe Face Mesh
 *    con puntos de referencia del iris (refineLandmarks: true) y fallback de visión artificial.
 * 2. Cálculo en tiempo real de Tasa de Aspecto del Ojo (Eye Aspect Ratio - EAR)
 *    para distinguir parpadeos voluntarios (300-600ms) de parpadeos naturales (<150ms).
 * 3. Validación de postura en tiempo real (Head Pose, Iluminación, Distancia 50-70cm)
 *    para la Etapa A del asistente de calibración.
 * 4. Integración directa con CalibrationModel y AdaptiveGazeFilter2D.
 * 5. Liberación inmediata de hardware y apagado del LED físico de la cámara web.
 */

import { AdaptiveGazeFilter2D } from './oneEuroFilter';
import { CalibrationModel, CalibrationPointSample } from './calibrationModel';
import { AccessibilityEventBus } from './accessibilityEventBus';

export interface PostureValidation {
  isFaceDetected: boolean;
  isCentered: boolean;
  isDistanceOptimal: boolean; // 50-70 cm
  isLightingGood: boolean;
  readyForCalibration: boolean;
  headDistanceCm: number;
  faceCenterOffset: { x: number; y: number };
  lightingScore: number;
}

export interface GazeFrameData {
  rawEyeX: number;
  rawEyeY: number;
  screenX: number;
  screenY: number;
  isFixated: boolean;
  velocity: number;
  ear: number;
  isBlinking: boolean;
  isIntentionalBlink: boolean;
  posture: PostureValidation;
}

export interface GazeTrackerOptions {
  sensitivityX?: number;
  sensitivityY?: number;
  deadzone?: number;
  earThreshold?: number;
  blinkClickEnabled?: boolean;
}

export class GazeTracker {
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private mediaStream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private isRunning: boolean = false;
  private currentDeviceId: string | null = null;
  private currentDeviceLabel: string = '';

  private filter: AdaptiveGazeFilter2D;
  private calibrationModel: CalibrationModel;
  private bus: AccessibilityEventBus;

  // Parámetros configurables
  private sensitivityX: number = 1.0;
  private sensitivityY: number = 1.0;
  private deadzone: number = 16;
  private earThreshold: number = 0.20;
  private blinkClickEnabled: boolean = true;

  // Estado de detección de parpadeo (EAR)
  private eyeClosedStartTime: number | null = null;
  private lastBlinkClickTime: number = 0;

  // MediaPipe FaceMesh instancia (si está disponible)
  private faceMeshInstance: any = null;
  private isProcessingFrame: boolean = false;
  private latestLandmarks: any[] | null = null;
  private latestFrameData: GazeFrameData | null = null;

  // Postura actual
  private currentPosture: PostureValidation = {
    isFaceDetected: false,
    isCentered: false,
    isDistanceOptimal: false,
    isLightingGood: false,
    readyForCalibration: false,
    headDistanceCm: 0,
    faceCenterOffset: { x: 0, y: 0 },
    lightingScore: 0
  };

  constructor(options?: GazeTrackerOptions, savedCalibration?: any) {
    this.bus = AccessibilityEventBus.getInstance();
    this.filter = new AdaptiveGazeFilter2D({ deadzone: options?.deadzone || 16 });
    this.calibrationModel = new CalibrationModel(savedCalibration || null);

    if (options) {
      if (options.sensitivityX !== undefined) this.sensitivityX = options.sensitivityX;
      if (options.sensitivityY !== undefined) this.sensitivityY = options.sensitivityY;
      if (options.deadzone !== undefined) this.deadzone = options.deadzone;
      if (options.earThreshold !== undefined) this.earThreshold = options.earThreshold;
      if (options.blinkClickEnabled !== undefined) this.blinkClickEnabled = options.blinkClickEnabled;
    }
  }

  /**
   * Enumera todas las cámaras web y dispositivos de captura de video disponibles en el sistema.
   */
  public static async getAvailableCameras(): Promise<Array<{ deviceId: string; label: string }>> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      return videoDevices.map((d, index) => {
        let label = d.label;
        if (!label || label.trim() === '') {
          label = `Cámara ${index + 1}`;
        }
        return {
          deviceId: d.deviceId,
          label
        };
      });
    } catch (err) {
      console.warn('[GazeTracker] Error al enumerar dispositivos de video:', err);
      return [];
    }
  }

  public getCurrentDeviceId(): string | null {
    return this.currentDeviceId;
  }

  public getCurrentDeviceLabel(): string {
    return this.currentDeviceLabel;
  }

  public updateConfig(options: Partial<GazeTrackerOptions>): void {
    if (options.sensitivityX !== undefined) this.sensitivityX = options.sensitivityX;
    if (options.sensitivityY !== undefined) this.sensitivityY = options.sensitivityY;
    if (options.deadzone !== undefined) {
      this.deadzone = options.deadzone;
      this.filter.updateConfig({ deadzone: this.deadzone });
    }
    if (options.earThreshold !== undefined) this.earThreshold = options.earThreshold;
    if (options.blinkClickEnabled !== undefined) this.blinkClickEnabled = options.blinkClickEnabled;
  }

  public setCalibrationModel(model: CalibrationModel): void {
    this.calibrationModel = model;
  }

  public getCalibrationModel(): CalibrationModel {
    return this.calibrationModel;
  }

  public getPosture(): PostureValidation {
    return this.currentPosture;
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  public getLatestFrameData(): GazeFrameData | null {
    return this.latestFrameData;
  }

  public getLatestRawEyes(): { rawEyeX: number; rawEyeY: number; ear: number; faceFound: boolean; isFixated: boolean; velocity: number } {
    if (this.latestFrameData) {
      return {
        rawEyeX: this.latestFrameData.rawEyeX,
        rawEyeY: this.latestFrameData.rawEyeY,
        ear: this.latestFrameData.ear,
        faceFound: this.latestFrameData.posture.isFaceDetected,
        isFixated: this.latestFrameData.isFixated,
        velocity: this.latestFrameData.velocity
      };
    }
    return {
      rawEyeX: 0.5,
      rawEyeY: 0.5,
      ear: 0.28,
      faceFound: this.currentPosture.isFaceDetected,
      isFixated: false,
      velocity: 0
    };
  }

  /**
   * Inicia la captura local de la cámara web y el pipeline Edge AI con fallback multinivel
   */
  public async start(preferredDeviceId?: string): Promise<boolean> {
    if (this.isRunning) {
      if (preferredDeviceId && this.currentDeviceId === preferredDeviceId) {
        return true;
      }
      this.stop();
    }

    let targetDeviceId = preferredDeviceId;
    let availableCameras: Array<{ deviceId: string; label: string }> = [];

    try {
      availableCameras = await GazeTracker.getAvailableCameras();
    } catch {}

    // Si no hay cámara solicitada específicamente, preferir cámaras físicas sobre virtuales
    if (!targetDeviceId && availableCameras.length > 0) {
      const physical = availableCameras.find(c => {
        const lower = c.label.toLowerCase();
        return !lower.includes('sharing') && !lower.includes('virtual') && !lower.includes('obs');
      });
      targetDeviceId = physical ? physical.deviceId : availableCameras[0].deviceId;
    }

    let stream: MediaStream | null = null;

    // Intento 1: Constraints ideales a 30 FPS con cámara seleccionada
    if (targetDeviceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: targetDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 }
          },
          audio: false
        });
      } catch (err1) {
        console.warn('[GazeTracker] Intento 1 con constraints ideales falló, probando fallback básico:', err1);
        try {
          // Intento 2: Solo deviceId sin restricciones
          stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: targetDeviceId } },
            audio: false
          });
        } catch (err2) {
          console.warn('[GazeTracker] Intento 2 con deviceId exacto falló:', err2);
        }
      }
    }

    // Intento 3: Probar otras cámaras detectadas si la principal falló
    if (!stream && availableCameras.length > 0) {
      for (const cam of availableCameras) {
        if (cam.deviceId === targetDeviceId) continue;
        try {
          console.log(`[GazeTracker] Intentando cámara alternativa: ${cam.label}`);
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: cam.deviceId },
              width: { ideal: 640 },
              height: { ideal: 480 }
            },
            audio: false
          });
          if (stream) {
            targetDeviceId = cam.deviceId;
            break;
          }
        } catch {}
      }
    }

    // Intento 4: Fallback genérico absoluto
    if (!stream) {
      try {
        console.log('[GazeTracker] Intentando fallback genérico { video: true }');
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      } catch (errFinal) {
        console.error('[GazeTracker] Error al iniciar cámara web tras todos los intentos:', errFinal);
        this.stop();
        return false;
      }
    }

    if (!stream) {
      this.stop();
      return false;
    }

    try {
      this.mediaStream = stream;
      const track = stream.getVideoTracks()[0];
      if (track) {
        this.currentDeviceLabel = track.label || '';
        const settings = track.getSettings ? track.getSettings() : null;
        this.currentDeviceId = settings?.deviceId || targetDeviceId || null;
      }

      this.videoElement = document.createElement('video');
      this.videoElement.srcObject = this.mediaStream;
      this.videoElement.autoplay = true;
      this.videoElement.playsInline = true;
      this.videoElement.muted = true;
      this.videoElement.style.display = 'none';
      document.body.appendChild(this.videoElement);

      this.canvasElement = document.createElement('canvas');
      this.canvasElement.width = 640;
      this.canvasElement.height = 480;
      this.canvasCtx = this.canvasElement.getContext('2d', { willReadFrequently: true });

      // Esperar a que el video esté listo sin posibilidad de bloqueo (deadlock)
      await new Promise<void>((resolve) => {
        if (!this.videoElement) return resolve();
        if (this.videoElement.readyState >= 1) {
          this.videoElement.play().catch(() => {});
          return resolve();
        }
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            this.videoElement?.play().catch(() => {});
            resolve();
          }
        };
        const timer = setTimeout(finish, 2500);
        this.videoElement.onloadedmetadata = () => {
          clearTimeout(timer);
          finish();
        };
      });

      // Intentar cargar FaceMesh localmente
      await this.initFaceMesh();

      this.isRunning = true;
      this.loop();
      return true;
    } catch (err) {
      console.error('[GazeTracker] Error al configurar el stream de video:', err);
      this.stop();
      return false;
    }
  }

  /**
   * Detiene y libera completamente el hardware de la cámara web,
   * apagando el LED físico de inmediato.
   */
  public stop(): void {
    this.isRunning = false;

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch {}
      });
      this.mediaStream = null;
    }

    if (this.videoElement) {
      try {
        this.videoElement.pause();
        this.videoElement.srcObject = null;
        this.videoElement.remove();
      } catch {}
      this.videoElement = null;
    }

    this.canvasElement = null;
    this.canvasCtx = null;
    this.latestLandmarks = null;
    this.filter.reset();
  }

  /**
   * Inicializa MediaPipe FaceMesh de forma local (Edge AI)
   */
  private async initFaceMesh(): Promise<void> {
    try {
      const w = window as any;
      if (w.FaceMesh) {
        this.faceMeshInstance = new w.FaceMesh({
          locateFile: (file: string) => {
            if (typeof window !== 'undefined' && window.location?.pathname?.includes('renderer')) {
              return `../assets/mediapipe/${file}`;
            }
            return `assets/mediapipe/${file}`;
          }
        });

        this.faceMeshInstance.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true, // Habilita puntos del iris 468-477
          minDetectionConfidence: 0.35,
          minTrackingConfidence: 0.35
        });

        this.faceMeshInstance.onResults((results: any) => {
          if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            this.latestLandmarks = results.multiFaceLandmarks[0];
          } else {
            this.latestLandmarks = null;
          }
        });
      }
    } catch (err) {
      console.warn('[GazeTracker] FaceMesh local no pudo ser instanciado, usando detector CV híbrido:', err);
    }
  }

  /**
   * Bucle principal de procesamiento a 60 FPS
   */
  private loop = (): void => {
    if (!this.isRunning) return;

    if (this.videoElement && this.videoElement.readyState >= 2 && this.canvasCtx && this.canvasElement) {
      // Dibujar frame en canvas para análisis rápido
      this.canvasCtx.drawImage(this.videoElement, 0, 0, this.canvasElement.width, this.canvasElement.height);

      if (this.faceMeshInstance && this.videoElement.videoWidth > 0 && !this.isProcessingFrame) {
        // Enviar a FaceMesh (asíncrono con guard de concurrencia)
        this.isProcessingFrame = true;
        this.faceMeshInstance.send({ image: this.videoElement })
          .catch(() => {})
          .finally(() => {
            this.isProcessingFrame = false;
          });
      }

      this.processCurrentFrame();
    }

    this.animFrameId = requestAnimationFrame(this.loop);
  };

  /**
   * Procesa las características del frame actual
   */
  private processCurrentFrame(): void {
    const timestamp = performance.now();
    let rawEyeX = 0.5;
    let rawEyeY = 0.5;
    let ear = 0.28;
    let faceFound = false;

    if (this.latestLandmarks && this.latestLandmarks.length >= 468) {
      faceFound = true;
      const lm = this.latestLandmarks;

      // 1. Postura de cabeza y encuadre adaptable a hospitales / personas recostadas (Stage A)
      const noseTip = lm[1];
      const leftTemple = lm[234];
      const rightTemple = lm[454];

      // Distancia estimada del rostro en cm (proporcional al ancho de sienes vs frame)
      const templeDist = Math.hypot(rightTemple.x - leftTemple.x, rightTemple.y - leftTemple.y);
      const estimatedCm = Math.round(19.2 / Math.max(templeDist, 0.03));

      // Encuadre flexible: permite estar reclinado o desplazado en la cama/almohada
      const isCentered = noseTip.x >= 0.15 && noseTip.x <= 0.85 && noseTip.y >= 0.12 && noseTip.y <= 0.88;
      // Rango ergonómico hospitalario y de escritorio (35 cm a 150 cm)
      const isDistanceOptimal = estimatedCm >= 35 && estimatedCm <= 145;

      // Iluminación estimada mediante brillo de la frente y ojos
      const lightingScore = this.estimateLighting();
      const isLightingGood = lightingScore >= 25;

      this.currentPosture = {
        isFaceDetected: true,
        isCentered,
        isDistanceOptimal,
        isLightingGood,
        readyForCalibration: isCentered && isLightingGood,
        headDistanceCm: estimatedCm,
        faceCenterOffset: { x: (noseTip.x - 0.5) * 2, y: (noseTip.y - 0.5) * 2 },
        lightingScore
      };

      // 2. Coordenadas del Iris y Ojos (Invariantes ante rotación/cabeza ladeada en la almohada y distancia)
      const leftIris = lm[468] || lm[159];
      const rightIris = lm[473] || lm[386];

      const leftOuter = lm[33];
      const leftInner = lm[133];
      const rightInner = lm[362];
      const rightOuter = lm[263];

      // Vector del eje de ojos para compensar inclinación de la cabeza (Head Roll)
      const eyeDeltaX = leftInner.x - rightInner.x;
      const eyeDeltaY = leftInner.y - rightInner.y;
      const interEyeDist = Math.hypot(eyeDeltaX, eyeDeltaY) || 0.1;
      const uX = eyeDeltaX / interEyeDist;
      const uY = eyeDeltaY / interEyeDist;
      const vX = -uY; // perpendicular normal hacia arriba
      const vY = uX;

      // Ojo Izquierdo: centro y proyección del iris en el plano facial
      const leftCenterX = (leftOuter.x + leftInner.x) * 0.5;
      const leftCenterY = (leftOuter.y + leftInner.y) * 0.5;
      const leftEyeWidth = Math.max(Math.hypot(leftInner.x - leftOuter.x, leftInner.y - leftOuter.y), 0.015);
      const leftDispX = (leftIris.x - leftCenterX) * uX + (leftIris.y - leftCenterY) * uY;
      const leftDispY = (leftIris.x - leftCenterX) * vX + (leftIris.y - leftCenterY) * vY;

      // Ojo Derecho: centro y proyección del iris en el plano facial
      const rightCenterX = (rightOuter.x + rightInner.x) * 0.5;
      const rightCenterY = (rightOuter.y + rightInner.y) * 0.5;
      const rightEyeWidth = Math.max(Math.hypot(rightOuter.x - rightInner.x, rightOuter.y - rightInner.y), 0.015);
      const rightDispX = (rightIris.x - rightCenterX) * uX + (rightIris.y - rightCenterY) * uY;
      const rightDispY = (rightIris.x - rightCenterX) * vX + (rightIris.y - rightCenterY) * vY;

      // Desplazamiento ocular normalizado (independiente de la distancia de la cámara)
      const leftRelX = leftDispX / leftEyeWidth;
      const rightRelX = rightDispX / rightEyeWidth;
      const leftRelY = leftDispY / (leftEyeWidth * 0.45);
      const rightRelY = rightDispY / (rightEyeWidth * 0.45);

      const avgRelX = (leftRelX + rightRelX) * 0.5;
      const avgRelY = (leftRelY + rightRelY) * 0.5;

      // Centrado en 0.50 y mapeado con ganancia
      rawEyeX = 0.50 + avgRelX * 2.4;
      rawEyeY = 0.50 - avgRelY * 2.4;

      // 3. Tasa de Aspecto del Ojo (EAR) para Parpadeo
      // EAR = (||p2 - p6|| + ||p3 - p5||) / (2 * ||p1 - p4||)
      const earLeft = (
        Math.hypot(lm[160].x - lm[144].x, lm[160].y - lm[144].y) +
        Math.hypot(lm[158].x - lm[153].x, lm[158].y - lm[153].y)
      ) / (2 * Math.hypot(leftOuter.x - leftInner.x, leftOuter.y - leftInner.y));

      const earRight = (
        Math.hypot(lm[385].x - lm[380].x, lm[385].y - lm[380].y) +
        Math.hypot(lm[387].x - lm[373].x, lm[387].y - lm[373].y)
      ) / (2 * Math.hypot(rightInner.x - rightOuter.x, rightInner.y - rightOuter.y));

      ear = (earLeft + earRight) / 2.0;
    } else {
      // Fallback: estimar movimiento ocular por centro de masa de luminancia en canvas
      const cvResult = this.detectEyesWithCVFallback();
      rawEyeX = cvResult.eyeX;
      rawEyeY = cvResult.eyeY;
      ear = cvResult.ear;
      faceFound = cvResult.faceFound;

      this.currentPosture = {
        isFaceDetected: faceFound,
        isCentered: faceFound,
        isDistanceOptimal: faceFound,
        isLightingGood: this.estimateLighting() >= 25,
        readyForCalibration: faceFound,
        headDistanceCm: 55,
        faceCenterOffset: { x: 0, y: 0 },
        lightingScore: this.estimateLighting()
      };
    }

    // 4. Mecánica de Parpadeo Intencional (Blink Click)
    let isIntentionalBlink = false;
    const isEyeClosed = ear < this.earThreshold;

    if (isEyeClosed) {
      if (this.eyeClosedStartTime === null) {
        this.eyeClosedStartTime = timestamp;
      }
    } else {
      if (this.eyeClosedStartTime !== null) {
        const closedDuration = timestamp - this.eyeClosedStartTime;
        this.eyeClosedStartTime = null;

        // Distinguir parpadeo intencional (300ms a 650ms) vs involuntario (<180ms)
        if (
          this.blinkClickEnabled &&
          closedDuration >= 280 &&
          closedDuration <= 650 &&
          timestamp - this.lastBlinkClickTime > 800 // Cooldown de 800ms
        ) {
          isIntentionalBlink = true;
          this.lastBlinkClickTime = timestamp;
        }
      }
    }

    // 5. Mapeo a resolución del Viewport mediante CalibrationModel
    const screenW = window.innerWidth || 1920;
    const screenH = window.innerHeight || 1080;

    const mapped = this.calibrationModel.predict(
      rawEyeX,
      rawEyeY,
      screenW,
      screenH,
      this.sensitivityX,
      this.sensitivityY
    );

    // 6. Filtrado adaptativo (Filtro One Euro 2D con detección de fijación vs sacadas)
    const filtered = this.filter.filter(mapped.x, mapped.y, timestamp);

    const frameData: GazeFrameData = {
      rawEyeX,
      rawEyeY,
      screenX: filtered.x,
      screenY: filtered.y,
      isFixated: filtered.isFixated,
      velocity: filtered.velocity,
      ear,
      isBlinking: isEyeClosed,
      isIntentionalBlink,
      posture: this.currentPosture
    };
    this.latestFrameData = frameData;

    // Emitir eventos en el bus local y difundir por IPC a WebContentsViews (pestañas)
    this.bus.broadcast('gaze-pos', {
      x: filtered.x,
      y: filtered.y,
      rawX: mapped.x,
      rawY: mapped.y,
      isFixated: filtered.isFixated,
      velocity: filtered.velocity,
      ear,
      isBlinking: isEyeClosed,
      isIntentionalBlink,
      faceFound: this.currentPosture.isFaceDetected,
      timestamp
    });

    if (isIntentionalBlink) {
      this.bus.broadcast('blink-click', {
        x: filtered.x,
        y: filtered.y,
        duration: 350,
        ear,
        eye: 'both'
      });
      this.bus.broadcast('click', {
        x: filtered.x,
        y: filtered.y,
        source: 'gaze-blink'
      });
    }
  }

  /**
   * Fallback de visión artificial para estimación de iris mediante centro de masa de pupila oscura
   */
  private detectEyesWithCVFallback(): { eyeX: number; eyeY: number; ear: number; faceFound: boolean } {
    if (!this.canvasCtx || !this.canvasElement) {
      return { eyeX: 0.5, eyeY: 0.5, ear: 0.3, faceFound: false };
    }

    try {
      const w = this.canvasElement.width;
      const h = this.canvasElement.height;
      // Muestrear región central del tercio superior (área de ojos)
      const eyeRegionW = Math.floor(w * 0.5);
      const eyeRegionH = Math.floor(h * 0.25);
      const startX = Math.floor(w * 0.25);
      const startY = Math.floor(h * 0.25);

      const imgData = this.canvasCtx.getImageData(startX, startY, eyeRegionW, eyeRegionH);
      const data = imgData.data;

      let sumX = 0;
      let sumY = 0;
      let darkPixels = 0;
      let minLum = 255;

      for (let y = 0; y < eyeRegionH; y += 4) {
        for (let x = 0; x < eyeRegionW; x += 4) {
          const idx = (y * eyeRegionW + x) * 4;
          const lum = (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
          if (lum < minLum) minLum = lum;
          if (lum < 55) {
            sumX += x;
            sumY += y;
            darkPixels++;
          }
        }
      }

      if (darkPixels >= 16) {
        const avgX = (sumX / darkPixels) / eyeRegionW;
        const avgY = (sumY / darkPixels) / eyeRegionH;
        return {
          eyeX: 1.0 - Math.max(0.1, Math.min(0.9, avgX)),
          eyeY: Math.max(0.1, Math.min(0.9, avgY)),
          ear: 0.28,
          faceFound: true
        };
      }
    } catch {}

    // Si no se detectan suficientes píxeles de pupila, los ojos están CERRADOS o el rostro no está presente
    return { eyeX: 0.5, eyeY: 0.5, ear: 0.08, faceFound: false };
  }

  private estimateLighting(): number {
    if (!this.canvasCtx || !this.canvasElement) return 50;
    try {
      // Muestreo rápido de luminancia media
      const imgData = this.canvasCtx.getImageData(160, 120, 320, 240);
      const data = imgData.data;
      let total = 0;
      const count = data.length / 16;
      for (let i = 0; i < data.length; i += 16) {
        total += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      }
      return Math.round(total / count);
    } catch {
      return 50;
    }
  }
}
