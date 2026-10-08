/**
 * accessibility.ts
 *
 * Módulo Completo de Accesibilidad Visual y Bus de Eventos para NavegadorBeta.
 * Ejecutable directamente en el entorno de renderizado sin dependencias de empaquetador.
 *
 * Expone en `window`:
 *   - window.AccessibilityEventBus
 *   - window.AdaptiveGazeFilter2D
 *   - window.CalibrationModel
 *   - window.GazeTracker
 *   - window.GazeOverlay
 *   - window.GazeManager
 */

(function (global: any) {
  'use strict';

  // ════════════════════════════════════════════════════════════════════════════
  // 1. ACCESSIBILITY EVENT BUS
  // ════════════════════════════════════════════════════════════════════════════
  class AccessibilityEventBus {
    private static instance: AccessibilityEventBus | null = null;
    private listeners: Map<string, Set<(data: any) => void>> = new Map();
    private ipcAttached: boolean = false;

    private constructor() {
      this.setupIpcBridge();
    }

    public static getInstance(): AccessibilityEventBus {
      if (!AccessibilityEventBus.instance) {
        AccessibilityEventBus.instance = new AccessibilityEventBus();
        if (typeof window !== 'undefined') {
          (window as any).accessibilityBus = AccessibilityEventBus.instance;
        }
      }
      return AccessibilityEventBus.instance;
    }

    public on(event: string, callback: (data: any) => void): () => void {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(callback);
      return () => this.off(event, callback);
    }

    public once(event: string, callback: (data: any) => void): () => void {
      const wrapped = (data: any) => {
        this.off(event, wrapped);
        callback(data);
      };
      return this.on(event, wrapped);
    }

    public off(event: string, callback: (data: any) => void): void {
      const set = this.listeners.get(event);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.listeners.delete(event);
      }
    }

    public emit(event: string, data: any = {}): void {
      const set = this.listeners.get(event);
      if (set) {
        set.forEach(cb => {
          try { cb(data); } catch (err) { console.error(`[AccessibilityEventBus] Error en '${event}':`, err); }
        });
      }
    }

    public broadcast(event: string, data: any = {}): void {
      this.emit(event, data);
      try {
        const api = (window as any).betaAPI;
        if (api?.gaze?.broadcast) {
          api.gaze.broadcast({ type: event, data });
        }
      } catch (err) {
        console.warn('[AccessibilityEventBus] Error al emitir broadcast IPC:', err);
      }
    }

    private setupIpcBridge(): void {
      if (this.ipcAttached || typeof window === 'undefined') return;
      try {
        const api = (window as any).betaAPI;
        if (api?.gaze?.onEvent) {
          api.gaze.onEvent((payload: { type: string; data: any }) => {
            if (payload && payload.type) {
              this.emit(payload.type, payload.data);
            }
          });
          this.ipcAttached = true;
        }
      } catch {}
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. FILTRADO ADAPTATIVO: ONE EURO FILTER & ANTI-JITTER
  // ════════════════════════════════════════════════════════════════════════════
  class LowPassFilter {
    private y: number | null = null;
    private s: number | null = null;
    constructor(private alpha: number = 0.5) {}

    public filter(value: number, alpha?: number): number {
      if (alpha !== undefined) this.alpha = alpha;
      if (this.s === null) {
        this.s = value;
      } else {
        this.s = this.alpha * value + (1.0 - this.alpha) * this.s;
      }
      this.y = value;
      return this.s;
    }
    public lastValue(): number | null { return this.y; }
    public reset(): void { this.y = null; this.s = null; }
  }

  class OneEuroFilter1D {
    private xFilter: LowPassFilter = new LowPassFilter();
    private dxFilter: LowPassFilter = new LowPassFilter();
    private lastTime: number | null = null;

    constructor(
      private minCutoff: number = 0.7,
      private beta: number = 0.04,
      private dCutoff: number = 1.0
    ) {}

    private alpha(cutoff: number, dt: number): number {
      const tau = 1.0 / (2 * Math.PI * cutoff);
      return 1.0 / (1.0 + tau / dt);
    }

    public filter(value: number, timestamp: number): number {
      if (this.lastTime === null) {
        this.lastTime = timestamp;
        return this.xFilter.filter(value, 1.0);
      }
      const dt = Math.max((timestamp - this.lastTime) / 1000.0, 0.001);
      this.lastTime = timestamp;

      const prevX = this.xFilter.lastValue();
      const dx = prevX === null ? 0.0 : (value - prevX) / dt;
      const edx = this.dxFilter.filter(dx, this.alpha(this.dCutoff, dt));

      const cutoff = this.minCutoff + this.beta * Math.abs(edx);
      return this.xFilter.filter(value, this.alpha(cutoff, dt));
    }

    public reset(): void {
      this.xFilter.reset();
      this.dxFilter.reset();
      this.lastTime = null;
    }
  }

  class AdaptiveGazeFilter2D {
    private filterX: OneEuroFilter1D;
    private filterY: OneEuroFilter1D;
    private minCutoff: number = 0.7;
    private beta: number = 0.04;
    private deadzone: number = 18;
    private saccadeThreshold: number = 550;
    private lastFilteredX: number | null = null;
    private lastFilteredY: number | null = null;
    private lastTimestamp: number | null = null;
    private currentVelocity: number = 0;
    private isFixated: boolean = false;

    constructor(options?: { minCutoff?: number; beta?: number; deadzone?: number; saccadeThreshold?: number }) {
      if (options?.minCutoff !== undefined) this.minCutoff = options.minCutoff;
      if (options?.beta !== undefined) this.beta = options.beta;
      if (options?.deadzone !== undefined) this.deadzone = options.deadzone;
      if (options?.saccadeThreshold !== undefined) this.saccadeThreshold = options.saccadeThreshold;

      this.filterX = new OneEuroFilter1D(this.minCutoff, this.beta, 1.0);
      this.filterY = new OneEuroFilter1D(this.minCutoff, this.beta, 1.0);
    }

    public updateConfig(options: { minCutoff?: number; beta?: number; deadzone?: number; saccadeThreshold?: number }): void {
      if (options.minCutoff !== undefined) this.minCutoff = options.minCutoff;
      if (options.beta !== undefined) this.beta = options.beta;
      if (options.deadzone !== undefined) this.deadzone = options.deadzone;
      if (options.saccadeThreshold !== undefined) this.saccadeThreshold = options.saccadeThreshold;

      this.filterX = new OneEuroFilter1D(this.minCutoff, this.beta, 1.0);
      this.filterY = new OneEuroFilter1D(this.minCutoff, this.beta, 1.0);
    }

    public filter(rawX: number, rawY: number, timestamp: number = performance.now()): {
      x: number;
      y: number;
      isFixated: boolean;
      velocity: number;
    } {
      if (this.lastFilteredX === null || this.lastFilteredY === null || this.lastTimestamp === null) {
        this.lastFilteredX = rawX;
        this.lastFilteredY = rawY;
        this.lastTimestamp = timestamp;
        this.filterX.filter(rawX, timestamp);
        this.filterY.filter(rawY, timestamp);
        return { x: rawX, y: rawY, isFixated: false, velocity: 0 };
      }

      const dt = Math.max((timestamp - this.lastTimestamp) / 1000.0, 0.001);
      this.lastTimestamp = timestamp;

      const dist = Math.hypot(rawX - this.lastFilteredX, rawY - this.lastFilteredY);
      this.currentVelocity = dist / dt;

      // 1. Movimiento Sacádico
      if (this.currentVelocity > this.saccadeThreshold || dist > this.deadzone * 4) {
        this.isFixated = false;
        this.filterX.reset();
        this.filterY.reset();
        const directX = this.filterX.filter(rawX, timestamp);
        const directY = this.filterY.filter(rawY, timestamp);
        this.lastFilteredX = directX;
        this.lastFilteredY = directY;
        return { x: directX, y: directY, isFixated: false, velocity: this.currentVelocity };
      }

      // 2. Zona Muerta (Anti-Jitter)
      if (dist < this.deadzone && this.currentVelocity < 180) {
        this.isFixated = true;
        return { x: this.lastFilteredX, y: this.lastFilteredY, isFixated: true, velocity: this.currentVelocity };
      }

      // 3. Fijación y movimiento suave
      this.isFixated = this.currentVelocity < 120;
      const filteredX = this.filterX.filter(rawX, timestamp);
      const filteredY = this.filterY.filter(rawY, timestamp);
      this.lastFilteredX = filteredX;
      this.lastFilteredY = filteredY;

      return { x: filteredX, y: filteredY, isFixated: this.isFixated, velocity: this.currentVelocity };
    }

    public reset(): void {
      this.filterX.reset();
      this.filterY.reset();
      this.lastFilteredX = null;
      this.lastFilteredY = null;
      this.lastTimestamp = null;
      this.currentVelocity = 0;
      this.isFixated = false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. MODELO DE CALIBRACIÓN: REGRESIÓN POLINOMIAL 2D (9 PUNTOS)
  // ════════════════════════════════════════════════════════════════════════════
  class CalibrationModel {
    private data: any = null;

    constructor(savedModel?: any) {
      if (savedModel && savedModel.coeffX && savedModel.coeffY) {
        this.data = savedModel;
      }
    }

    public isCalibrated(): boolean {
      return this.data !== null && this.data.coeffX && this.data.coeffX.length >= 3;
    }

    public getModelData(): any {
      return this.data;
    }

    public fit(samples: any[], screenWidth: number, screenHeight: number): boolean {
      if (samples.length < 5) return this.fitAffineFallback(samples, screenWidth, screenHeight, 0.5, 0.5, 0.05, 0.05);

      const n = samples.length;

      let sumX = 0, sumY = 0;
      for (const s of samples) {
        sumX += s.eyeX;
        sumY += s.eyeY;
      }
      const meanX = sumX / n;
      const meanY = sumY / n;

      let varX = 0, varY = 0;
      for (const s of samples) {
        varX += (s.eyeX - meanX) ** 2;
        varY += (s.eyeY - meanY) ** 2;
      }
      const stdX = Math.max(Math.sqrt(varX / n), 0.008);
      const stdY = Math.max(Math.sqrt(varY / n), 0.008);

      const m = 6;
      const A: number[][] = [];
      const bx: number[] = [];
      const by: number[] = [];

      for (let i = 0; i < n; i++) {
        const zx = (samples[i].eyeX - meanX) / stdX;
        const zy = (samples[i].eyeY - meanY) / stdY;
        A.push([1.0, zx, zy, zx * zx * 0.5, zy * zy * 0.5, zx * zy * 0.5]);
        bx.push(samples[i].screenX);
        by.push(samples[i].screenY);
      }

      const AtA: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
      const AtBx: number[] = new Array(m).fill(0);
      const AtBy: number[] = new Array(m).fill(0);

      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
          let sum = 0;
          for (let k = 0; k < n; k++) sum += A[k][i] * A[k][j];
          AtA[i][j] = sum;
        }
        let sumBx = 0, sumBy = 0;
        for (let k = 0; k < n; k++) {
          sumBx += A[k][i] * bx[k];
          sumBy += A[k][i] * by[k];
        }
        AtBx[i] = sumBx;
        AtBy[i] = sumBy;
      }

      const ridgeScale = Math.max(0.1, AtA[0][0] * 0.02);
      AtA[0][0] += ridgeScale * 0.01;
      AtA[1][1] += ridgeScale * 0.10;
      AtA[2][2] += ridgeScale * 0.10;
      AtA[3][3] += ridgeScale * 0.80;
      AtA[4][4] += ridgeScale * 0.80;
      AtA[5][5] += ridgeScale * 0.80;

      const coeffX = this.solveLinearSystem(AtA, AtBx);
      const coeffY = this.solveLinearSystem(AtA, AtBy);

      if (!coeffX || !coeffY) return this.fitAffineFallback(samples, screenWidth, screenHeight, meanX, meanY, stdX, stdY);

      let totalErr = 0;
      for (const s of samples) {
        const zx = (s.eyeX - meanX) / stdX;
        const zy = (s.eyeY - meanY) / stdY;
        const pred = this.evaluatePolynomial(coeffX, coeffY, zx, zy);
        totalErr += Math.hypot(pred.x - s.screenX, pred.y - s.screenY);
      }

      this.data = {
        coeffX,
        coeffY,
        screenWidth,
        screenHeight,
        residualError: totalErr / n,
        points: samples,
        meanX,
        stdX,
        meanY,
        stdY
      };
      return true;
    }

    public predict(
      eyeX: number,
      eyeY: number,
      currentWidth: number,
      currentHeight: number,
      sensitivityX: number = 1.0,
      sensitivityY: number = 1.0
    ): { x: number; y: number } {
      if (!this.data) {
        const directX = (1.0 - eyeX) * currentWidth;
        const directY = eyeY * currentHeight;
        return {
          x: Math.max(0, Math.min(currentWidth, directX)),
          y: Math.max(0, Math.min(currentHeight, directY))
        };
      }

      const meanX = this.data.meanX ?? 0.50;
      const stdX = this.data.stdX ?? 0.05;
      const meanY = this.data.meanY ?? 0.50;
      const stdY = this.data.stdY ?? 0.05;

      const zx = Math.max(-3.5, Math.min(3.5, (eyeX - meanX) / stdX));
      const zy = Math.max(-3.5, Math.min(3.5, (eyeY - meanY) / stdY));

      let { x, y } = this.evaluatePolynomial(this.data.coeffX, this.data.coeffY, zx, zy);

      if (this.data.screenWidth > 0 && this.data.screenHeight > 0) {
        x = (x / this.data.screenWidth) * currentWidth;
        y = (y / this.data.screenHeight) * currentHeight;
      }

      if (sensitivityX !== 1.0 || sensitivityY !== 1.0) {
        const cx = currentWidth / 2;
        const cy = currentHeight / 2;
        x = cx + (x - cx) * sensitivityX;
        y = cy + (y - cy) * sensitivityY;
      }

      return {
        x: Math.max(0, Math.min(currentWidth, x)),
        y: Math.max(0, Math.min(currentHeight, y))
      };
    }

    private evaluatePolynomial(coeffX: number[], coeffY: number[], zx: number, zy: number): { x: number; y: number } {
      const terms = [1.0, zx, zy, zx * zx * 0.5, zy * zy * 0.5, zx * zy * 0.5];
      let px = 0, py = 0;
      for (let i = 0; i < coeffX.length && i < terms.length; i++) {
        px += coeffX[i] * terms[i];
        py += coeffY[i] * terms[i];
      }
      return { x: px, y: py };
    }

    private solveLinearSystem(A_orig: number[][], b_orig: number[]): number[] | null {
      const n = b_orig.length;
      const A = A_orig.map(row => [...row]);
      const b = [...b_orig];

      for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
          if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
        }
        if (Math.abs(A[maxRow][i]) < 1e-12) return null;

        const tempA = A[i]; A[i] = A[maxRow]; A[maxRow] = tempA;
        const tempB = b[i]; b[i] = b[maxRow]; b[maxRow] = tempB;

        for (let k = i + 1; k < n; k++) {
          const factor = A[k][i] / A[i][i];
          for (let j = i; j < n; j++) A[k][j] -= factor * A[i][j];
          b[k] -= factor * b[i];
        }
      }

      const x = new Array(n).fill(0);
      for (let i = n - 1; i >= 0; i--) {
        let sum = b[i];
        for (let j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
        x[i] = sum / A[i][i];
      }
      return x;
    }

    private fitAffineFallback(
      samples: any[],
      screenWidth: number,
      screenHeight: number,
      meanX: number,
      meanY: number,
      stdX: number,
      stdY: number
    ): boolean {
      const n = samples.length;
      const m = 3;
      const A: number[][] = [];
      const bx: number[] = [];
      const by: number[] = [];

      for (let i = 0; i < n; i++) {
        const zx = (samples[i].eyeX - meanX) / stdX;
        const zy = (samples[i].eyeY - meanY) / stdY;
        A.push([1.0, zx, zy]);
        bx.push(samples[i].screenX);
        by.push(samples[i].screenY);
      }

      const AtA: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
      const AtBx: number[] = new Array(m).fill(0);
      const AtBy: number[] = new Array(m).fill(0);

      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
          let sum = 0;
          for (let k = 0; k < n; k++) sum += A[k][i] * A[k][j];
          AtA[i][j] = sum;
        }
        for (let k = 0; k < n; k++) {
          AtBx[i] += A[k][i] * bx[k];
          AtBy[i] += A[k][i] * by[k];
        }
      }

      AtA[0][0] += 0.1;
      AtA[1][1] += 0.5;
      AtA[2][2] += 0.5;

      const coeffX3 = this.solveLinearSystem(AtA, AtBx) || [screenWidth / 2, -screenWidth * 0.4, 0];
      const coeffY3 = this.solveLinearSystem(AtA, AtBy) || [screenHeight / 2, 0, screenHeight * 0.4];

      this.data = {
        coeffX: [coeffX3[0], coeffX3[1], coeffX3[2], 0, 0, 0],
        coeffY: [coeffY3[0], coeffY3[1], coeffY3[2], 0, 0, 0],
        screenWidth,
        screenHeight,
        residualError: 35,
        points: samples,
        meanX,
        stdX,
        meanY,
        stdY
      };
      return true;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 4. GAZE TRACKER (EDGE AI 60 FPS + LIBERACIÓN LIMPIA DE HARDWARE)
  // ════════════════════════════════════════════════════════════════════════════
  class GazeTracker {
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

    private sensitivityX: number = 1.0;
    private sensitivityY: number = 1.0;
    private deadzone: number = 18;
    private earThreshold: number = 0.20;
    private blinkClickEnabled: boolean = true;

    private eyeClosedStartTime: number | null = null;
    private lastBlinkClickTime: number = 0;

    private faceMeshInstance: any = null;
    private isProcessingFrame: boolean = false;
    private latestLandmarks: any[] | null = null;
    private latestFrameData: any = null;

    private currentPosture: any = {
      isFaceDetected: false,
      isCentered: false,
      isDistanceOptimal: false,
      isLightingGood: false,
      readyForCalibration: false,
      headDistanceCm: 0,
      faceCenterOffset: { x: 0, y: 0 },
      lightingScore: 0
    };

    constructor(options?: any, savedCalibration?: any) {
      this.bus = AccessibilityEventBus.getInstance();
      this.filter = new AdaptiveGazeFilter2D({ deadzone: options?.deadzone || 18 });
      this.calibrationModel = new CalibrationModel(savedCalibration || null);

      if (options) {
        if (options.sensitivityX !== undefined) this.sensitivityX = options.sensitivityX;
        if (options.sensitivityY !== undefined) this.sensitivityY = options.sensitivityY;
        if (options.deadzone !== undefined) this.deadzone = options.deadzone;
        if (options.earThreshold !== undefined) this.earThreshold = options.earThreshold;
        if (options.blinkClickEnabled !== undefined) this.blinkClickEnabled = options.blinkClickEnabled;
      }
    }

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

    public updateConfig(options: any): void {
      if (options.sensitivityX !== undefined) this.sensitivityX = options.sensitivityX;
      if (options.sensitivityY !== undefined) this.sensitivityY = options.sensitivityY;
      if (options.deadzone !== undefined) {
        this.deadzone = options.deadzone;
        this.filter.updateConfig({ deadzone: this.deadzone });
      }
      if (options.earThreshold !== undefined) this.earThreshold = options.earThreshold;
      if (options.blinkClickEnabled !== undefined) this.blinkClickEnabled = options.blinkClickEnabled;
    }

    public setCalibrationModel(model: CalibrationModel): void { this.calibrationModel = model; }
    public getCalibrationModel(): CalibrationModel { return this.calibrationModel; }
    public getPosture(): any { return this.currentPosture; }
    public getVideoElement(): HTMLVideoElement | null { return this.videoElement; }

    public getLatestFrameData(): any {
      return this.latestFrameData;
    }

    public getLatestRawEyes(): { rawEyeX: number; rawEyeY: number; ear: number; faceFound: boolean; isFixated: boolean; velocity: number } {
      if (this.latestFrameData) {
        return {
          rawEyeX: this.latestFrameData.rawEyeX,
          rawEyeY: this.latestFrameData.rawEyeY,
          ear: this.latestFrameData.ear,
          faceFound: this.latestFrameData.posture?.isFaceDetected || false,
          isFixated: this.latestFrameData.isFixated || false,
          velocity: this.latestFrameData.velocity || 0
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

      // Preferir cámaras físicas sobre controladores virtuales (sharing/obs) en selección inicial
      if (!targetDeviceId && availableCameras.length > 0) {
        const physical = availableCameras.find(c => {
          const lower = c.label.toLowerCase();
          return !lower.includes('sharing') && !lower.includes('virtual') && !lower.includes('obs');
        });
        targetDeviceId = physical ? physical.deviceId : availableCameras[0].deviceId;
      }

      let stream: MediaStream | null = null;

      // Intento 1: Cámara seleccionada con 30 FPS estándar y 640x480
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

      // Intento 3: Probar otras cámaras si la principal falló
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

        // Esperar video sin posibilidad de deadlock
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

    public stop(): void {
      this.isRunning = false;

      if (this.animFrameId !== null) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => {
          try { track.stop(); } catch {}
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
            refineLandmarks: true,
            minDetectionConfidence: 0.35,
            minTrackingConfidence: 0.35
          });
          this.faceMeshInstance.onResults((res: any) => {
            if (res.multiFaceLandmarks && res.multiFaceLandmarks.length > 0) {
              this.latestLandmarks = res.multiFaceLandmarks[0];
            } else {
              this.latestLandmarks = null;
            }
          });
        }
      } catch (e) {
        console.warn('[GazeTracker] FaceMesh no disponible localmente, usando motor CV:', e);
      }
    }

    private loop = (): void => {
      if (!this.isRunning) return;

      if (this.videoElement && this.videoElement.readyState >= 2 && this.canvasCtx && this.canvasElement) {
        this.canvasCtx.drawImage(this.videoElement, 0, 0, this.canvasElement.width, this.canvasElement.height);

        if (this.faceMeshInstance && this.videoElement.videoWidth > 0 && !this.isProcessingFrame) {
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

    private processCurrentFrame(): void {
      const timestamp = performance.now();
      let rawEyeX = 0.5;
      let rawEyeY = 0.5;
      let ear = 0.28;

      if (this.latestLandmarks && this.latestLandmarks.length >= 468) {
        const lm = this.latestLandmarks;
        const noseTip = lm[1];
        const leftTemple = lm[234];
        const rightTemple = lm[454];

        // Distancia estimada en cm (proporcional al ancho de sienes vs frame)
        const templeDist = Math.hypot(rightTemple.x - leftTemple.x, rightTemple.y - leftTemple.y);
        const estimatedCm = Math.round(19.2 / Math.max(templeDist, 0.03));

        // Encuadre flexible y ergonómico apto para pacientes en cama o recostados
        const isCentered = noseTip.x >= 0.15 && noseTip.x <= 0.85 && noseTip.y >= 0.12 && noseTip.y <= 0.88;
        // Distancia óptima o asistida (35 cm a 150 cm)
        const isDistanceOptimal = estimatedCm >= 35 && estimatedCm <= 145;
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

        const leftIris = lm[468] || lm[159];
        const rightIris = lm[473] || lm[386];
        const leftOuter = lm[33];
        const leftInner = lm[133];
        const rightInner = lm[362];
        const rightOuter = lm[263];

        // Compensación de giro de cabeza (Head Roll / Cabeza sobre almohada)
        const eyeDeltaX = leftInner.x - rightInner.x;
        const eyeDeltaY = leftInner.y - rightInner.y;
        const interEyeDist = Math.hypot(eyeDeltaX, eyeDeltaY) || 0.1;
        const uX = eyeDeltaX / interEyeDist;
        const uY = eyeDeltaY / interEyeDist;
        const vX = -uY;
        const vY = uX;

        // Ojo Izquierdo
        const leftCenterX = (leftOuter.x + leftInner.x) * 0.5;
        const leftCenterY = (leftOuter.y + leftInner.y) * 0.5;
        const leftEyeW = Math.max(Math.hypot(leftInner.x - leftOuter.x, leftInner.y - leftOuter.y), 0.015);
        const leftDispX = (leftIris.x - leftCenterX) * uX + (leftIris.y - leftCenterY) * uY;
        const leftDispY = (leftIris.x - leftCenterX) * vX + (leftIris.y - leftCenterY) * vY;

        // Ojo Derecho
        const rightCenterX = (rightOuter.x + rightInner.x) * 0.5;
        const rightCenterY = (rightOuter.y + rightInner.y) * 0.5;
        const rightEyeW = Math.max(Math.hypot(rightOuter.x - rightInner.x, rightOuter.y - rightInner.y), 0.015);
        const rightDispX = (rightIris.x - rightCenterX) * uX + (rightIris.y - rightCenterY) * uY;
        const rightDispY = (rightIris.x - rightCenterX) * vX + (rightIris.y - rightCenterY) * vY;

        const leftRelX = leftDispX / leftEyeW;
        const rightRelX = rightDispX / rightEyeW;
        const leftRelY = leftDispY / (leftEyeW * 0.45);
        const rightRelY = rightDispY / (rightEyeW * 0.45);

        const avgRelX = (leftRelX + rightRelX) * 0.5;
        const avgRelY = (leftRelY + rightRelY) * 0.5;

        rawEyeX = 0.50 + avgRelX * 2.4;
        rawEyeY = 0.50 - avgRelY * 2.4;

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
        const cv = this.detectEyesWithCVFallback();
        rawEyeX = cv.eyeX;
        rawEyeY = cv.eyeY;
        ear = cv.ear;

        this.currentPosture = {
          isFaceDetected: cv.faceFound,
          isCentered: cv.faceFound,
          isDistanceOptimal: cv.faceFound,
          isLightingGood: this.estimateLighting() >= 25,
          readyForCalibration: cv.faceFound,
          headDistanceCm: 55,
          faceCenterOffset: { x: 0, y: 0 },
          lightingScore: this.estimateLighting()
        };
      }

      // Parpadeo voluntario (300ms a 650ms)
      let isIntentionalBlink = false;
      const isEyeClosed = ear < this.earThreshold;

      if (isEyeClosed) {
        if (this.eyeClosedStartTime === null) this.eyeClosedStartTime = timestamp;
      } else {
        if (this.eyeClosedStartTime !== null) {
          const dur = timestamp - this.eyeClosedStartTime;
          this.eyeClosedStartTime = null;
          if (
            this.blinkClickEnabled &&
            dur >= 280 &&
            dur <= 650 &&
            timestamp - this.lastBlinkClickTime > 800
          ) {
            isIntentionalBlink = true;
            this.lastBlinkClickTime = timestamp;
          }
        }
      }

      const screenW = window.innerWidth || 1920;
      const screenH = window.innerHeight || 1080;
      const mapped = this.calibrationModel.predict(rawEyeX, rawEyeY, screenW, screenH, this.sensitivityX, this.sensitivityY);
      const filtered = this.filter.filter(mapped.x, mapped.y, timestamp);

      this.latestFrameData = {
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

      // Difundir evento de posición por IPC para pestañas activas (WebContentsViews) y bus local
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
        this.bus.broadcast('blink-click', { x: filtered.x, y: filtered.y, duration: 350, ear, eye: 'both' });
        this.bus.broadcast('click', { x: filtered.x, y: filtered.y, source: 'gaze-blink' });
      }
    }

    private detectEyesWithCVFallback(): { eyeX: number; eyeY: number; ear: number; faceFound: boolean } {
      if (!this.canvasCtx || !this.canvasElement) return { eyeX: 0.5, eyeY: 0.5, ear: 0.3, faceFound: false };
      try {
        const w = this.canvasElement.width;
        const h = this.canvasElement.height;
        const eyeW = Math.floor(w * 0.5);
        const eyeH = Math.floor(h * 0.25);
        const img = this.canvasCtx.getImageData(Math.floor(w * 0.25), Math.floor(h * 0.25), eyeW, eyeH);
        const d = img.data;

        let sumX = 0, sumY = 0, darks = 0;
        for (let y = 0; y < eyeH; y += 4) {
          for (let x = 0; x < eyeW; x += 4) {
            const idx = (y * eyeW + x) * 4;
            const lum = d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114;
            if (lum < 55) {
              sumX += x; sumY += y; darks++;
            }
          }
        }

        if (darks >= 16) {
          return {
            eyeX: 1.0 - Math.max(0.1, Math.min(0.9, (sumX / darks) / eyeW)),
            eyeY: Math.max(0.1, Math.min(0.9, (sumY / darks) / eyeH)),
            ear: 0.28,
            faceFound: true
          };
        }
      } catch {}

      // Si no hay píxeles oscuros en la región de ojos, están CERRADOS o el rostro ausente
      return { eyeX: 0.5, eyeY: 0.5, ear: 0.08, faceFound: false };
    }

    private estimateLighting(): number {
      if (!this.canvasCtx || !this.canvasElement) return 50;
      try {
        const img = this.canvasCtx.getImageData(160, 120, 320, 240);
        const d = img.data;
        let sum = 0;
        const cnt = d.length / 16;
        for (let i = 0; i < d.length; i += 16) {
          sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        }
        return Math.round(sum / cnt);
      } catch {
        return 50;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 5. GAZE OVERLAY (HALO VISUAL & DWELL CLICK)
  // ════════════════════════════════════════════════════════════════════════════
  class GazeOverlay {
    private container: HTMLDivElement | null = null;
    private svgRing: SVGCircleElement | null = null;
    private pulseCircle: SVGCircleElement | null = null;
    private currentX: number = window.innerWidth / 2;
    private currentY: number = window.innerHeight / 2;

    private dwellCenterX: number = 0;
    private dwellCenterY: number = 0;
    private dwellStartTime: number = 0;
    private isDwelling: boolean = false;
    private lastClickTime: number = 0;

    private dwellTime: number = 1000;
    private dwellRadius: number = 32;
    private cooldown: number = 500;
    private haloRadius: number = 26;
    private circumference: number = 2 * Math.PI * 26;

    private bus: AccessibilityEventBus;
    private unsubscribers: (() => void)[] = [];
    private isDestroyed: boolean = false;

    constructor(options?: any) {
      this.bus = AccessibilityEventBus.getInstance();
      if (options) {
        if (options.dwellTime !== undefined) this.dwellTime = options.dwellTime;
        if (options.dwellRadius !== undefined) this.dwellRadius = options.dwellRadius;
        if (options.cooldown !== undefined) this.cooldown = options.cooldown;
      }
      this.createDomOverlay();
      this.bindEvents();
    }

    public updateConfig(options: any): void {
      if (options.dwellTime !== undefined) this.dwellTime = options.dwellTime;
      if (options.dwellRadius !== undefined) this.dwellRadius = options.dwellRadius;
      if (options.cooldown !== undefined) this.cooldown = options.cooldown;
    }

    private createDomOverlay(): void {
      if (typeof document === 'undefined') return;
      const prev = document.getElementById('beta-gaze-cursor-overlay');
      if (prev) prev.remove();

      this.container = document.createElement('div');
      this.container.id = 'beta-gaze-cursor-overlay';
      this.container.style.cssText = `
        position: fixed;
        left: 0;
        top: 0;
        width: ${this.haloRadius * 2 + 16}px;
        height: ${this.haloRadius * 2 + 16}px;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        transform: translate3d(-100px, -100px, 0);
        will-change: transform;
        opacity: 0.95;
      `;

      const size = this.haloRadius * 2 + 16;
      const center = size / 2;

      this.container.innerHTML = `
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow: visible; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.45));">
          <circle cx="${center}" cy="${center}" r="${this.haloRadius}" fill="rgba(56, 189, 248, 0.08)" stroke="rgba(255, 255, 255, 0.3)" stroke-width="2" />
          <circle id="gaze-dwell-progress-ring" cx="${center}" cy="${center}" r="${this.haloRadius}" fill="none" stroke="#38bdf8" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}" transform="rotate(-90 ${center} ${center})" />
          <circle id="gaze-click-pulse" cx="${center}" cy="${center}" r="${this.haloRadius}" fill="none" stroke="#38bdf8" stroke-width="0" opacity="0" />
          <circle cx="${center}" cy="${center}" r="3.5" fill="#38bdf8" stroke="#ffffff" stroke-width="1.5" />
        </svg>
      `;

      document.documentElement.appendChild(this.container);
      this.svgRing = this.container.querySelector('#gaze-dwell-progress-ring');
      this.pulseCircle = this.container.querySelector('#gaze-click-pulse');
    }

    private bindEvents(): void {
      const u1 = this.bus.on('gaze-pos', (data: any) => this.updatePosition(data.x, data.y, data));
      const u2 = this.bus.on('click', (data: any) => {
        const cx = data.x !== undefined ? data.x : this.currentX;
        const cy = data.y !== undefined ? data.y : this.currentY;
        this.triggerVisualClick(cx, cy);
        if (data.source !== 'gaze-dwell') {
          this.performDomClick(cx, cy, data.button || 'left');
        }
      });
      const u3 = this.bus.on('scroll', (data: any) => this.performScroll(data.direction, data.amount || 320));
      this.unsubscribers.push(u1, u2, u3);
    }

    public updatePosition(x: number, y: number, data?: any): void {
      if (this.isDestroyed || !this.container) return;
      this.currentX = x;
      this.currentY = y;

      const offset = this.haloRadius + 8;
      this.container.style.transform = `translate3d(${x - offset}px, ${y - offset}px, 0)`;

      const now = performance.now();
      if (now - this.lastClickTime < this.cooldown) {
        this.resetDwell();
        return;
      }

      // Si los ojos están cerrados, parpadeando o no hay rostro: detener dwell inmediatamente
      if (data?.isBlinking || (data?.ear !== undefined && data.ear < 0.20) || data?.faceFound === false) {
        this.resetDwell();
        return;
      }

      const dist = Math.hypot(x - this.dwellCenterX, y - this.dwellCenterY);
      if (dist <= this.dwellRadius) {
        if (!this.isDwelling) {
          this.isDwelling = true;
          this.dwellStartTime = now;
        }

        const elapsed = now - this.dwellStartTime;
        const progress = Math.min(elapsed / this.dwellTime, 1.0);

        if (this.svgRing) {
          this.svgRing.style.strokeDashoffset = `${this.circumference * (1.0 - progress)}`;
        }

        if (progress >= 1.0) {
          this.lastClickTime = now;
          this.resetDwell();
          this.triggerVisualClick(x, y);
          this.bus.emit('dwell-click', { x, y });
          this.bus.broadcast('click', { x, y, source: 'gaze-dwell' });
          this.performDomClick(x, y, 'left');
        }
      } else {
        this.dwellCenterX = x;
        this.dwellCenterY = y;
        this.resetDwell();
      }
    }

    private resetDwell(): void {
      this.isDwelling = false;
      this.dwellStartTime = performance.now();
      if (this.svgRing) this.svgRing.style.strokeDashoffset = `${this.circumference}`;
    }

    public triggerVisualClick(x: number, y: number): void {
      if (!this.pulseCircle) return;
      this.pulseCircle.setAttribute('stroke-width', '4');
      this.pulseCircle.setAttribute('opacity', '1');
      this.pulseCircle.setAttribute('r', `${this.haloRadius}`);

      let step = 0;
      const anim = () => {
        step++;
        const r = this.haloRadius + step * 2.2;
        const op = 1.0 - step / 12;
        if (this.pulseCircle) {
          this.pulseCircle.setAttribute('r', `${r}`);
          this.pulseCircle.setAttribute('opacity', `${Math.max(0, op)}`);
        }
        if (step < 12) requestAnimationFrame(anim);
        else if (this.pulseCircle) {
          this.pulseCircle.setAttribute('opacity', '0');
          this.pulseCircle.setAttribute('stroke-width', '0');
        }
      };
      requestAnimationFrame(anim);
    }

    private performDomClick(x: number, y: number, btnName: 'left' | 'right' | 'middle' = 'left'): void {
      if (typeof document === 'undefined') return;
      if (this.container) this.container.style.display = 'none';
      const target = document.elementFromPoint(x, y) as HTMLElement;
      if (this.container) this.container.style.display = 'block';

      if (!target) return;
      const b = btnName === 'right' ? 2 : 0;
      const init: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: b,
        buttons: b === 0 ? 1 : 2
      };

      try {
        target.dispatchEvent(new PointerEvent('pointerdown', init));
        target.dispatchEvent(new MouseEvent('mousedown', init));
        target.dispatchEvent(new PointerEvent('pointerup', init));
        target.dispatchEvent(new MouseEvent('mouseup', init));
        target.dispatchEvent(new MouseEvent('click', init));

        if (target.focus && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          target.focus();
        }
        const a = target.closest('a');
        if (a && a.href && !a.href.startsWith('javascript:')) a.click();
      } catch {}
    }

    private performScroll(direction: string, amount: number): void {
      if (typeof window === 'undefined') return;
      if (direction === 'down') window.scrollBy({ top: amount, behavior: 'smooth' });
      else if (direction === 'up') window.scrollBy({ top: -amount, behavior: 'smooth' });
      else if (direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }

    public destroy(): void {
      this.isDestroyed = true;
      this.unsubscribers.forEach(u => u());
      this.unsubscribers = [];
      if (this.container) {
        this.container.remove();
        this.container = null;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 6. GAZE MANAGER (COORDINADOR MAESTRO Y CONTROL DE HARDWARE)
  // ════════════════════════════════════════════════════════════════════════════
  class GazeManager {
    private static instance: GazeManager | null = null;
    private tracker: GazeTracker | null = null;
    private overlay: GazeOverlay | null = null;
    private bus: AccessibilityEventBus;

    private isEnabled: boolean = false;
    private isCalibrated: boolean = false;
    private status: 'inactive' | 'calibrating' | 'active' = 'inactive';
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
          (window as any).gazeManager = GazeManager.instance;
        }
      }
      return GazeManager.instance;
    }

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

        if (this.isEnabled && this.isCalibrated) {
          await this.startTracking();
        } else {
          this.updateStatus('inactive');
        }
      } catch (e) {
        this.updateStatus('inactive');
      }
    }

    public setupToolbarElement(): void {
      if (typeof document === 'undefined') return;
      this.toolbarBtn = document.getElementById('btn-gaze-toolbar');
      if (this.toolbarBtn) {
        this.toolbarBtn.onclick = () => this.handleToolbarClick();
      }
      this.updateToolbarUi();
    }

    public async toggle(forceState?: boolean): Promise<boolean> {
      const newState = forceState !== undefined ? forceState : !this.isEnabled;

      if (newState) {
        if (!this.isCalibrated) {
          await this.openCalibration();
          return false;
        } else {
          await this.startTracking();
          return true;
        }
      } else {
        await this.stopTracking();
        return false;
      }
    }

    public async openCalibration(): Promise<void> {
      this.updateStatus('calibrating');
      try {
        const api = (window as any).betaAPI;
        if (api?.gaze?.openCalibration) {
          await api.gaze.openCalibration();
        } else {
          window.open('gaze-calibration.html', '_blank', 'width=1280,height=800,frame=false');
        }
      } catch (err) {
        console.error('[GazeManager] Error abriendo calibración:', err);
        this.updateStatus('inactive');
      }
    }

    public async startTracking(): Promise<boolean> {
      this.isEnabled = true;
      this.updateStatus('active');

      this.persistSettings({ enableGazeNavigation: true, gazeCalibrated: true });

      if (!this.tracker) {
        this.tracker = new GazeTracker(
          {
            sensitivityX: this.currentProfile?.sensitivityX || 1.0,
            sensitivityY: this.currentProfile?.sensitivityY || 1.0,
            deadzone: this.currentProfile?.deadzone || 18,
            earThreshold: this.currentProfile?.earThreshold || 0.20,
            blinkClickEnabled: this.currentProfile?.blinkClickEnabled !== false
          },
          this.currentProfile?.calibrationModel || null
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
        started = await this.tracker.start();
      }
      if (!started) {
        await this.stopTracking();
        return false;
      }

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

    public async stopTracking(): Promise<void> {
      this.isEnabled = false;
      this.updateStatus('inactive');
      this.persistSettings({ enableGazeNavigation: false });

      if (this.tracker) {
        this.tracker.stop();
        this.tracker = null;
      }
      if (this.overlay) {
        this.overlay.destroy();
        this.overlay = null;
      }

      this.bus.broadcast('gaze-status', { status: 'inactive' });
    }

    public async applyCalibrationProfile(profile: any): Promise<void> {
      this.currentProfile = { ...this.currentProfile, ...profile };
      this.isCalibrated = true;
      this.isEnabled = true;

      await this.persistSettings({
        enableGazeNavigation: true,
        gazeCalibrated: true,
        gazeProfile: this.currentProfile
      });

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

      // Pausa para asegurar que la ventana de calibración liberó el hardware en Windows
      await new Promise(r => setTimeout(r, 400));
      await this.startTracking();
    }

    private handleToolbarClick(): void {
      if (this.status === 'inactive') {
        if (!this.isCalibrated) this.openCalibration();
        else this.startTracking();
      } else if (this.status === 'calibrating') {
        this.openCalibration();
      } else {
        this.stopTracking();
      }
    }

    private updateStatus(newStatus: 'inactive' | 'calibrating' | 'active'): void {
      this.status = newStatus;
      this.updateToolbarUi();
    }

    private updateToolbarUi(): void {
      if (!this.toolbarBtn) this.toolbarBtn = document.getElementById('btn-gaze-toolbar');
      if (!this.toolbarBtn) return;

      this.toolbarBtn.classList.remove('gaze-inactive', 'gaze-calibrating', 'gaze-active');
      let title = 'Navegación Visual (Mirada = Cursor) — Inactivo';
      let dotColor = '#94a3b8';

      if (this.status === 'active') {
        this.toolbarBtn.classList.add('gaze-active');
        title = 'Navegación Visual (Mirada = Cursor) — Activo (60 FPS)';
        dotColor = '#22c55e';
      } else if (this.status === 'calibrating') {
        this.toolbarBtn.classList.add('gaze-calibrating');
        title = 'Navegación Visual — Calibrando o requiere calibración';
        dotColor = '#f59e0b';
      } else {
        this.toolbarBtn.classList.add('gaze-inactive');
      }

      this.toolbarBtn.title = title;
      const dot = this.toolbarBtn.querySelector('.gaze-status-dot') as HTMLElement;
      if (dot) dot.style.backgroundColor = dotColor;
    }

    private bindBusEvents(): void {
      this.bus.on('calibration-completed', (data: any) => {
        if (data?.profile) this.applyCalibrationProfile(data.profile);
      });
      this.bus.on('gaze-calibration-closed', () => {
        if (!this.isEnabled) this.updateStatus('inactive');
      });
      this.bus.on('gaze-toggle', (data: any) => {
        this.toggle(data?.enabled);
      });
    }

    private async persistSettings(partial: any): Promise<void> {
      try {
        const api = (window as any).betaAPI;
        if (api?.settings?.update) await api.settings.update(partial);
      } catch {}
    }

    public getStatus(): string { return this.status; }
    public isTrackingActive(): boolean { return this.status === 'active'; }
    public getProfile(): any { return this.currentProfile; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EXPOSICIÓN GLOBAL
  // ════════════════════════════════════════════════════════════════════════════
  global.AccessibilityEventBus = AccessibilityEventBus;
  global.AdaptiveGazeFilter2D = AdaptiveGazeFilter2D;
  global.CalibrationModel = CalibrationModel;
  global.GazeTracker = GazeTracker;
  global.GazeOverlay = GazeOverlay;
  global.GazeManager = GazeManager;

  // Auto-iniciar GazeManager singleton en el arranque
  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        GazeManager.getInstance();
      } catch {}
    });
  }

})(typeof window !== 'undefined' ? window : global);
