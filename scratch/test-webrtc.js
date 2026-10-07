const { app, session, BrowserWindow, webContents } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false });
  console.log('webContents has setWebRTCIPHandlingPolicy?', typeof win.webContents.setWebRTCIPHandlingPolicy);
  console.log('session has setWebRTCIPHandlingPolicy?', typeof session.defaultSession.setWebRTCIPHandlingPolicy);
  win.destroy();
  app.quit();
});
