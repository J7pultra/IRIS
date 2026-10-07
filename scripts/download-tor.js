const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  console.log('[Tor Installer] Buscando versiones disponibles en dist.torproject.org...');
  try {
    const res = await fetch('https://dist.torproject.org/torbrowser/');
    const html = await res.text();
    const regex = /href="(\d+\.\d+(?:\.\d+)?)\/"/g;
    const versions = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
      versions.push(match[1]);
    }
    console.log('[Tor Installer] Versiones encontradas:', versions.slice(-5));
    
    // Probar desde la más reciente hacia atrás
    for (let i = versions.length - 1; i >= 0; i--) {
      const ver = versions[i];
      const filename = `tor-expert-bundle-windows-x86_64-${ver}.tar.gz`;
      const url = `https://dist.torproject.org/torbrowser/${ver}/${filename}`;
      console.log(`[Tor Installer] Probando ${url}...`);

      try {
        const headRes = await fetch(url, { method: 'HEAD' });
        if (headRes.ok) {
          console.log(`[Tor Installer] Encontrado: ${url}`);
          const binDir = path.join(__dirname, '..', 'bin', 'tor');
          if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir, { recursive: true });
          }

          const tarGzPath = path.join(binDir, filename);
          console.log(`[Tor Installer] Descargando ${filename}...`);
          const fileRes = await fetch(url);
          const buffer = Buffer.from(await fileRes.arrayBuffer());
          fs.writeFileSync(tarGzPath, buffer);
          console.log(`[Tor Installer] Descarga completada (${(buffer.length / 1024 / 1024).toFixed(2)} MB). Descomprimiendo...`);

          execSync(`tar -xzf "${tarGzPath}" -C "${binDir}"`);
          console.log('[Tor Installer] Descompresión completada.');
          
          if (fs.existsSync(tarGzPath)) {
            fs.unlinkSync(tarGzPath);
          }

          // Verificar si tor.exe existe
          const torExe = path.join(binDir, 'tor', 'tor.exe');
          const rootTorExe = path.join(binDir, 'tor.exe');
          if (fs.existsSync(torExe)) {
            console.log(`[Tor Installer] tor.exe instalado con éxito en: ${torExe} ✓`);
            return;
          } else if (fs.existsSync(rootTorExe)) {
            console.log(`[Tor Installer] tor.exe instalado con éxito en: ${rootTorExe} ✓`);
            return;
          } else {
            console.log('[Tor Installer] Contenido de binDir:', fs.readdirSync(binDir));
          }
          return;
        }
      } catch (err) {
        console.warn(`[Tor Installer] Error probando versión ${ver}:`, err.message);
      }
    }
  } catch (e) {
    console.error('[Tor Installer] Error general:', e);
  }
}

main();
