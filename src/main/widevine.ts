import { app } from 'electron';

export class WidevineManager {
  public static initBeforeReady() {
    app.commandLine.appendSwitch('disable-features', 'WidevineVmp');
    app.commandLine.appendSwitch('no-sandbox');
  }

  public static async ensureWidevineReady() {
    try {
      console.log('[Widevine] Inicializando componente Widevine CDM para DRM...');
      if ((app as any).components && typeof (app as any).components.whenReady === 'function') {
        await (app as any).components.whenReady();
        console.log('[Widevine] CDM cargado correctamente ✓');
      } else {
        console.log('[Widevine] app.components listo.');
      }
    } catch (e) {
      console.error('[Widevine] Error inicializando CDM:', e);
    }
  }
}
