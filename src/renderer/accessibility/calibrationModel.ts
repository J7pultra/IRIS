/**
 * calibrationModel.ts
 *
 * Modelo matemático de regresión polinomial 2D y calibración de mirada ocular.
 * Mapea las coordenadas normalizadas del iris (eye_x, eye_y) a la resolución nativa
 * del monitor (screen_x, screen_y) a partir de los 9 puntos de fijación de la matriz activa.
 */

export interface CalibrationPointSample {
  eyeX: number;       // Iris normalizado X [0.0 - 1.0]
  eyeY: number;       // Iris normalizado Y [0.0 - 1.0]
  screenX: number;    // Píxel de pantalla X
  screenY: number;    // Píxel de pantalla Y
}

export interface CalibrationModelData {
  coeffX: number[];   // [c0, c1, c2, c3, c4, c5] para X
  coeffY: number[];   // [c0, c1, c2, c3, c4, c5] para Y
  screenWidth: number;
  screenHeight: number;
  residualError: number;
  points: CalibrationPointSample[];
  meanX?: number;
  stdX?: number;
  meanY?: number;
  stdY?: number;
}

export class CalibrationModel {
  private data: CalibrationModelData | null = null;

  constructor(savedModel?: CalibrationModelData | null) {
    if (savedModel && savedModel.coeffX && savedModel.coeffY) {
      this.data = savedModel;
    }
  }

  public isCalibrated(): boolean {
    return this.data !== null && this.data.coeffX.length >= 3 && this.data.coeffY.length >= 3;
  }

  public getModelData(): CalibrationModelData | null {
    return this.data;
  }

  /**
   * Ajusta un modelo de regresión robusto con estandarización Z-score y regularización Ridge:
   * x_screen = c0 + c1*x_norm + c2*y_norm + c3*x_norm^2 + c4*y_norm^2 + c5*x_norm*y_norm
   * y_screen = d0 + d1*x_norm + d2*y_norm + d3*x_norm^2 + d4*y_norm^2 + d5*x_norm*y_norm
   */
  public fit(samples: CalibrationPointSample[], screenWidth: number, screenHeight: number): boolean {
    if (samples.length < 5) {
      console.warn('[CalibrationModel] Se requieren al menos 5 puntos para ajuste.');
      return false;
    }

    const n = samples.length;

    // 1. Calcular media y desviación estándar de coordenadas oculares para centrado
    let sumX = 0;
    let sumY = 0;
    for (const s of samples) {
      sumX += s.eyeX;
      sumY += s.eyeY;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;

    let varX = 0;
    let varY = 0;
    for (const s of samples) {
      varX += (s.eyeX - meanX) ** 2;
      varY += (s.eyeY - meanY) ** 2;
    }
    // Desviación estándar mínima para evitar división por cero
    const stdX = Math.max(Math.sqrt(varX / n), 0.008);
    const stdY = Math.max(Math.sqrt(varY / n), 0.008);

    // 2. Construir matriz de diseño estandarizada A (n x 6)
    const m = 6;
    const A: number[][] = [];
    const bx: number[] = [];
    const by: number[] = [];

    for (let i = 0; i < n; i++) {
      const zx = (samples[i].eyeX - meanX) / stdX;
      const zy = (samples[i].eyeY - meanY) / stdY;

      // Términos: 1, zx, zy, zx^2, zy^2, zx*zy
      A.push([1.0, zx, zy, zx * zx * 0.5, zy * zy * 0.5, zx * zy * 0.5]);
      bx.push(samples[i].screenX);
      by.push(samples[i].screenY);
    }

    // 3. Ecuaciones normales con regularización Ridge de Tikhonov: (A^T * A + lambda * I) * c = A^T * b
    const AtA: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
    const AtBx: number[] = new Array(m).fill(0);
    const AtBy: number[] = new Array(m).fill(0);

    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += A[k][i] * A[k][j];
        }
        AtA[i][j] = sum;
      }

      let sumBx = 0;
      let sumBy = 0;
      for (let k = 0; k < n; k++) {
        sumBx += A[k][i] * bx[k];
        sumBy += A[k][i] * by[k];
      }
      AtBx[i] = sumBx;
      AtBy[i] = sumBy;
    }

    // Amortiguación Ridge: regularizar más los términos cuadráticos para evitar aberraciones en los bordes
    const ridgeScale = Math.max(0.1, AtA[0][0] * 0.02);
    AtA[0][0] += ridgeScale * 0.01;
    AtA[1][1] += ridgeScale * 0.10; // lineal X
    AtA[2][2] += ridgeScale * 0.10; // lineal Y
    AtA[3][3] += ridgeScale * 0.80; // cuadrático X amortiguado
    AtA[4][4] += ridgeScale * 0.80; // cuadrático Y amortiguado
    AtA[5][5] += ridgeScale * 0.80; // producto cruzado amortiguado

    let coeffX = this.solveLinearSystem(AtA, AtBx);
    let coeffY = this.solveLinearSystem(AtA, AtBy);

    if (!coeffX || !coeffY) {
      // Fallback a modelo afín lineal robusto
      return this.fitAffineFallback(samples, screenWidth, screenHeight, meanX, meanY, stdX, stdY);
    }

    // 4. Calcular error residual
    let totalError = 0;
    for (const sample of samples) {
      const zx = (sample.eyeX - meanX) / stdX;
      const zy = (sample.eyeY - meanY) / stdY;
      const pred = this.evaluatePolynomial(coeffX, coeffY, zx, zy);
      const err = Math.hypot(pred.x - sample.screenX, pred.y - sample.screenY);
      totalError += err;
    }
    const residualError = totalError / n;

    this.data = {
      coeffX,
      coeffY,
      screenWidth,
      screenHeight,
      residualError,
      points: samples,
      meanX,
      stdX,
      meanY,
      stdY
    };

    return true;
  }

  /**
   * Mapea coordenadas del iris normalizado a coordenadas en pantalla
   */
  public predict(
    eyeX: number,
    eyeY: number,
    currentWidth: number,
    currentHeight: number,
    sensitivityX: number = 1.0,
    sensitivityY: number = 1.0
  ): { x: number; y: number } {
    if (!this.data) {
      // Mapeo proporcional directo si no está calibrado
      const directX = (1.0 - eyeX) * currentWidth;
      const directY = eyeY * currentHeight;
      return {
        x: Math.max(0, Math.min(currentWidth, directX)),
        y: Math.max(0, Math.min(currentHeight, directY))
      };
    }

    // Normalizar respecto a la media y escala aprendidas en calibración
    const meanX = this.data.meanX ?? 0.50;
    const stdX = this.data.stdX ?? 0.05;
    const meanY = this.data.meanY ?? 0.50;
    const stdY = this.data.stdY ?? 0.05;

    // Limitar z-score a [-3.5, 3.5] para evitar que anomalías extremas disparen el cursor fuera de pantalla
    const zx = Math.max(-3.5, Math.min(3.5, (eyeX - meanX) / stdX));
    const zy = Math.max(-3.5, Math.min(3.5, (eyeY - meanY) / stdY));

    let { x, y } = this.evaluatePolynomial(this.data.coeffX, this.data.coeffY, zx, zy);

    // Escalar si el tamaño de pantalla actual difiere del tamaño de calibración
    if (this.data.screenWidth > 0 && this.data.screenHeight > 0) {
      x = (x / this.data.screenWidth) * currentWidth;
      y = (y / this.data.screenHeight) * currentHeight;
    }

    // Aplicar sensibilidad suave desde el centro de la pantalla
    if (sensitivityX !== 1.0 || sensitivityY !== 1.0) {
      const centerX = currentWidth / 2;
      const centerY = currentHeight / 2;
      x = centerX + (x - centerX) * sensitivityX;
      y = centerY + (y - centerY) * sensitivityY;
    }

    return {
      x: Math.max(0, Math.min(currentWidth, x)),
      y: Math.max(0, Math.min(currentHeight, y))
    };
  }

  private evaluatePolynomial(coeffX: number[], coeffY: number[], zx: number, zy: number): { x: number; y: number } {
    const terms = [1.0, zx, zy, zx * zx * 0.5, zy * zy * 0.5, zx * zy * 0.5];
    let px = 0;
    let py = 0;
    for (let i = 0; i < coeffX.length && i < terms.length; i++) {
      px += coeffX[i] * terms[i];
      py += coeffY[i] * terms[i];
    }
    return { x: px, y: py };
  }

  /**
   * Resolución de sistema lineal Ax = b mediante eliminación Gaussiana con pivoteo parcial
   */
  private solveLinearSystem(A_orig: number[][], b_orig: number[]): number[] | null {
    const n = b_orig.length;
    const A: number[][] = A_orig.map(row => [...row]);
    const b: number[] = [...b_orig];

    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) {
          maxRow = k;
        }
      }

      if (Math.abs(A[maxRow][i]) < 1e-12) {
        return null; // Matriz singular
      }

      const tempRow = A[i];
      A[i] = A[maxRow];
      A[maxRow] = tempRow;
      const tempB = b[i];
      b[i] = b[maxRow];
      b[maxRow] = tempB;

      for (let k = i + 1; k < n; k++) {
        const factor = A[k][i] / A[i][i];
        for (let j = i; j < n; j++) {
          A[k][j] -= factor * A[i][j];
        }
        b[k] -= factor * b[i];
      }
    }

    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = b[i];
      for (let j = i + 1; j < n; j++) {
        sum -= A[i][j] * x[j];
      }
      x[i] = sum / A[i][i];
    }

    return x;
  }

  private fitAffineFallback(
    samples: CalibrationPointSample[],
    screenWidth: number,
    screenHeight: number,
    meanX: number,
    meanY: number,
    stdX: number,
    stdY: number
  ): boolean {
    const n = samples.length;
    const m = 3; // [1, zx, zy]
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

    // Regularización Ridge
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
