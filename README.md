# IRIS (NavegadorBeta) 🚀

> **Lo mejor de ambos mundos:** La elegancia visual, minimalismo y herramientas de IA de **Will Browser** combinadas con la potencia de bajo nivel, bloqueo de red nativo, privacidad Tor y VPN integrada, soporte Widevine DRM e hibernación inteligente de pestañas.

---

## 🌟 Características Principales

### 🎨 1. Estética y Experiencia Visual
- **Paleta de Colores Dark Glassmorphism:**
  - Fondo principal: `#0d0d12`
  - Encabezados y pestañas activas: `#121218`
  - Tarjetas y popups: `#181820`
  - Bordes sutiles traslúcidos: `rgba(255, 255, 255, 0.06)`
- **Barra de Pestañas Flotante:** Pestañas redondeadas con favicons, drag-and-drop para reordenar, indicador de pestañas hibernadas (`💤`) y categorías por color.
- **Tarjetas Flotantes de Memoria en Vivo:** Al posar el cursor sobre cualquier pestaña, muestra su título, dominio y el **consumo exacto de memoria RAM en tiempo real**.
- **Omnibox con Candado SSL Dinámico:** Detección de seguridad HTTPS y selector de marcadores con estrella rápida.
- **Páginas Internas Nativas (`beta://`):**
  - `beta://nueva-pestana`: Pantalla de inicio con reloj, buscador web configurable (Google, DuckDuckGo, Bing), accesos rápidos y widget de telemetría de RAM.
  - `beta://ajustes`: Panel integral para configurar Gemini API Key, perfil de usuario, bloqueo de anuncios, hibernación y temas.
  - `beta://historial`: Línea de tiempo de visitas con búsqueda y limpieza rápida.
  - `beta://descargas`: Panel de descargas con barras de progreso, velocidad y apertura directa de archivos y carpetas.
  - `beta://mensajes-eliminados`: Visor del sistema espía *Ojo de Halcón*.

---

### 🧠 2. Inteligencia Artificial Nativa (Google Gemini)
- **Piloto IA (Panel Lateral Desplegable):** Chat contextual con Google Gemini (soporta Gemini 1.5 Flash y Gemini 2.0).
- **Acciones Rápidas con 1 Clic:**
  - 🔍 **Analizar esta página:** Extrae el contenido central de la pestaña activa y genera un resumen en viñetas.
  - 🎬 **Resumir video:** Extrae título, canal y descripción de videos de YouTube para explicar los puntos clave.
  - 🌐 **Traducir:** Traduce al español páginas en cualquier idioma preservando el sentido original.
- **Auto-Relleno Inteligente de Formularios:** Analiza campos de formularios y encuestas en la web activa y los completa automáticamente siguiendo tu perfil de usuario configurado.
- **Agrupación Mágica Semántica:** El botón mágico en la barra de pestañas clasifica tus pestañas abiertas por temática (*Trabajo, Ocio, Estudio, Redes*) y les asigna colores distintivos.

---

### ⚡ 3. Motor de Rendimiento, Seguridad y Privacidad
- **Bloqueador de Anuncios a Nivel de Red (uBlock Origin + Ghostery Engine):** Filtra peticiones publicitarias y rastreadores antes de que se descarguen sus bytes, ahorrando datos y acelerando la carga.
- **Privacidad y Red Tor / VPN Integrada:** Conexión segura y anonimizada a la red Onion y protocolos de proxy con un solo clic.
- **Prerenderizado Especulativo (0 ms):** Al pasar el ratón sobre un enlace, el navegador precarga la conexión y la página en segundo plano. Al hacer clic, la carga es instantánea.
- **Hibernación Inteligente de Pestañas:** Suspende pestañas en segundo plano descargando el DOM para liberar hasta un 70% de memoria RAM, restaurándolas sin perder la sesión al hacer clic.
- **Soporte Widevine DRM:** Permite reproducir contenido protegido en plataformas de streaming como Netflix, Spotify Web y Amazon Prime Video.
- **Media Sniffer & Descargador Segmentado a 4 Hilos:**
  - Detecta transmisiones de video en streaming (`.m3u8` HLS, `.mpd` DASH y `.mp4`).
  - Menú de descarga rápida en la barra de herramientas para bajar en 1080p, 720p, 480p o audio MP3.
- **"Ojo de Halcón" (Phantom Cache):** Intercepta y almacena mensajes y fotos eliminadas en WhatsApp Web e Instagram Web.

---

## 🛠️ Tecnologías Utilizadas

- **Núcleo de Escritorio:** Electron 31 + Node.js 22 + Chromium con arquitectura `WebContentsView`.
- **Lenguaje:** TypeScript 5.5 (Tipado estricto en Main, Preload y Renderer).
- **Frontend UI:** HTML5 semántico + CSS Vanilla Dark Glassmorphism puro.
- **Motor Adblock:** `@ghostery/adblocker-electron` + filtros integrados.
- **Descargas & Multimedia:** `yt-dlp-exec`, `ffmpeg-static`, `cross-fetch`.
- **Privacidad:** Demonio Tor integrado y túneles VPN multi-región.
- **IA:** Google Generative AI API (Gemini).

---

## 🚀 Instalación y Puesta en Marcha

### Prerrequisitos
- [Node.js](https://nodejs.org/) (versión 18 o superior recomendada)
- [Git](https://git-scm.com/)

### 1. Clonar el repositorio
```bash
git clone https://github.com/J7pultra/IRIS.git
cd IRIS
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Iniciar el navegador
```bash
npm run dev
# o bien:
npm start
```

> 💡 **En Windows:** También puedes ejecutar directamente el archivo `iniciar.bat`. Detectará si faltan paquetes, los instalará automáticamente y abrirá el navegador.

### 4. Generar binarios / instaladores de producción
```bash
# Instalador ejecutable estándar (.exe)
npm run dist

# Versión portable (.exe directo sin instalación)
npm run dist:portable
```
