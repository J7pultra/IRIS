import * as os from 'os';

export type HardwareTier = 'LOW' | 'MID' | 'HIGH';

export interface HardwareProfile {
  tier: HardwareTier;
  hibernationIdleTimeMs: number; // MS before tab is suspended
  sharpQuality: number; // WebP compression quality
  maxParallelDownloads: number; // Chromium parallel download threads
}

let profile: HardwareProfile | null = null;

export function detectHardware(): HardwareProfile {
  if (profile) return profile;

  const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);
  const cpuCores = os.cpus().length;

  console.log(`[HardwareEngine] Detectado: ${cpuCores} Cores, ${totalMemGB.toFixed(2)} GB RAM`);

  if (totalMemGB >= 15.5 && cpuCores >= 8) {
    // Gama Alta
    profile = {
      tier: 'HIGH',
      hibernationIdleTimeMs: 15 * 60 * 1000, // 15 mins
      sharpQuality: 90,
      maxParallelDownloads: 10,
    };
  } else if (totalMemGB >= 7.5) {
    // Gama Media
    profile = {
      tier: 'MID',
      hibernationIdleTimeMs: 8 * 60 * 1000,  // 8 mins
      sharpQuality: 75,
      maxParallelDownloads: 5,
    };
  } else {
    // Gama Baja
    profile = {
      tier: 'LOW',
      hibernationIdleTimeMs: 3 * 60 * 1000,  // 3 mins
      sharpQuality: 60,
      maxParallelDownloads: 3,
    };
  }

  console.log(`[HardwareEngine] Perfil Asignado: ${profile.tier} (Calidad Sharp: ${profile.sharpQuality}, Hibernación: ${profile.hibernationIdleTimeMs / 60000}m)`);
  return profile;
}

export function getHardwareProfile(): HardwareProfile {
  return profile || detectHardware();
}
