const { app, session, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  console.log('Testing proxy connection in Electron session...');
  
  // Set proxy to verified DE proxy
  await session.defaultSession.setProxy({
    proxyRules: 'http://162.55.44.32:6052',
    proxyBypassRules: '<local>'
  });

  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
  try {
    console.log('Loading https://api.ipify.org?format=json...');
    await win.loadURL('https://api.ipify.org?format=json');
    const text = await win.webContents.executeJavaScript('document.body.innerText');
    console.log('Result through Electron proxy:', text);
  } catch (e) {
    console.log('Error loading through proxy:', e.message);
  } finally {
    win.destroy();
    app.quit();
  }
});
