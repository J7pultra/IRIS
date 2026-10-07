import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { app, Session } from 'electron';

export type HardwareTier = 1 | 2 | 3;

export interface PerformanceProfile {
  tier: HardwareTier;
  dynamicModeEnabled: boolean;
  cpuCores: number;
  totalRamGB: number;
  gpuName?: string;
  isDiscreteGpu?: boolean;
}

export class HardwareEngine {
  private static profilePath = path.join(app.getPath('userData'), 'shield_perf.json');
  private static activeProfile: PerformanceProfile | null = null;

  /**
   * Fase 1 (Síncrona): Ejecutada ANTES de app.whenReady() para inyectar flags de C++.
   */
  static applyBootSwitches(): void {
    let profile = HardwareEngine.readSyncProfile();

    if (!profile) {
      // Perfil provisional básico (Boot inicial)
      const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
      const cpuCores = os.cpus().length;
      let tempTier: HardwareTier = 1;
      if (totalMemGB >= 15.5 && cpuCores >= 8) tempTier = 3;
      else if (totalMemGB >= 7.5 && cpuCores >= 4) tempTier = 2;

      profile = {
        tier: tempTier,
        dynamicModeEnabled: true, // Default ON
        cpuCores,
        totalRamGB: totalMemGB
      };
      HardwareEngine.saveSyncProfile(profile);
    }

    HardwareEngine.activeProfile = profile;

    if (!profile.dynamicModeEnabled) {
      console.log('[HardwareEngine] Dynamic Mode DESACTIVADO. Fallback a Chromium estándar.');
      return; // Fallback gracefully
    }

    console.log(`[HardwareEngine] Aplicando flags de aceleración nativa para Tier ${profile.tier}...`);

    app.commandLine.appendSwitch('disable-gpu-watchdog');
    app.commandLine.appendSwitch('disable-accelerated-video-encode');

    if (profile.tier === 3) {
      // Tier 3: Aceleración GPU completa y estable (Direct3D11 / Chromium nativo)
      app.commandLine.appendSwitch('enable-gpu-rasterization');
      app.commandLine.appendSwitch('enable-accelerated-video-decode');
      app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
      app.commandLine.appendSwitch('enable-zero-copy');
      app.commandLine.appendSwitch('ignore-gpu-blocklist');
      app.commandLine.appendSwitch('enable-quic');
    } else if (profile.tier === 2) {
      // Tier 2: Aceleración estándar
      app.commandLine.appendSwitch('enable-gpu-rasterization');
      app.commandLine.appendSwitch('enable-accelerated-video-decode');
      app.commandLine.appendSwitch('enable-zero-copy');
    } else if (profile.tier === 1) {
      // Tier 1: Estabilidad, priorizar RAM y batería
      app.commandLine.appendSwitch('disable-gpu-rasterization');
    }
  }

  /**
   * Fase 2 (Asíncrona): Ejecutada DESPUÉS de app.whenReady() para escanear la GPU real.
   */
  static async runAsyncProfiler(): Promise<void> {
    console.log('[HardwareEngine] Iniciando Deep Profiler diferido en segundo plano...');
    try {
      const gpuInfo: any = await app.getGPUInfo('complete');
      const gpuDevice = gpuInfo?.gpuDevice?.[0]; // GPU Primaria
      
      let isDiscrete = false;
      let gpuName = 'Unknown';
      
      if (gpuDevice) {
        gpuName = gpuDevice.vendorString || 'Unknown GPU';
        // Detección heurística de gráfica dedicada vs integrada
        isDiscrete = gpuName.toLowerCase().includes('nvidia') || 
                     gpuName.toLowerCase().includes('radeon') ||
                     gpuName.toLowerCase().includes('rtx') ||
                     gpuName.toLowerCase().includes('gtx');
      }

      const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
      const cpuCores = os.cpus().length;

      let finalTier: HardwareTier = 1;
      if (totalMemGB >= 15.5 && cpuCores >= 6 && isDiscrete) {
        finalTier = 3;
      } else if (totalMemGB >= 7.5 && cpuCores >= 4) {
        finalTier = 2;
      }

      const currentProfile = HardwareEngine.activeProfile;
      const newProfile: PerformanceProfile = {
        tier: finalTier,
        dynamicModeEnabled: currentProfile?.dynamicModeEnabled ?? true,
        cpuCores,
        totalRamGB: totalMemGB,
        gpuName,
        isDiscreteGpu: isDiscrete
      };

      let hardwareChanged = false;

      // Evaluar cambios drásticos en el hardware usando tolerancias
      if (!currentProfile ||
          currentProfile.cpuCores !== newProfile.cpuCores ||
          Math.abs((currentProfile.totalRamGB || 0) - newProfile.totalRamGB) > 1.0 || 
          currentProfile.gpuName !== newProfile.gpuName ||
          currentProfile.tier !== newProfile.tier) {
         hardwareChanged = true;
      }

      if (hardwareChanged) {
        console.log(`[HardwareEngine] Cambio físico detectado. Actualizando caché silenciosamente al Tier ${finalTier}...`);
        HardwareEngine.saveSyncProfile(newProfile);
        HardwareEngine.activeProfile = newProfile;
      } else {
        console.log('[HardwareEngine] Hardware verificado en segundo plano. Sin cambios de infraestructura.');
      }
      
    } catch (err) {
      console.error('[HardwareEngine] Error obteniendo info de GPU:', err);
    }
  }

  /**
   * Pilar 3: Adapta la sesión de red dinámicamente.
   */
  static configureNetworkStack(sess: Session): void {
    const tier = HardwareEngine.activeProfile?.tier || 2;
    const isDynamic = HardwareEngine.activeProfile?.dynamicModeEnabled ?? true;

    if (!isDynamic) {
      // Fallback a default Electron settings (no limits changed)
      return;
    }

    if (tier === 3) {
      // 512MB RAM Cache, muy poca escritura a disco
      app.commandLine.appendSwitch('disk-cache-size', '10485760'); // 10MB (minimiza disco)
    } else if (tier === 1) {
      // 100MB Disk cache (libera RAM agresivamente)
      app.commandLine.appendSwitch('disk-cache-size', '104857600'); 
    }
  }

  static getProfile(): PerformanceProfile | null {
    return HardwareEngine.activeProfile;
  }

  static toggleDynamicMode(enabled: boolean): void {
    if (HardwareEngine.activeProfile) {
      HardwareEngine.activeProfile.dynamicModeEnabled = enabled;
      HardwareEngine.saveSyncProfile(HardwareEngine.activeProfile);
      console.log(`[HardwareEngine] Dynamic Mode cambiado a: ${enabled}`);
    }
  }

  // --- Helpers Locales ---
  
  private static readSyncProfile(): PerformanceProfile | null {
    try {
      if (fs.existsSync(HardwareEngine.profilePath)) {
        const data = fs.readFileSync(HardwareEngine.profilePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('[HardwareEngine] Error leyendo perfil:', e);
    }
    return null;
  }

  private static saveSyncProfile(profile: PerformanceProfile): void {
    try {
      fs.writeFileSync(HardwareEngine.profilePath, JSON.stringify(profile, null, 2), 'utf8');
    } catch (e) {
      console.error('[HardwareEngine] Error guardando perfil:', e);
    }
  }
}
