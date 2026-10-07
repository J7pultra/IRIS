const http = require('http');
const net = require('net');

async function testHttp(host, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request({
      host, port: parseInt(port), method: 'CONNECT', path: 'api.ipify.org:443', timeout: 2000
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ ok: res.statusCode === 200, ping: Date.now() - start });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

async function testSocks(host, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port: parseInt(port), timeout: 2000 }, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.once('data', (d) => {
      socket.destroy();
      resolve({ ok: d[0] === 5 && d[1] === 0, ping: Date.now() - start });
    });
    socket.on('error', () => resolve({ ok: false }));
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false }); });
  });
}

async function main() {
  console.log('Testing fast parallel handshake with candidates:');
  const candidates = [
    { host: '162.55.44.32', port: 6052, protocol: 'http', country: 'DE' },
    { host: '150.241.245.211', port: 8080, protocol: 'http', country: 'US' },
    { host: '13.90.182.199', port: 3001, protocol: 'socks5', country: 'US' },
    { host: '150.241.105.211', port: 3128, protocol: 'http', country: 'US' }
  ];

  const probes = candidates.map(async (c) => {
    const res = c.protocol === 'socks5' ? await testSocks(c.host, c.port) : await testHttp(c.host, c.port);
    return { ...c, ...res };
  });

  const results = await Promise.all(probes);
  const working = results.filter(r => r.ok).sort((a, b) => a.ping - b.ping);
  console.log('Results:', working);
  if (working.length > 0) {
    console.log('Winner:', working[0].country, working[0].host + ':' + working[0].port, 'ping:', working[0].ping + 'ms');
  }
}

main();
