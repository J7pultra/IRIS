/**
 * gazeOverlay.ts
 *
 * Interfaz Visual del Cursor Accesible (Halo Visual SVG) y Motor de Clics
 * por Fijación (Dwell Click) y Parpadeo (Blink Click) para NavegadorBeta.
 */

import { AccessibilityEventBus, AccessibilityClickEvent } from './accessibilityEventBus';

export interface GazeOverlayOptions {
  dwellTime?: number;      // Tiempo en ms para completar clic por fijación (default: 1000ms)
  dwellRadius?: number;    // Radio de tolerancia en px (default: 30px)
  cooldown?: number;       // Tiempo de enfriamiento post-clic en ms (default: 500ms)
  haloRadius?: number;     // Radio visual del halo en px (default: 26px)
  showTrail?: boolean;     // Estela suave de seguimiento
}

export class GazeOverlay {
  private container: HTMLDivElement | null = null;
  private svgRing: SVGCircleElement | null = null;
  private centerDot: SVGCircleElement | null = null;
  private pulseCircle: SVGCircleElement | null = null;

  private currentX: number = window.innerWidth / 2;
  private currentY: number = window.innerHeight / 2;

  // Mecánica de Dwell Click
  private dwellCenterX: number = 0;
  private dwellCenterY: number = 0;
  private dwellStartTime: number = 0;
  private isDwelling: boolean = false;
  private lastClickTime: number = 0;

  // Configuración
  private dwellTime: number = 1000;
  private dwellRadius: number = 30;
  private cooldown: number = 500;
  private haloRadius: number = 26;
  private circumference: number = 2 * Math.PI * 26;

  private bus: AccessibilityEventBus;
  private unsubscribers: (() => void)[] = [];
  private isDestroyed: boolean = false;

  constructor(options?: GazeOverlayOptions) {
    this.bus = AccessibilityEventBus.getInstance();
    if (options) {
      if (options.dwellTime !== undefined) this.dwellTime = options.dwellTime;
      if (options.dwellRadius !== undefined) this.dwellRadius = options.dwellRadius;
      if (options.cooldown !== undefined) this.cooldown = options.cooldown;
      if (options.haloRadius !== undefined) {
        this.haloRadius = options.haloRadius;
        this.circumference = 2 * Math.PI * this.haloRadius;
      }
    }

    this.createDomOverlay();
    this.bindEvents();
  }

  public updateConfig(options: Partial<GazeOverlayOptions>): void {
    if (options.dwellTime !== undefined) this.dwellTime = options.dwellTime;
    if (options.dwellRadius !== undefined) this.dwellRadius = options.dwellRadius;
    if (options.cooldown !== undefined) this.cooldown = options.cooldown;
  }

  /**
   * Crea el puntero SVG semi-transparente flotante
   */
  private createDomOverlay(): void {
    if (typeof document === 'undefined') return;

    // Remover anterior si existía
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
      transition: opacity 0.2s ease;
      opacity: 0.95;
    `;

    const svgSize = this.haloRadius * 2 + 16;
    const center = svgSize / 2;

    this.container.innerHTML = `
      <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}" style="overflow: visible; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.45));">
        <!-- Anillo de fondo translúcido -->
        <circle
          cx="${center}"
          cy="${center}"
          r="${this.haloRadius}"
          fill="rgba(56, 189, 248, 0.08)"
          stroke="rgba(255, 255, 255, 0.3)"
          stroke-width="2"
        />

        <!-- Anillo de carga radial (360° dwell progress) -->
        <circle
          id="gaze-dwell-progress-ring"
          cx="${center}"
          cy="${center}"
          r="${this.haloRadius}"
          fill="none"
          stroke="url(#gazeGlowGradient)"
          stroke-width="3.5"
          stroke-linecap="round"
          stroke-dasharray="${this.circumference}"
          stroke-dashoffset="${this.circumference}"
          transform="rotate(-90 ${center} ${center})"
        />

        <!-- Pulso de animación de clic -->
        <circle
          id="gaze-click-pulse"
          cx="${center}"
          cy="${center}"
          r="${this.haloRadius}"
          fill="none"
          stroke="#38bdf8"
          stroke-width="0"
          opacity="0"
        />

        <!-- Punto central de precisión (iris target) -->
        <circle
          id="gaze-center-dot"
          cx="${center}"
          cy="${center}"
          r="3.5"
          fill="#38bdf8"
          stroke="#ffffff"
          stroke-width="1.5"
        />

        <defs>
          <linearGradient id="gazeGlowGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8" />
            <stop offset="50%" stop-color="#818cf8" />
            <stop offset="100%" stop-color="#a855f7" />
          </linearGradient>
        </defs>
      </svg>
    `;

    document.documentElement.appendChild(this.container);

    this.svgRing = this.container.querySelector('#gaze-dwell-progress-ring');
    this.centerDot = this.container.querySelector('#gaze-center-dot');
    this.pulseCircle = this.container.querySelector('#gaze-click-pulse');
  }

  /**
   * Conecta los eventos del bus de accesibilidad
   */
  private bindEvents(): void {
    // 1. Movimiento de mirada
    const un1 = this.bus.on('gaze-pos', (data: any) => {
      this.updatePosition(data.x, data.y, data);
    });

    // 2. Clic disparado por voz o por otro módulo
    const un2 = this.bus.on('click', (event: AccessibilityClickEvent) => {
      const clickX = event.x !== undefined ? event.x : this.currentX;
      const clickY = event.y !== undefined ? event.y : this.currentY;
      this.triggerVisualClick(clickX, clickY);

      // Si el evento no proviene de dwell local, ejecutar el clic en el DOM
      if (event.source !== 'gaze-dwell') {
        this.performDomClick(clickX, clickY, event.button || 'left');
      }
    });

    // 3. Desplazamiento por voz o comando
    const un3 = this.bus.on('scroll', (data: any) => {
      this.performScroll(data.direction, data.amount || 320);
    });

    this.unsubscribers.push(un1, un2, un3);
  }

  /**
   * Actualiza la posición del cursor en pantalla y calcula el Dwell Time
   */
  public updatePosition(x: number, y: number, data?: any): void {
    if (this.isDestroyed || !this.container) return;

    this.currentX = x;
    this.currentY = y;

    const offset = this.haloRadius + 8;
    this.container.style.transform = `translate3d(${x - offset}px, ${y - offset}px, 0)`;

    const now = performance.now();

    // Comprobar período de enfriamiento post-clic
    if (now - this.lastClickTime < this.cooldown) {
      this.resetDwell();
      return;
    }

    // Si los ojos están cerrados, parpadeando o no hay rostro: detener dwell inmediatamente
    if (data?.isBlinking || (data?.ear !== undefined && data.ear < 0.20) || data?.faceFound === false) {
      this.resetDwell();
      return;
    }

    // Comprobar si el usuario se mantiene dentro del radio de tolerancia
    const dist = Math.hypot(x - this.dwellCenterX, y - this.dwellCenterY);

    if (dist <= this.dwellRadius) {
      if (!this.isDwelling) {
        this.isDwelling = true;
        this.dwellStartTime = now;
        this.bus.emit('dwell-start', { x, y });
      }

      const elapsed = now - this.dwellStartTime;
      const progress = Math.min(elapsed / this.dwellTime, 1.0);

      // Actualizar el anillo radial SVG
      if (this.svgRing) {
        const offsetVal = this.circumference * (1.0 - progress);
        this.svgRing.style.strokeDashoffset = `${offsetVal}`;
      }

      this.bus.emit('dwell-progress', { progress, x, y, dwellTime: this.dwellTime });

      // Clic por Fijación alcanzado
      if (progress >= 1.0) {
        this.executeDwellClick(x, y);
      }
    } else {
      // Fuera del radio de tolerancia: reiniciar dwell en la nueva ubicación
      this.dwellCenterX = x;
      this.dwellCenterY = y;
      this.resetDwell();
    }
  }

  private resetDwell(): void {
    this.isDwelling = false;
    this.dwellStartTime = performance.now();
    if (this.svgRing) {
      this.svgRing.style.strokeDashoffset = `${this.circumference}`;
    }
  }

  /**
   * Ejecuta el clic por fijación en el DOM
   */
  private executeDwellClick(x: number, y: number): void {
    this.lastClickTime = performance.now();
    this.resetDwell();

    // 1. Animación visual de clic
    this.triggerVisualClick(x, y);

    // 2. Notificar en el bus
    this.bus.emit('dwell-click', { x, y });
    this.bus.broadcast('click', { x, y, source: 'gaze-dwell' });

    // 3. Ejecutar eventos del mouse en el DOM
    this.performDomClick(x, y, 'left');
  }

  /**
   * Animación visual de pulso / onda de clic
   */
  public triggerVisualClick(x: number, y: number): void {
    if (!this.pulseCircle) return;

    this.pulseCircle.setAttribute('stroke-width', '4');
    this.pulseCircle.setAttribute('opacity', '1');
    this.pulseCircle.setAttribute('r', `${this.haloRadius}`);

    let step = 0;
    const animate = () => {
      step++;
      const r = this.haloRadius + step * 2.2;
      const opacity = 1.0 - step / 12;
      if (this.pulseCircle) {
        this.pulseCircle.setAttribute('r', `${r}`);
        this.pulseCircle.setAttribute('opacity', `${Math.max(0, opacity)}`);
      }
      if (step < 12) {
        requestAnimationFrame(animate);
      } else if (this.pulseCircle) {
        this.pulseCircle.setAttribute('opacity', '0');
        this.pulseCircle.setAttribute('stroke-width', '0');
      }
    };
    requestAnimationFrame(animate);

    // Feedback táctil/auditivo suave si está habilitado
    this.playSoftChime();
  }

  /**
   * Despacha el ciclo completo de eventos de ratón en el elemento bajo el centroide:
   * pointerdown -> mousedown -> pointerup -> mouseup -> click
   */
  private performDomClick(x: number, y: number, buttonName: 'left' | 'right' | 'middle' = 'left'): void {
    if (typeof document === 'undefined') return;

    // Temporalmente ocultar el overlay para asegurar elementFromPoint exacto
    if (this.container) this.container.style.display = 'none';
    const target = document.elementFromPoint(x, y) as HTMLElement;
    if (this.container) this.container.style.display = 'block';

    if (!target) return;

    const buttonCode = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0;
    const mouseInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: buttonCode,
      buttons: buttonCode === 0 ? 1 : buttonCode === 2 ? 2 : 4
    };

    try {
      target.dispatchEvent(new PointerEvent('pointerdown', mouseInit));
      target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
      target.dispatchEvent(new PointerEvent('pointerup', mouseInit));
      target.dispatchEvent(new MouseEvent('mouseup', mouseInit));
      target.dispatchEvent(new MouseEvent('click', mouseInit));

      // Enfocar elementos interactivos si es un input o enlace
      if (target.focus && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        target.focus();
      }

      // Si es un tag <a> o botón con href
      const anchor = target.closest('a');
      if (anchor && anchor.href && !anchor.href.startsWith('javascript:')) {
        anchor.click();
      }
    } catch (e) {
      console.warn('[GazeOverlay] Error disparando click sintético:', e);
    }
  }

  private performScroll(direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom', amount: number): void {
    if (typeof window === 'undefined') return;

    switch (direction) {
      case 'down':
        window.scrollBy({ top: amount, behavior: 'smooth' });
        break;
      case 'up':
        window.scrollBy({ top: -amount, behavior: 'smooth' });
        break;
      case 'top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        break;
    }
  }

  private playSoftChime(): void {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880.0, ctx.currentTime + 0.08); // A5

      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.13);
    } catch {}
  }

  /**
   * Destruye el overlay y desuscribe listeners
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.unsubscribers.forEach(un => un());
    this.unsubscribers = [];

    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.svgRing = null;
    this.centerDot = null;
    this.pulseCircle = null;
  }
}
