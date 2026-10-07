const fs = require('fs');
const path = require('path');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. Ensure output directories
fs.mkdirSync('dist/renderer', { recursive: true });
fs.mkdirSync('dist/inject', { recursive: true });
fs.mkdirSync('dist/assets', { recursive: true });

// 2. Copy renderer HTML & CSS files
if (fs.existsSync('src/renderer')) {
  const rendererFiles = fs.readdirSync('src/renderer');
  for (const file of rendererFiles) {
    if (file.endsWith('.html') || file.endsWith('.css') || file.endsWith('.svg') || file.endsWith('.png') || file.endsWith('.js')) {
      fs.copyFileSync(path.join('src/renderer', file), path.join('dist/renderer', file));
    }
  }
}

// 3. Copy internal pages if any
if (fs.existsSync('src/renderer/pages')) {
  copyDirRecursive('src/renderer/pages', 'dist/renderer/pages');
}

// 4. Copy inject scripts (e.g. phantom_cache.js)
if (fs.existsSync('src/inject')) {
  copyDirRecursive('src/inject', 'dist/inject');
}

// 5. Copy assets
if (fs.existsSync('assets')) {
  copyDirRecursive('assets', 'dist/assets');
}

console.log('[Assets] Static assets successfully copied to dist/ ✓');
