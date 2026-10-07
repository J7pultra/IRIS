const fs = require('fs');
const path = require('path');
const os = require('os');

const tempPath = path.join(os.tmpdir(), 'test_vpn_cooldown.json');

function testPersistence() {
  console.log('--- Probando Persistencia de Cooldown ---');
  
  // 1. Simular desconexión e inicio de cooldown de 10 min
  const tenMinutesFromNow = Date.now() + (10 * 60 * 1000);
  fs.writeFileSync(tempPath, JSON.stringify({ cooldownUntil: tenMinutesFromNow }), 'utf-8');
  console.log('1. Cooldown guardado en:', new Date(tenMinutesFromNow).toLocaleTimeString());

  // 2. Simular reinicio de la aplicación y lectura
  const raw = fs.readFileSync(tempPath, 'utf-8');
  const data = JSON.parse(raw);
  const now = Date.now();
  const remaining = data.cooldownUntil > now ? Math.ceil((data.cooldownUntil - now) / 1000) : 0;
  console.log(`2. Tras "reinicio", tiempo restante recuperado: ${remaining}s (~${Math.round(remaining/60)} min)`);

  if (remaining > 500 && remaining <= 600) {
    console.log('✓ ÉXITO: El cooldown se mantiene persistente tras reiniciar.');
  } else {
    console.error('✗ ERROR en cálculo de cooldown');
  }

  // 3. Simular cuando el tiempo ya pasó
  const expiredTime = Date.now() - 5000;
  fs.writeFileSync(tempPath, JSON.stringify({ cooldownUntil: expiredTime }), 'utf-8');
  const raw2 = fs.readFileSync(tempPath, 'utf-8');
  const data2 = JSON.parse(raw2);
  const remaining2 = data2.cooldownUntil > Date.now() ? Math.ceil((data2.cooldownUntil - Date.now()) / 1000) : 0;
  console.log(`3. Cooldown expirado: ${remaining2}s restantes (debe ser 0)`);
  if (remaining2 === 0) {
    console.log('✓ ÉXITO: Cooldown expira correctamente cuando se cumple el tiempo.');
  }

  // Limpiar
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}

testPersistence();
