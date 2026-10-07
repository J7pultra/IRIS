const { app, session, BrowserWindow } = require('electron');
const { VpnService } = require('../dist/main/vpnService');

app.whenReady().then(async () => {
  console.log('--- TEST: CONEXIÓN VPN A ESTADOS UNIDOS ---');
  VpnService.init();

  const stateUS = await VpnService.connect('US');
  console.log('Estado US:', stateUS);

  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:beta-session' } });
  try {
    await win.loadURL('https://api.ipify.org?format=json');
    const text = await win.webContents.executeJavaScript('document.body.innerText');
    console.log('IP a través de VPN Estados Unidos:', text);
  } catch (e) {
    console.log('Error:', e.message);
  }

  await VpnService.disconnect();
  win.destroy();
  console.log('--- TEST FINALIZADO ---');
  app.quit();
});
