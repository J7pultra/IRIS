/**
 * oneEuroFilter.ts
 *
 * Algoritmo adaptativo One Euro Filter (1€ Filter) y Filtro de Kalman bidimensional
 * para estabilización de mirada ocular a 60 FPS.
 *
 * Diseñado específicamente para distinguir entre:
 * 1. Fijación visual: cuando la velocidad angular del ojo es baja, incrementa el
 *    suavizado (baja frecuencia de corte) para congelar el cursor sobre el elemento.
 * 2. Movimiento sacádico: cuando la mirada salta rápidamente hacia otra zona,
 *    elimina el filtro adaptativamente para brindar respuesta instantánea sin lag.
 */

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

  public lastValue(): number | null {
    return this.y;
  }

  public reset(): void {
    this.y = null;
    this.s = null;
  }
}

export interface OneEuroFilterConfig {
  minCutoff: number;    // Frecuencia mínima de corte en Hz (fijación, ej: 0.8 Hz)
  beta: number;         // Coeficiente de velocidad para sacadas (ej: 0.05)
  dCutoff: number;      // Frecuencia de corte para la derivada (ej: 1.0 Hz)
  deadzone: number;     // Radio de zona muerta en px para micro-temblores (ej: 15 px)
  saccadeThreshold: number; // Umbral de velocidad en px/s para detectar sacada (ej: 600 px/s)
}

const DEFAULT_CONFIG: OneEuroFilterConfig = {
  minCutoff: 0.7,
  beta: 0.04,
  dCutoff: 1.0,
  deadzone: 16,
  saccadeThreshold: 550
};

export class OneEuroFilter1D {
  private xFilter: LowPassFilter;
  private dxFilter: LowPassFilter;
  private lastTime: number | null = null;

  constructor(
    private minCutoff: number = 0.7,
    private beta: number = 0.04,
    private dCutoff: number = 1.0
  ) {
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
  }

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

/**
 * Filtro 2D One Euro Filter con detección de sacadas vs fijación y zona muerta
 */
export class AdaptiveGazeFilter2D {
  private filterX: OneEuroFilter1D;
  private filterY: OneEuroFilter1D;
  private config: OneEuroFilterConfig;
  private lastFilteredX: number | null = null;
  private lastFilteredY: number | null = null;
  private lastTimestamp: number | null = null;
  private currentVelocity: number = 0;
  private isFixated: boolean = false;

  constructor(customConfig?: Partial<OneEuroFilterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...customConfig };
    this.filterX = new OneEuroFilter1D(this.config.minCutoff, this.config.beta, this.config.dCutoff);
    this.filterY = new OneEuroFilter1D(this.config.minCutoff, this.config.beta, this.config.dCutoff);
  }

  public updateConfig(newConfig: Partial<OneEuroFilterConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.filterX = new OneEuroFilter1D(this.config.minCutoff, this.config.beta, this.config.dCutoff);
    this.filterY = new OneEuroFilter1D(this.config.minCutoff, this.config.beta, this.config.dCutoff);
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

    // Distancia euclidiana respecto a la última posición filtrada
    const dist = Math.hypot(rawX - this.lastFilteredX, rawY - this.lastFilteredY);
    this.currentVelocity = dist / dt; // px/s

    // 1. Detección de Movimiento Sacádico (salto rápido ocular)
    if (this.currentVelocity > this.config.saccadeThreshold || dist > this.config.deadzone * 4) {
      // Movimiento sacádico: suprimir filtro para respuesta sin retraso visual
      this.isFixated = false;
      this.filterX.reset();
      this.filterY.reset();
      const directX = this.filterX.filter(rawX, timestamp);
      const directY = this.filterY.filter(rawY, timestamp);
      this.lastFilteredX = directX;
      this.lastFilteredY = directY;
      return { x: directX, y: directY, isFixated: false, velocity: this.currentVelocity };
    }

    // 2. Detección de Zona Muerta (Anti-Jitter para micro-sacadas / nistagmo involuntario)
    if (dist < this.config.deadzone && this.currentVelocity < 180) {
      this.isFixated = true;
      // Mantener posición bloqueada suavemente
      return {
        x: this.lastFilteredX,
        y: this.lastFilteredY,
        isFixated: true,
        velocity: this.currentVelocity
      };
    }

    // 3. Fijación o movimiento suave: aplicar One Euro Filter
    this.isFixated = this.currentVelocity < 120;
    const filteredX = this.filterX.filter(rawX, timestamp);
    const filteredY = this.filterY.filter(rawY, timestamp);

    this.lastFilteredX = filteredX;
    this.lastFilteredY = filteredY;

    return {
      x: filteredX,
      y: filteredY,
      isFixated: this.isFixated,
      velocity: this.currentVelocity
    };
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
