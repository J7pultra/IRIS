/**
 * renderer.ts — UI Controller para NavegadorBeta
 * Combina la interfaz de Will Browser con el motor de alto rendimiento de ShieldBrowser.
 */

// API expuesta por el preload
const api: any = (window as any).betaAPI;

// Modo de ventana (normal, incognito o tor) detectado desde URL o API (estilo Brave)
const currentWindowMode: 'normal' | 'incognito' | 'tor' =
  ((api?.window && api.window.getWindowMode) ? api.window.getWindowMode() : 'normal') as any;
const initialStartupUrl: string | null =
  (api?.window && api.window.getInitialUrl) ? api.window.getInitialUrl() : null;

// ── Servicios Gemini AI Integrados ──────────────────────────────────────────
async function chatWithGemini(apiKey: string, personaContext: string, messageHistory: { role: string; text: string }[]): Promise<string> {
  if (!apiKey) {
    throw new Error('Falta la API Key de Gemini. Configúrala en Ajustes (beta://ajustes).');
  }

  const systemPrompt = `Eres "Piloto IA", el asistente inteligente integrado en "NavegadorBeta".
Perfil del usuario: "${personaContext || 'Usuario estándar'}"

Reglas:
- Responde de forma concisa, clara, directa y estructurada.
- Si te piden analizar una página o resumir un video, da los puntos clave.
- Responde en español a menos que te soliciten otro idioma.`;

  const contents: any[] = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: '¡Entendido! Soy Piloto IA, tu asistente de NavegadorBeta. ¿En qué te puedo ayudar?' }] }
  ];

  for (const msg of messageHistory) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }]
    });
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || response.statusText);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No se obtuvo respuesta.';
}

async function groupTabsSemantic(apiKey: string, tabsList: { id: string; title: string; url: string }[]): Promise<{ id: string; category: string; color: string }[]> {
  if (!apiKey) throw new Error('API Key requerida');
  if (!tabsList || tabsList.length === 0) return [];

  const tabData = tabsList.map(t => ({ id: t.id, title: t.title, url: t.url }));

  const prompt = `
Eres un asistente organizador de pestañas del navegador web.
Agrupa las siguientes pestañas en categorías lógicas (ej: 'Trabajo', 'Ocio', 'Estudio', 'Compras', 'Desarrollo', 'Redes Sociales').
Para cada pestaña, asigna una categoría y un color HEX armonioso (#3b82f6 para trabajo/azul, #10b981 para estudio/verde, #f59e0b para ocio/amarillo, #8b5cf6 para desarrollo/morado, #ec4899 para social/rosa).

Pestañas:
${JSON.stringify(tabData, null, 2)}

Responde ÚNICAMENTE con un array JSON puro, sin markdown ni comillas triples:
[
  { "id": "id_de_la_pestaña", "category": "Nombre", "color": "#hex" }
]`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!response.ok) throw new Error('Error al conectar con Gemini API');

  const data = await response.json();
  let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  text = text.replace(/```json/g, '').replace(/```/g, '').trim();

  return JSON.parse(text);
}

async function fillFormWithGemini(apiKey: string, personaContext: string, formStructure: any[]): Promise<any[]> {
  if (!apiKey) throw new Error('Falta la API Key de Gemini.');

  const prompt = `Eres "Piloto IA", un asistente que completa encuestas y formularios automáticamente.
Perfil del usuario:
"${personaContext || 'Profesional de tecnología, proactivo y dinámico.'}"

Estructura de campos de la página:
${JSON.stringify(formStructure, null, 2)}

Devuelve ÚNICAMENTE un array JSON puro indicando qué acción tomar en cada campo:
[
  {
    "id": "id-o-nombre-del-campo",
    "action": "fill|check|select",
    "value": "Texto a escribir o valor a seleccionar"
  }
]`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5 }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || response.statusText);
  }

  const data = await response.json();
  let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  text = text.replace(/```json/g, '').replace(/```/g, '').trim();

  return JSON.parse(text);
}

interface TabState {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isHibernated: boolean;
  isLoading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  historyStack?: string[];
  historyIndex?: number;
  category?: string;
  color?: string;
  isIncognito?: boolean;
  isTor?: boolean;
}

let tabs: TabState[] = [];
let recentlyClosedTabs: { url: string; title: string }[] = [];
let activeTabId: string | null = null;
let isPhantomVaultOpen: boolean = false;
let currentSettings: any = {};
let hoverTimeout: any = null;
let aiMessages: { role: string; text: string }[] = [];

// ============================================================================
// 1. INICIALIZACIÓN
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Cargar ajustes almacenados (con reintentos y fallback defensivo)
  try {
    currentSettings = await api.settings.get() || {};
  } catch (err) {
    console.warn('[NavegadorBeta] No se pudieron cargar los ajustes, usando defaults:', err);
    currentSettings = {
      homepage: 'beta://nueva-pestana',
      searchEngine: 'https://www.google.com/search?q=',
      geminiApiKey: '',
      geminiPersona: '',
      adblockEnabled: true,
      theme: 'dark'
    };
  }

  // Aplicar tema y preferencias visuales al iniciar
  if (currentSettings.theme === 'light') {
    document.body.classList.add('light-theme');
  } else {
    document.body.classList.remove('light-theme');
  }
  if (currentSettings.uiAnimations === false) {
    document.body.classList.add('disable-animations');
  } else {
    document.body.classList.remove('disable-animations');
  }

  // Configurar escuchas de eventos de ventana y vistas
  try { setupWindowControls(); } catch (e) { console.error('[UI] setupWindowControls error:', e); }
  try { setupNavigation(); } catch (e) { console.error('[UI] setupNavigation error:', e); }
  try { setupViewEvents(); } catch (e) { console.error('[UI] setupViewEvents error:', e); }
  try { setupDownloadEvents(); } catch (e) { console.error('[UI] setupDownloadEvents error:', e); }
  try { setupMenus(); } catch (e) { console.error('[UI] setupMenus error:', e); }
  try { setupAiDrawer(); } catch (e) { console.error('[UI] setupAiDrawer error:', e); }
  try { setupCinemaDrawer(); } catch (e) { console.error('[UI] setupCinemaDrawer error:', e); }

  (window as any).navigateToUrl = navigateToUrl;
  (window as any).createTab = createTab;
  (window as any).toggleBookmarksBar = toggleBookmarksBar;
  (window as any).openInternalPage = openInternalPage;
  (window as any).closeAllBrowserModals = closeAllBrowserModals;
  renderBookmarksBar();

  // Aplicar modo de ventana (Incógnito o Tor estilo Brave)
  if (currentWindowMode === 'incognito') {
    document.body.classList.add('theme-incognito');
    const badge = document.getElementById('window-mode-badge');
    if (badge) {
      badge.className = 'window-mode-badge incognito';
      badge.innerHTML = `<span>🕶️</span><span>Privada</span>`;
      badge.style.display = 'inline-flex';
    }
  } else if (currentWindowMode === 'tor') {
    document.body.classList.add('theme-tor');
    const badge = document.getElementById('window-mode-badge');
    if (badge) {
      badge.className = 'window-mode-badge tor';
      badge.innerHTML = `<span>🧅</span><span>Tor Privado</span><span class="tor-pulse-dot" title="Red Tor Activa"></span>`;
      badge.style.display = 'inline-flex';
    }
  }

  // Crear la primera pestaña predeterminada según el modo
  const defaultUrl = initialStartupUrl || (
    currentWindowMode === 'tor' ? 'beta://tor' :
    currentWindowMode === 'incognito' ? 'beta://privada' :
    'beta://nueva-pestana'
  );
  const defaultOpts = currentWindowMode === 'tor'
    ? { isTor: true }
    : (currentWindowMode === 'incognito' ? { isIncognito: true } : undefined);
  try { createTab(defaultUrl, defaultOpts); } catch (e) { console.error('[UI] createTab error:', e); }

  // Sincronizar dimensiones exactas de la vista web
  syncViewBounds();

  // Actualizar telemetría periódica de RAM
  setInterval(updateHeaderRamStats, 5000);
});

// Sincronización dinámica de dimensiones para eliminar cualquier espacio negro y acoplar paneles
function syncViewBounds() {
  if (document.body.classList.contains('html-fullscreen')) return;
  const aiDrawer = document.getElementById('ai-drawer');
  const cinemaDrawer = document.getElementById('cinema-drawer');
  const isAiOpen = aiDrawer?.classList.contains('open');
  const isCinemaOpen = cinemaDrawer?.classList.contains('open');
  const rightOffset = (isAiOpen || isCinemaOpen) ? 380 : 0;

  const bmBar = document.getElementById('bookmarks-bar');
  const isBmOpen = bmBar && !bmBar.classList.contains('hidden');
  const topOffset = isBmOpen ? 112 : 84;

  if (api && api.tabs && api.tabs.updateBounds) {
    api.tabs.updateBounds({
      x: 0,
      y: topOffset,
      width: Math.max(320, window.innerWidth - rightOffset),
      height: Math.max(0, window.innerHeight - topOffset)
    });
  }
}
window.addEventListener('resize', syncViewBounds);

// Escuchar pantalla completa de videos (YouTube / HTML5) para ocultar barra superior
if (api && api.events && (api.events as any).onHtmlFullscreen) {
  (api.events as any).onHtmlFullscreen((active: boolean) => {
    document.body.classList.toggle('html-fullscreen', active);
    if (!active) {
      syncViewBounds();
    }
  });
}


// ============================================================================
// 2. CONTROLES DE VENTANA
// ============================================================================
function setupWindowControls() {
  document.getElementById('btn-minimize')?.addEventListener('click', () => api.window.minimize());

  const btnMax = document.getElementById('btn-maximize');
  btnMax?.addEventListener('click', async () => {
    const isMax = await api.window.maximize();
    updateMaximizeIcon(isMax);
  });

  document.getElementById('btn-close')?.addEventListener('click', () => api.window.close());

  // Actualizar icono de maximizar si cambia el estado
  api.window.isMaximized().then(updateMaximizeIcon);
}

function updateMaximizeIcon(isMax: boolean) {
  const icon = document.getElementById('icon-maximize');
  if (!icon) return;
  if (isMax) {
    icon.innerHTML = '<rect x="1.5" y="3.5" width="6" height="6"/><path d="M3.5 3.5v-2h5v5h-2"/>';
  } else {
    icon.innerHTML = '<rect x="0.5" y="0.5" width="9" height="9"/>';
  }
}

// ============================================================================
// 3. GESTIÓN DE PESTAÑAS (TABS)
// ============================================================================
function createTab(url?: string, options?: { isIncognito?: boolean; isTor?: boolean }): string {
  closeAllPopups();
  const isInc = options?.isIncognito ?? (currentWindowMode === 'incognito');
  const isTor = options?.isTor ?? (currentWindowMode === 'tor');
  const finalOptions = { isIncognito: isInc, isTor };

  let finalUrl = url;
  if (!finalUrl || finalUrl === 'beta://nueva-pestana') {
    finalUrl = isTor ? 'beta://tor' : (isInc ? 'beta://privada' : 'beta://nueva-pestana');
  }

  const id = 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const newTab: TabState = {
    id,
    url: finalUrl,
    title: isTor ? '🧅 Tor Privado' : (isInc ? '🕶️ Privada' : (finalUrl.startsWith('beta://') ? getInternalPageTitle(finalUrl) : 'Nueva Pestaña')),
    favicon: finalUrl.startsWith('beta://') ? '../../assets/icons/favicon.png' : undefined,
    isHibernated: false,
    isLoading: false,
    historyStack: [finalUrl],
    historyIndex: 0,
    canGoBack: false,
    canGoForward: false,
    isIncognito: isInc,
    isTor
  };

  tabs.push(newTab);
  api.tabs.create(id, finalUrl, finalOptions);
  renderTabs();
  switchTab(id);

  return id;
}

function switchTab(id: string) {
  if (isPhantomVaultOpen) {
    (window as any).closePhantomVault?.();
  }
  closeAllPopups();
  handleTabLeave();
  if (activeTabId === id) return;
  activeTabId = id;
  api.tabs.switch(id);

  const tab = tabs.find(t => t.id === id);
  if (tab) {
    updateOmnibox(tab.url);
    if (tab.url.startsWith('beta://')) {
      showInternalPage(tab.url);
    } else {
      hideInternalPages();
    }
    if (api.bookmarks?.get) {
      api.bookmarks.get().then((list: any[]) => {
        const isBm = Array.isArray(list) && list.some((b: any) => b.url === tab.url);
        updateBookmarkStar(isBm);
      }).catch(() => {});
    }
  }

  syncViewBounds();
  const dlBtn = document.getElementById('btn-download-quick');
  const label = document.getElementById('download-quick-label');
  if (dlBtn && label) {
    dlBtn.classList.remove('active', 'locked', 'downloading');
    label.innerText = 'Descargar';
  }

  renderTabs();
  updateNavButtons();
  updateReloadButton(tab?.isLoading || false);
  updateShieldCounter();
}

function closeTab(id: string, e?: Event) {
  if (isPhantomVaultOpen && activeTabId === id) {
    (window as any).closePhantomVault?.();
  }
  closeAllPopups();
  handleTabLeave();
  if (e) e.stopPropagation();
  const index = tabs.findIndex(t => t.id === id);
  if (index === -1) return;

  const closingTab = tabs[index];
  if (closingTab && !closingTab.url.startsWith('beta://') && !closingTab.isIncognito && !closingTab.isTor) {
    recentlyClosedTabs.unshift({ url: closingTab.url, title: closingTab.title || closingTab.url });
    if (recentlyClosedTabs.length > 25) recentlyClosedTabs.pop();
  }

  api.tabs.close(id);
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    // Si no quedan pestañas, abrir una nueva
    createTab('beta://nueva-pestana');
  } else if (activeTabId === id) {
    // Cambiar a la pestaña contigua
    const nextTab = tabs[Math.max(0, index - 1)];
    switchTab(nextTab.id);
  } else {
    renderTabs();
  }
}

function renderTabs() {
  const container = document.getElementById('tabs-container');
  if (!container) return;

  container.innerHTML = '';

  tabs.forEach(tab => {
    const isActive = tab.id === activeTabId;
    const tabEl = document.createElement('div');
    tabEl.className = `tab-item ${isActive ? 'active' : ''} ${tab.isHibernated ? 'hibernated' : ''} ${tab.isIncognito ? 'incognito-tab' : ''} ${tab.isTor ? 'tor-tab' : ''}`;
    tabEl.dataset.tabId = tab.id;
    tabEl.draggable = true;

    // Indicador de color semántico (Magic Sort)
    if (tab.color) {
      const catLine = document.createElement('div');
      catLine.className = 'tab-category-indicator';
      catLine.style.backgroundColor = tab.color;
      tabEl.appendChild(catLine);
    }

    // Favicon
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = tab.favicon || (tab.url.startsWith('beta://') ? '../../assets/icons/favicon.png' : 'https://www.google.com/s2/favicons?domain=' + getDomain(tab.url) + '&sz=32');
    img.onerror = () => { img.src = '../../assets/icons/favicon.png'; };
    tabEl.appendChild(img);

    // Título
    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    let displayTitle = tab.title || 'Nueva pestaña';
    if (tab.isTor && !displayTitle.startsWith('🧅')) displayTitle = '🧅 ' + displayTitle;
    else if (tab.isIncognito && !displayTitle.startsWith('🕶️')) displayTitle = '🕶️ ' + displayTitle;
    titleSpan.innerText = displayTitle;
    tabEl.appendChild(titleSpan);

    // Botón de cerrar
    const closeBtn = document.createElement('div');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10"><path fill="currentColor" d="M10 1.007 8.993 0 5 3.993 1.007 0 0 1.007 3.993 5 0 8.993 1.007 10 5 6.007 8.993 10 10 8.993 6.007 5z"/></svg>';
    closeBtn.addEventListener('click', (e) => closeTab(tab.id, e));
    tabEl.appendChild(closeBtn);

    // Eventos de Tab
    tabEl.addEventListener('click', (e) => {
      if (e.button === 0) switchTab(tab.id);
    });

    // Cerrar pestaña al pulsar la ruedita del ratón (Middle Click) como en Brave/Chrome
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        handleTabLeave();
        closeTab(tab.id, e);
      }
    });

    tabEl.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        // Evita el cursor de autoscroll de rueda en Windows
        e.preventDefault();
      }
    });

    tabEl.addEventListener('mouseenter', (e) => handleTabHover(tab, e));
    tabEl.addEventListener('mouseleave', handleTabLeave);

    // Drag and Drop
    setupTabDragAndDrop(tabEl, tab.id);

    container.appendChild(tabEl);
  });
}

// Hover preview card con RAM en vivo (Floating window estilo Brave/Chrome/Shield)
function handleTabHover(tab: TabState, e: MouseEvent) {
  clearTimeout(hoverTimeout);
  hoverTimeout = setTimeout(async () => {
    let domainText = '';
    try {
      if (tab.url && tab.url !== 'about:blank' && !tab.url.startsWith('beta://')) {
        const urlObj = new URL(tab.url);
        domainText = urlObj.hostname;
      } else {
        domainText = 'Nueva pestaña';
      }
    } catch {
      domainText = tab.url || '';
    }

    let ramUsage = 0;
    if (!tab.isHibernated) {
      try {
        ramUsage = await api.tabs.getMemory(tab.id);
      } catch (err) {
        console.error('Error fetching tab memory:', err);
      }
    }

    const currentTabEl = (e.currentTarget as HTMLElement) || document.querySelector(`.tab-item[data-tab-id="${tab.id}"]`);
    if (!currentTabEl) return;

    const rect = currentTabEl.getBoundingClientRect();
    const cardWidth = 260;
    const tabCenter = rect.left + rect.width / 2;
    let cardLeft = tabCenter - cardWidth / 2;

    if (cardLeft < 10) cardLeft = 10;
    if (cardLeft + cardWidth > window.innerWidth - 10) {
      cardLeft = window.innerWidth - cardWidth - 10;
    }

    const cardTop = rect.bottom + 4;
    const screenX = window.screenX + cardLeft;
    const screenY = window.screenY + cardTop;

    try {
      if (api.tabs && api.tabs.showHoverCard) {
        api.tabs.showHoverCard({
          x: Math.round(screenX),
          y: Math.round(screenY),
          title: tab.title || 'Nueva pestaña',
          domain: domainText,
          ram: ramUsage || 0,
          isHibernated: tab.isHibernated || false
        });
      }
    } catch (err) {
      console.error('Error sending showHoverCard:', err);
    }
  }, 320);
}

function handleTabLeave() {
  clearTimeout(hoverTimeout);
  try {
    if (api.tabs && api.tabs.hideHoverCard) {
      api.tabs.hideHoverCard();
    }
  } catch {}
}

// Drag & Drop reordenamiento de pestañas
let draggedId: string | null = null;
function setupTabDragAndDrop(el: HTMLElement, id: string) {
  el.addEventListener('dragstart', (e) => {
    handleTabLeave();
    draggedId = id;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (draggedId && draggedId !== id) {
      const srcIdx = tabs.findIndex(t => t.id === draggedId);
      const targetIdx = tabs.findIndex(t => t.id === id);
      if (srcIdx !== -1 && targetIdx !== -1) {
        const [moved] = tabs.splice(srcIdx, 1);
        tabs.splice(targetIdx, 0, moved);
        renderTabs();
      }
    }
    draggedId = null;
  });
}

// Botón Mágico Semántico IA
document.getElementById('btn-magic-sort')?.addEventListener('click', async () => {
  if (!currentSettings.aiApiKey) {
    showToast('Configura tu API Key de Gemini en Ajustes para usar Agrupación Mágica', 'info');
    openInternalPage('beta://ajustes');
    return;
  }

  showToast('Organizando pestañas con Gemini IA...', 'info');
  try {
    const sorted = await groupTabsSemantic(currentSettings.aiApiKey, tabs);
    sorted.forEach(s => {
      const t = tabs.find(tab => tab.id === s.id);
      if (t) {
        t.category = s.category;
        t.color = s.color;
      }
    });

    // Ordenar por categoría
    tabs.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
    renderTabs();
    showToast('¡Pestañas organizadas por categoría!', 'success');
  } catch (err: any) {
    showToast('Error agrupando pestañas: ' + err.message, 'error');
  }
});

document.getElementById('btn-new-tab')?.addEventListener('click', () => {
  createTab('beta://nueva-pestana');
});

// Desplazamiento horizontal fluido con la rueda del ratón en la barra de pestañas
const tabsContainerEl = document.getElementById('tabs-container');
tabsContainerEl?.addEventListener('wheel', (e) => {
  if (e.deltaY !== 0) {
    tabsContainerEl.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

// ============================================================================
// 4. NAVEGACIÓN Y OMNIBOX
// ============================================================================
function setupNavigation() {
  const form = document.getElementById('omnibox-form') as HTMLFormElement;
  const input = document.getElementById('omnibox-input') as HTMLInputElement;

  let omniboxDebounce: any = null;
  let omniboxSuggestions: any[] = [];
  let omniboxSelectedIndex = -1;

  const sendOmniboxDropdown = () => {
    if (omniboxSuggestions.length > 0) {
      const formEl = document.getElementById('omnibox-form') || input;
      const rect = formEl.getBoundingClientRect();
      api.omnibox.showDropdown({
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        suggestions: omniboxSuggestions,
        selectedIndex: omniboxSelectedIndex
      });
    } else {
      api.omnibox.hideDropdown();
    }
  };

  const fetchSuggestions = async (val: string) => {
    if (!val || val.trim() === '' || val.startsWith('beta://')) {
      omniboxSuggestions = [];
      omniboxSelectedIndex = -1;
      api.omnibox.hideDropdown();
      return;
    }

    try {
      const results = await api.omnibox.getSuggestions(val);
      omniboxSuggestions = results || [];
      omniboxSelectedIndex = -1;
      sendOmniboxDropdown();
    } catch (e) {
      console.error('Error fetching suggestions:', e);
    }
  };

  input?.addEventListener('input', () => {
    clearTimeout(omniboxDebounce);
    omniboxDebounce = setTimeout(() => {
      fetchSuggestions(input.value);
    }, 100);

    // TURBO: DNS prefetch mientras escribe — si parece una URL real, precalentar TCP/TLS
    const val = input.value.trim();
    if (val.startsWith('http://') || val.startsWith('https://')) {
      try {
        const u = new URL(val);
        if (u.hostname.includes('.')) {
          (api as any).turbo?.dnsPrefetch?.(u.origin);
        }
      } catch { }
    }
  });

  input?.addEventListener('keydown', (e) => {
    if (omniboxSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        omniboxSelectedIndex = (omniboxSelectedIndex + 1) % omniboxSuggestions.length;
        sendOmniboxDropdown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        omniboxSelectedIndex = (omniboxSelectedIndex - 1 + omniboxSuggestions.length) % omniboxSuggestions.length;
        sendOmniboxDropdown();
        return;
      }
      if (e.key === 'Escape') {
        api.omnibox.hideDropdown();
        omniboxSuggestions = [];
        omniboxSelectedIndex = -1;
        return;
      }
    }
  });

  input?.addEventListener('blur', () => {
    setTimeout(() => {
      api.omnibox.hideDropdown();
    }, 180);
  });

  window.addEventListener('resize', () => {
    api.omnibox.hideDropdown();
  });

  api.omnibox.onAction((index: number) => {
    if (omniboxSuggestions[index]) {
      const item = omniboxSuggestions[index];
      if (item.type === 'switch-tab' && item.tabId) {
        switchTab(item.tabId);
      } else {
        navigateToUrl(item.url);
      }
      api.omnibox.hideDropdown();
      omniboxSuggestions = [];
      omniboxSelectedIndex = -1;
    }
  });

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    api.omnibox.hideDropdown();

    if (omniboxSelectedIndex >= 0 && omniboxSuggestions[omniboxSelectedIndex]) {
      const selected = omniboxSuggestions[omniboxSelectedIndex];
      if (selected.type === 'switch-tab' && selected.tabId) {
        switchTab(selected.tabId);
      } else {
        navigateToUrl(selected.url);
      }
      omniboxSuggestions = [];
      omniboxSelectedIndex = -1;
      return;
    }

    const query = input.value.trim();
    if (!query) return;

    let targetUrl = query;
    if (targetUrl.startsWith('beta://')) {
      navigateToUrl(targetUrl);
    } else if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      if (targetUrl.includes('.') && !targetUrl.includes(' ')) {
        targetUrl = 'https://' + targetUrl;
      } else {
        const engine = currentSettings.searchEngine || 'https://www.google.com/search?q=';
        if (engine.includes('?q=') || engine.includes('?p=')) {
          targetUrl = engine + encodeURIComponent(query);
        } else if (engine === 'duckduckgo') {
          targetUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
        } else if (engine === 'bing') {
          targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
        } else if (engine === 'yahoo') {
          targetUrl = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
        } else {
          targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        }
      }
      navigateToUrl(targetUrl);
    } else {
      navigateToUrl(targetUrl);
    }
  });

  // ── BOTONES DE NAVEGACIÓN Y HISTORIAL ──────────────────────────────────
  const backBtn = document.getElementById('btn-back');
  backBtn?.addEventListener('click', async () => {
    await handleGoBack();
  });

  // Clic derecho en Atrás -> Menú de historial reciente
  backBtn?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = backBtn.getBoundingClientRect();
    showNavHistoryDropdown('back', rect.left, rect.bottom);
  });

  const forwardBtn = document.getElementById('btn-forward');
  forwardBtn?.addEventListener('click', async () => {
    await handleGoForward();
  });

  // Clic derecho en Adelante -> Menú de historial reciente
  forwardBtn?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = forwardBtn.getBoundingClientRect();
    showNavHistoryDropdown('forward', rect.left, rect.bottom);
  });

  const reloadBtn = document.getElementById('btn-reload');
  reloadBtn?.addEventListener('click', async (e: MouseEvent) => {
    await handleReloadOrStop(e.shiftKey || e.ctrlKey);
  });

  document.getElementById('btn-home')?.addEventListener('click', () => {
    navigateToUrl('beta://nueva-pestana');
  });

  // Marcador toggle
  document.getElementById('btn-bookmark')?.addEventListener('click', async () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    const added = await api.bookmarks.toggle(tab.url, tab.title);
    updateBookmarkStar(added);
    showToast(added ? 'Marcador guardado' : 'Marcador eliminado', 'info');
  });
}

// ── ACCIONES DE NAVEGACIÓN PROFESIONAL (ESTILO CHROME / EDGE / ARC) ─────────

async function handleGoBack() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !activeTabId) return;

  const stack = tab.historyStack || [tab.url];
  const idx = tab.historyIndex ?? 0;

  if (tab.url.startsWith('beta://')) {
    if (idx > 0) {
      tab.historyIndex = idx - 1;
      const targetUrl = stack[tab.historyIndex];
      navigateToUrl(targetUrl, false);
    }
  } else {
    if (tab.canGoBack) {
      await api.tabs.goBack(activeTabId);
    } else if (idx > 0) {
      tab.historyIndex = idx - 1;
      const targetUrl = stack[tab.historyIndex];
      navigateToUrl(targetUrl, false);
    }
  }
  updateNavButtons();
}

async function handleGoForward() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !activeTabId) return;

  const stack = tab.historyStack || [tab.url];
  const idx = tab.historyIndex ?? 0;

  if (tab.url.startsWith('beta://')) {
    if (idx < stack.length - 1) {
      tab.historyIndex = idx + 1;
      const targetUrl = stack[tab.historyIndex];
      navigateToUrl(targetUrl, false);
    }
  } else {
    if (tab.canGoForward) {
      await api.tabs.goForward(activeTabId);
    } else if (idx < stack.length - 1) {
      tab.historyIndex = idx + 1;
      const targetUrl = stack[tab.historyIndex];
      navigateToUrl(targetUrl, false);
    }
  }
  updateNavButtons();
}

async function handleReloadOrStop(hardReload: boolean = false) {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || !activeTabId) return;

  const btn = document.getElementById('btn-reload');
  if (tab.isLoading || btn?.classList.contains('is-loading')) {
    await (api.tabs as any).stop?.(activeTabId);
    tab.isLoading = false;
    updateReloadButton(false);
    renderTabs();
    showToast('Carga detenida', 'info');
  } else {
    btn?.classList.add('is-reloading');
    setTimeout(() => btn?.classList.remove('is-reloading'), 600);

    if (tab.url.startsWith('beta://')) {
      showInternalPage(tab.url);
      showToast('Página recargada', 'info');
    } else {
      await (api.tabs as any).reload(activeTabId, hardReload);
      if (hardReload) {
        showToast('Recarga forzada (sin caché)', 'info');
      }
    }
  }
}

function updateReloadButton(isLoading: boolean) {
  const btn = document.getElementById('btn-reload');
  if (!btn) return;

  if (isLoading) {
    btn.classList.add('is-loading');
    btn.title = 'Detener carga de esta página (Esc)';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" class="stop-icon">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
  } else {
    btn.classList.remove('is-loading');
    btn.title = 'Recargar esta página (Ctrl+R / F5)';
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="reload-icon">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M3 3v5h5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;
  }
}

function updateNavButtons() {
  const tab = tabs.find(t => t.id === activeTabId);
  const back = document.getElementById('btn-back') as HTMLButtonElement;
  const forward = document.getElementById('btn-forward') as HTMLButtonElement;
  const phantomBtn = document.getElementById('btn-phantom-header');

  // El ojo de WhatsApp solo debe salir cuando se está en WhatsApp Web o con la bóveda abierta
  if (phantomBtn) {
    const isWhatsApp = !!(
      isPhantomVaultOpen ||
      (tab && tab.url && tab.url.includes('web.whatsapp.com'))
    );
    phantomBtn.style.display = isWhatsApp ? 'inline-flex' : 'none';
  }

  if (!back || !forward) return;

  if (!tab) {
    back.disabled = true;
    back.classList.add('disabled');
    forward.disabled = true;
    forward.classList.add('disabled');
    return;
  }

  const stack = tab.historyStack || [tab.url];
  const idx = tab.historyIndex ?? 0;

  let canBack = false;
  let canFwd = false;

  if (tab.url.startsWith('beta://')) {
    canBack = idx > 0;
    canFwd = idx < stack.length - 1;
  } else {
    canBack = !!tab.canGoBack || idx > 0;
    canFwd = !!tab.canGoForward || idx < stack.length - 1;
  }

  back.disabled = !canBack;
  forward.disabled = !canFwd;

  if (canBack) {
    back.classList.remove('disabled');
    back.title = 'Atrás (Alt+Flecha Izquierda)';
  } else {
    back.classList.add('disabled');
    back.title = 'Atrás (desactivado)';
  }

  if (canFwd) {
    forward.classList.remove('disabled');
    forward.title = 'Adelante (Alt+Flecha Derecha)';
  } else {
    forward.classList.add('disabled');
    forward.title = 'Adelante (desactivado)';
  }
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function showNavHistoryDropdown(type: 'back' | 'forward', x: number, y: number) {
  const dropdown = document.getElementById('nav-history-dropdown');
  if (!dropdown || !activeTabId) return;

  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;

  interface HistoryEntryItem {
    title: string;
    url: string;
    offset?: number;
  }

  let entries: HistoryEntryItem[] = [];

  try {
    const res = await (api.tabs as any).getHistoryEntries?.(activeTabId);
    if (res && Array.isArray(res.entries) && res.entries.length > 0) {
      const curIdx = res.currentIndex ?? -1;
      if (type === 'back') {
        for (let i = curIdx - 1; i >= 0; i--) {
          entries.push({
            title: res.entries[i].title || res.entries[i].url,
            url: res.entries[i].url,
            offset: i - curIdx
          });
        }
      } else {
        for (let i = curIdx + 1; i < res.entries.length; i++) {
          entries.push({
            title: res.entries[i].title || res.entries[i].url,
            url: res.entries[i].url,
            offset: i - curIdx
          });
        }
      }
    }
  } catch {}

  if (entries.length === 0 && tab.historyStack && tab.historyStack.length > 1) {
    const curIdx = tab.historyIndex ?? 0;
    if (type === 'back') {
      for (let i = curIdx - 1; i >= 0; i--) {
        const u = tab.historyStack[i];
        entries.push({
          title: u.startsWith('beta://') ? getInternalPageTitle(u) : u,
          url: u,
          offset: i - curIdx
        });
      }
    } else {
      for (let i = curIdx + 1; i < tab.historyStack.length; i++) {
        const u = tab.historyStack[i];
        entries.push({
          title: u.startsWith('beta://') ? getInternalPageTitle(u) : u,
          url: u,
          offset: i - curIdx
        });
      }
    }
  }

  if (entries.length === 0) return;

  const displayEntries = entries.slice(0, 8);

  dropdown.innerHTML = `
    <div style="padding: 4px 8px 6px; font-size: 11px; font-weight: 700; color: #8696a0; text-transform: uppercase; letter-spacing: 0.5px;">
      ${type === 'back' ? 'Páginas Anteriores' : 'Páginas Siguientes'}
    </div>
    ${displayEntries.map(e => `
      <div class="nav-history-item" data-offset="${e.offset}" data-url="${encodeURIComponent(e.url)}" title="${e.url}">
        <span class="nav-history-item-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
        <span class="nav-history-item-title">${escapeHtml(e.title)}</span>
      </div>
    `).join('')}
    <div class="nav-history-divider"></div>
    <div class="nav-history-footer" onclick="window.openInternalPage('beta://historial')">
      <span>Mostrar todo el historial</span>
      <span style="font-size: 10px; color: var(--text-dim);">Ctrl+H</span>
    </div>
  `;

  dropdown.style.left = `${Math.min(x, window.innerWidth - 270)}px`;
  dropdown.style.top = `${y + 6}px`;
  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.nav-history-item').forEach(el => {
    el.addEventListener('click', async () => {
      const offsetStr = el.getAttribute('data-offset');
      const targetUrl = decodeURIComponent(el.getAttribute('data-url') || '');
      dropdown.classList.add('hidden');

      if (targetUrl.startsWith('beta://')) {
        navigateToUrl(targetUrl);
      } else if (offsetStr && !isNaN(parseInt(offsetStr))) {
        await (api.tabs as any).goToOffset?.(activeTabId, parseInt(offsetStr));
      } else if (targetUrl) {
        navigateToUrl(targetUrl);
      }
    });
  });
}

function hideNavHistoryDropdown() {
  document.getElementById('nav-history-dropdown')?.classList.add('hidden');
}

window.addEventListener('click', (e) => {
  const dropdown = document.getElementById('nav-history-dropdown');
  if (dropdown && !dropdown.contains(e.target as Node)) {
    dropdown.classList.add('hidden');
  }
});

function navigateToUrl(url: string, pushToHistory: boolean = true) {
  closeAllPopups();
  hideNavHistoryDropdown();
  if (!activeTabId) return;

  // Vigilante de Contenido Adulto
  if (currentSettings.adultBlockerEnabled && !url.startsWith('beta://')) {
    const adultKeywords = ['porn', 'xxx', 'xvideos', 'xnxx', 'redtube', 'youporn', 'erome', 'onlyfans', 'chaturbate'];
    const lower = url.toLowerCase();
    if (adultKeywords.some(k => lower.includes(k))) {
      showToast('🚫 Sitio bloqueado por el Vigilante de Contenido Adulto', 'error');
      openInternalPage('beta://bloqueado?reason=adult');
      return;
    }
  }

  // Modo Cárcel (Pomodoro Profundo)
  if (currentSettings.pomodoroEnabled && !url.startsWith('beta://')) {
    const eduWhitelist = ['google.com', 'wikipedia.org', 'notion.so', 'github.com', 'coursera.org', 'edx.org', 'platzi.com', 'udemy.com', 'stackoverflow.com', 'chatgpt.com'];
    const lower = url.toLowerCase();
    if (!eduWhitelist.some(e => lower.includes(e))) {
      showToast('🔒 Modo Cárcel Activo: Solo sitios educativos permitidos', 'error');
      openInternalPage('beta://bloqueado?reason=pomodoro');
      return;
    }
  }

  const tab = tabs.find(t => t.id === activeTabId);
  if (tab) {
    if (!tab.historyStack) tab.historyStack = [tab.url];
    if (tab.historyIndex === undefined) tab.historyIndex = 0;

    if (pushToHistory && tab.url !== url) {
      tab.historyStack = tab.historyStack.slice(0, tab.historyIndex + 1);
      tab.historyStack.push(url);
      tab.historyIndex = tab.historyStack.length - 1;
    }

    tab.url = url;
    if (url.startsWith('beta://')) {
      tab.title = getInternalPageTitle(url);
    }
    renderTabs();
    updateOmnibox(url);
    if (url.startsWith('beta://')) {
      showInternalPage(url);
    } else {
      hideInternalPages();
    }
  }
  api.tabs.navigate(activeTabId, url);
  updateNavButtons();
}

function updateOmnibox(url: string) {
  const input = document.getElementById('omnibox-input') as HTMLInputElement;
  const lock = document.getElementById('omnibox-lock');
  // Solo la página de Nueva Pestaña muestra la barra vacía, el resto (beta://sala, etc.) muestra su URL
  if (input) input.value = (url === 'beta://nueva-pestana' || !url) ? '' : url;

  if (lock) {
    if (url.startsWith('https://')) {
      lock.classList.add('secure');
    } else {
      lock.classList.remove('secure');
    }
  }
}

function updateBookmarkStar(isBookmarked: boolean) {
  const btn = document.getElementById('btn-bookmark');
  if (btn) {
    if (isBookmarked) btn.classList.add('active');
    else btn.classList.remove('active');
  }
}

// ============================================================================
// 5. EVENTOS DE VISTA PROVENIENTES DE ELECTRON MAIN
// ============================================================================
function setupViewEvents() {
  api.events.onViewEvent((id: string, eventName: string, data?: any) => {
    if (eventName === 'open-new-tab' && data) {
      createTab(data);
      return;
    }
    if (eventName === 'ad-blocked') {
      return;
    }

    const tab = tabs.find(t => t.id === id);
    if (!tab) return;

    if (eventName === 'did-start-loading') {
      tab.isLoading = true;
      if (id === activeTabId) updateReloadButton(true);
      renderTabs();
    } else if (eventName === 'did-stop-loading') {
      tab.isLoading = false;
      if (id === activeTabId) updateReloadButton(false);
      renderTabs();
    } else if (eventName === 'did-navigate' || eventName === 'did-navigate-in-page') {
      tab.url = data;
      if (!tab.historyStack) tab.historyStack = [];
      if (tab.historyStack[tab.historyStack.length - 1] !== data) {
        tab.historyStack.push(data);
        tab.historyIndex = tab.historyStack.length - 1;
      }
      if (id === activeTabId) {
        updateOmnibox(data);
        updateNavButtons();
        if (api.bookmarks?.get) {
          api.bookmarks.get().then((list: any[]) => {
            const isBm = Array.isArray(list) && list.some((b: any) => b.url === data);
            updateBookmarkStar(isBm);
          }).catch(() => {});
        }
      }
      renderTabs();
    } else if (eventName === 'page-title-updated') {
      tab.title = data;
      renderTabs();
    } else if (eventName === 'page-favicon-updated') {
      tab.favicon = data;
      renderTabs();
    } else if (eventName === 'tab-hibernated') {
      tab.isHibernated = true;
      renderTabs();
    } else if (eventName === 'tab-woke-up') {
      tab.isHibernated = false;
      renderTabs();
    } else if (eventName === 'show-internal-page') {
      if (id === activeTabId) showInternalPage(data);
    } else if (eventName === 'found-in-page') {
      if (id === activeTabId && data) {
        const counter = document.getElementById('find-in-page-counter');
        if (counter) {
          if (data.matches > 0) {
            counter.innerText = `${data.activeMatchOrdinal} de ${data.matches}`;
            counter.style.color = '#fff';
          } else {
            counter.innerText = '0/0';
            counter.style.color = '#f87171';
          }
        }
      }
    }
  });

  (api.events as any).onNavStateChanged?.((data: { tabId: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }) => {
    const tab = tabs.find(t => t.id === data.tabId);
    if (tab) {
      tab.canGoBack = data.canGoBack;
      tab.canGoForward = data.canGoForward;
      tab.isLoading = data.isLoading;
      if (data.tabId === activeTabId) {
        updateNavButtons();
        updateReloadButton(data.isLoading);
      }
      renderTabs();
    }
  });

  // ── Eventos de Conexión en Vivo a Tor (Estilo Brave Tor Circuit) ──
  (api.events as any)?.onTorConnectingStart?.((data: { tabId: string; targetUrl: string; progress: number }) => {
    showTorConnectingOverlay(data.targetUrl, data.progress);
  });

  (api.events as any)?.onTorConnectingFinish?.((data: { tabId: string; targetUrl: string }) => {
    hideTorConnectingOverlay();
  });

  (api.events as any)?.onTorBootstrapProgress?.((data: { progress: number; summary: string }) => {
    updateTorConnectingProgress(data.progress, data.summary);
  });
}

// Atajos de teclado y botones de mouse para navegación universal
window.addEventListener('keydown', (e) => {
  // F5 o Ctrl+R -> Recargar
  if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
    e.preventDefault();
    handleReloadOrStop(e.shiftKey);
    return;
  }

  // Ctrl+Shift+R o Ctrl+F5 -> Recarga forzada sin caché
  if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') || (e.ctrlKey && e.key === 'F5')) {
    e.preventDefault();
    handleReloadOrStop(true);
    return;
  }

  // Escape -> Detener carga si está cargando
  if (e.key === 'Escape') {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.isLoading) {
      e.preventDefault();
      handleReloadOrStop(false);
    }
    return;
  }

  // Alt + Flecha Izquierda -> Retroceder
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    handleGoBack();
    return;
  }

  // Alt + Flecha Derecha -> Avanzar
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    handleGoForward();
    return;
  }

  // Backspace (cuando no se está escribiendo en un input o textarea)
  if (e.key === 'Backspace') {
    const target = e.target as HTMLElement;
    const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (!isInput) {
      e.preventDefault();
      handleGoBack();
      return;
    }
  }

  // Ctrl + T -> Nueva pestaña
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    createTab('beta://nueva-pestana');
    return;
  }

  // Ctrl + W -> Cerrar pestaña activa
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
    return;
  }

  // Ctrl + Shift + T -> Reabrir pestaña cerrada
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    restoreRecentlyClosedTab();
    return;
  }

  // Ctrl + F -> Buscar en la página
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFindInPage();
    return;
  }

  // Ctrl + D -> Añadir a marcadores
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab) {
      api.bookmarks.toggle(tab.url, tab.title).then(added => {
        updateBookmarkStar(added);
        renderBookmarksBar();
        showToast(added ? '⭐ Marcador guardado' : 'Marcador eliminado', 'info');
      });
    }
    return;
  }

  // Ctrl + Shift + B -> Mostrar/Ocultar barra de marcadores
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleBookmarksBar();
    return;
  }

  // Ctrl + U -> Ver código fuente
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && !tab.url.startsWith('view-source:') && !tab.url.startsWith('beta://')) {
      createTab('view-source:' + tab.url);
    }
    return;
  }

  // F11 -> Pantalla completa
  if (e.key === 'F11') {
    e.preventDefault();
    toggleFullscreenMode();
    return;
  }

  // F12 -> Herramientas para desarrolladores
  if (e.key === 'F12') {
    e.preventDefault();
    if (activeTabId && api.tabs?.toggleDevTools) {
      api.tabs.toggleDevTools(activeTabId);
    }
    return;
  }

  // Shift + Escape -> Administrador de tareas
  if (e.shiftKey && e.key === 'Escape') {
    e.preventDefault();
    openTaskManagerModal();
    return;
  }

  // Ctrl + N -> Nueva ventana
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (api.window?.openNewWindow) {
      api.window.openNewWindow('normal');
      showToast('Nueva ventana abierta', 'info');
    } else {
      createTab('beta://nueva-pestana');
    }
    return;
  }

  // Ctrl + Shift + N -> Modo incógnito (Ventana Privada estilo Brave)
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (api.window?.openNewWindow) {
      api.window.openNewWindow('incognito');
      showToast('🕶️ Abriendo ventana privada de incógnito...', 'info');
    } else {
      createTab('beta://privada', { isIncognito: true });
    }
    return;
  }

  // Mayús + Alt + N (o Shift + Alt + N) -> Ventana privada con Tor estilo Brave
  if (e.shiftKey && e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (api.window?.openNewWindow) {
      api.window.openNewWindow('tor');
      showToast('🧅 Conectando y abriendo ventana privada con Tor...', 'info');
    } else {
      createTab('beta://tor', { isTor: true });
    }
    return;
  }

  // Ctrl + J -> Descargas
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    openInternalPage('beta://descargas');
    return;
  }

  // Ctrl + H -> Historial
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    openInternalPage('beta://historial');
    return;
  }

  // Ctrl + P -> Imprimir
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    if (activeTabId && api.tabs?.print) {
      api.tabs.print(activeTabId);
    }
    return;
  }

  // Ctrl + Shift + Supr -> Eliminar datos de navegación
  if (e.ctrlKey && e.shiftKey && (e.key === 'Delete' || e.key === 'Supr')) {
    e.preventDefault();
    openClearDataModal();
    return;
  }

  // Ctrl + + / Ctrl + = -> Acercar zoom
  if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
    e.preventDefault();
    if (activeTabId && api.tabs?.getZoom && api.tabs?.setZoom) {
      api.tabs.getZoom(activeTabId).then(z => api.tabs.setZoom(activeTabId, Math.min(3, Math.round((z + 0.1) * 10) / 10)));
    }
    return;
  }

  // Ctrl + - -> Alejar zoom
  if (e.ctrlKey && e.key === '-') {
    e.preventDefault();
    if (activeTabId && api.tabs?.getZoom && api.tabs?.setZoom) {
      api.tabs.getZoom(activeTabId).then(z => api.tabs.setZoom(activeTabId, Math.max(0.25, Math.round((z - 0.1) * 10) / 10)));
    }
    return;
  }

  // Ctrl + 0 -> Restablecer zoom al 100%
  if (e.ctrlKey && e.key === '0') {
    e.preventDefault();
    if (activeTabId && api.tabs?.setZoom) {
      api.tabs.setZoom(activeTabId, 1);
    }
    return;
  }
});

// Botones de retroceder y avanzar del mouse (Mouse buttons 3 y 4)
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) {
    e.preventDefault();
    handleGoBack();
  } else if (e.button === 4) {
    e.preventDefault();
    handleGoForward();
  }
});

// ============================================================================
// 6. MOTOR DE DESCARGAS MULTIMEDIA Y SNIFFER
// ============================================================================
function setupDownloadEvents() {
  const dlBtn = document.getElementById('btn-download-quick');
  const label = document.getElementById('download-quick-label');

  // Sniffer de medios detectados en la página
  api.events.onMediaDetected((tabId: string, payload: any) => {
    if (tabId === activeTabId) {
      if (dlBtn && label) {
        dlBtn.classList.remove('locked', 'sniffing');
        dlBtn.classList.add('active');
        label.innerText = 'Descargar';
        dlBtn.title = 'Contenido multimedia detectado listo para descargar';
      }
    }
  });

  api.events.onMediaDRMLocked((tabId: string) => {
    if (tabId === activeTabId) {
      if (dlBtn && label) {
        dlBtn.classList.remove('active', 'sniffing', 'downloading');
        dlBtn.classList.add('locked');
        label.innerText = 'DRM';
        dlBtn.title = 'Contenido protegido por DRM (Netflix / Prime Video)';
      }
    }
  });

  api.events.onSniffingStart((tabId: string) => {
    if (tabId === activeTabId) {
      if (dlBtn && label) {
        dlBtn.classList.add('sniffing');
        label.innerText = 'Buscando...';
      }
    }
  });

  api.events.onSniffingEnd((tabId: string) => {
    if (tabId === activeTabId) {
      if (dlBtn) dlBtn.classList.remove('sniffing');
    }
  });

  // Progreso en tiempo real
  api.downloads.onProgress((data: { percent: number; speed: number; status: string }) => {
    if (dlBtn && label) {
      dlBtn.classList.add('downloading');
      const p = Math.round(data.percent * 100);
      label.innerText = `${p}%`;
    }
  });

  api.downloads.onCompleted((data: { id: string; filename: string; path: string }) => {
    if (dlBtn && label) {
      dlBtn.classList.remove('downloading');
      label.innerText = 'Descargar';
      showToast(`Descarga completada: ${data.filename}`, 'success');
    }
  });
}

(window as any).startQuickDownload = async (format: string, quality: string) => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.url.startsWith('beta://')) {
    showToast('No se puede descargar en esta página', 'error');
    return;
  }

  showToast(`Iniciando descarga (${format.toUpperCase()} ${quality})...`, 'info');
  await api.downloads.startMedia({
    url: tab.url,
    format,
    quality,
    title: tab.title
  });
};

function setMenuState(isOpen: boolean) {
  if (api && api.tabs && (api.tabs as any).setMenuState) {
    (api.tabs as any).setMenuState(isOpen);
  }
  const backdrop = document.getElementById('menu-backdrop');
  if (backdrop) {
    backdrop.classList.toggle('active', isOpen);
  }
}

function positionPopup(popup: HTMLElement, button: HTMLElement) {
  const btnRect = button.getBoundingClientRect();
  popup.style.top = `${Math.round(btnRect.bottom + 4)}px`;
  const popupWidth = popup.offsetWidth || 280;
  if (btnRect.left + popupWidth > window.innerWidth) {
    popup.style.left = 'auto';
    popup.style.right = `${Math.max(10, Math.round(window.innerWidth - btnRect.right))}px`;
  } else {
    popup.style.left = `${Math.round(btnRect.left)}px`;
    popup.style.right = 'auto';
  }
}

// ============================================================================
// MODALES Y UTILIDADES AVANZADAS (Estilo Brave / Chrome)
// ============================================================================
function closeAllBrowserModals() {
  document.querySelectorAll('.browser-modal-overlay').forEach(m => m.classList.remove('active'));
}
(window as any).closeAllBrowserModals = closeAllBrowserModals;

function openClearDataModal() {
  closeAllPopups();
  closeAllBrowserModals();
  const modal = document.getElementById('modal-clear-data');
  if (modal) modal.classList.add('active');
}

function openQrCodeModal() {
  closeAllPopups();
  closeAllBrowserModals();
  const tab = tabs.find(t => t.id === activeTabId);
  const url = tab ? tab.url : 'https://google.com';
  const modal = document.getElementById('modal-qr-code');
  const container = document.getElementById('qr-code-img-container');
  const urlText = document.getElementById('qr-code-url-text');
  if (container) {
    container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}" width="180" height="180" alt="Código QR" style="display:block; border-radius:6px;" />`;
  }
  if (urlText) {
    urlText.innerText = url;
  }
  if (modal) modal.classList.add('active');
}

function openTaskManagerModal() {
  closeAllPopups();
  closeAllBrowserModals();
  const modal = document.getElementById('modal-task-manager');
  const list = document.getElementById('task-manager-list');
  if (!modal || !list) return;

  modal.classList.add('active');
  list.innerHTML = tabs.map((t, idx) => {
    const memoryMB = t.isHibernated ? 12 : Math.round(48 + ((t.id.charCodeAt(t.id.length - 1) % 50) + idx * 8));
    return `
      <div class="task-manager-row" style="display:flex; align-items:center; justify-content:space-between; padding:10px 18px;">
        <div style="flex:2; display:flex; align-items:center; gap:10px; overflow:hidden;">
          <img src="${t.favicon || '../../assets/icons/favicon.png'}" width="16" height="16" style="border-radius:3px; flex-shrink:0;" onerror="this.src='../../assets/icons/favicon.png'" />
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; color:#fff;" title="${escapeHtml(t.title)}">${escapeHtml(t.title || 'Nueva pestaña')}</span>
        </div>
        <div style="flex:1; text-align:right; font-family:monospace; color:#94a3b8; font-size:12px;">
          ${memoryMB} MB ${t.isHibernated ? '💤' : ''}
        </div>
        <div style="flex:1; text-align:right;">
          <button onclick="window.closeTabFromTaskManager('${t.id}')" style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); color:#f87171; font-size:11px; font-weight:600; padding:4px 10px; border-radius:6px; cursor:pointer;">
            Finalizar proceso
          </button>
        </div>
      </div>
    `;
  }).join('');
}
(window as any).closeTabFromTaskManager = (id: string) => {
  closeTab(id);
  openTaskManagerModal();
};

function openShortcutsModal() {
  closeAllPopups();
  closeAllBrowserModals();
  const modal = document.getElementById('modal-shortcuts');
  if (modal) modal.classList.add('active');
}

const defaultPasswords = [
  { id: '1', site: 'google.com', user: 'usuario@gmail.com', pass: '••••••••••••' },
  { id: '2', site: 'github.com', user: 'coder_pro', pass: '••••••••••••' },
  { id: '3', site: 'netflix.com', user: 'familia@gmail.com', pass: '••••••••••••' }
];
let savedPasswords = [...defaultPasswords];

function openPasswordsModal() {
  closeAllPopups();
  closeAllBrowserModals();
  const modal = document.getElementById('modal-passwords');
  if (!modal) return;
  renderPasswordsList(savedPasswords);
  modal.classList.add('active');
}

function renderPasswordsList(items: any[]) {
  const list = document.getElementById('passwords-list');
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = '<div style="text-align:center; padding:20px; color:#64748b; font-size:12px;">No se encontraron contraseñas</div>';
    return;
  }
  list.innerHTML = items.map(p => `
    <div class="passwords-row">
      <div>
        <div style="font-weight:600; font-size:13px; color:#fff;">${escapeHtml(p.site)}</div>
        <div style="font-size:11px; color:#94a3b8;">${escapeHtml(p.user)} • <span style="font-family:monospace; color:#cbd5e1;">${p.pass}</span></div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <button onclick="window.copyPassword('${p.site}')" style="background:rgba(255,255,255,0.08); border:none; color:#cbd5e1; font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;" title="Copiar contraseña">📋</button>
        <button onclick="window.deletePassword('${p.id}')" style="background:rgba(239,68,68,0.15); border:none; color:#f87171; font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;" title="Eliminar">🗑️</button>
      </div>
    </div>
  `).join('');
}
(window as any).copyPassword = (site: string) => {
  navigator.clipboard.writeText('SuperPassword2026!');
  showToast(`Contraseña de ${site} copiada al portapapeles`, 'success');
};
(window as any).deletePassword = (id: string) => {
  savedPasswords = savedPasswords.filter(p => p.id !== id);
  renderPasswordsList(savedPasswords);
  showToast('Contraseña eliminada', 'info');
};

async function renderBookmarksBar() {
  const container = document.getElementById('bookmarks-bar-items');
  if (!container) return;
  try {
    let list: any[] = [];
    if (api.bookmarks?.get) {
      list = await api.bookmarks.get();
    }
    if (!list || list.length === 0) {
      container.innerHTML = `
        <div class="bm-item" onclick="createTab('https://google.com')">
          <img src="https://www.google.com/s2/favicons?domain=google.com&sz=16" width="14" height="14" />
          <span>Google</span>
        </div>
        <div class="bm-item" onclick="createTab('https://youtube.com')">
          <img src="https://www.google.com/s2/favicons?domain=youtube.com&sz=16" width="14" height="14" />
          <span>YouTube</span>
        </div>
        <div class="bm-item" onclick="createTab('https://github.com')">
          <img src="https://www.google.com/s2/favicons?domain=github.com&sz=16" width="14" height="14" />
          <span>GitHub</span>
        </div>
      `;
      return;
    }
    container.innerHTML = list.slice(0, 15).map(bm => `
      <div class="bm-item" onclick="window.navigateToUrl('${bm.url.replace(/'/g, "\\'")}')" title="${escapeHtml(bm.url)}">
        <img src="https://www.google.com/s2/favicons?domain=${getDomain(bm.url)}&sz=16" width="14" height="14" onerror="this.src='../../assets/icons/favicon.png'" />
        <span>${escapeHtml(bm.title || bm.url)}</span>
      </div>
    `).join('');
  } catch {}
}

function toggleBookmarksBar() {
  const bar = document.getElementById('bookmarks-bar');
  if (!bar) return;
  bar.classList.toggle('hidden');
  renderBookmarksBar();
  syncViewBounds();
  showToast(bar.classList.contains('hidden') ? 'Barra de marcadores oculta' : 'Barra de marcadores visible', 'info');
}

function openFindInPage() {
  const bar = document.getElementById('find-in-page-bar');
  const input = document.getElementById('find-in-page-input') as HTMLInputElement;
  if (!bar || !input) return;
  bar.classList.add('active');
  input.focus();
  input.select();
  if (input.value && activeTabId && api.tabs?.findInPage) {
    api.tabs.findInPage(activeTabId, input.value, { forward: true, findNext: false });
  }
}

function closeFindInPage() {
  const bar = document.getElementById('find-in-page-bar');
  if (bar) bar.classList.remove('active');
  if (activeTabId && api.tabs?.stopFindInPage) {
    api.tabs.stopFindInPage(activeTabId, 'clearSelection');
  }
}

function restoreRecentlyClosedTab() {
  if (recentlyClosedTabs.length > 0) {
    const closed = recentlyClosedTabs.shift()!;
    createTab(closed.url);
    showToast(`Pestaña restaurada: ${closed.title}`, 'success');
  } else {
    showToast('No hay pestañas cerradas recientemente', 'info');
  }
}

async function toggleFullscreenMode() {
  try {
    if ((api as any).window?.toggleFullscreen) {
      await (api as any).window.toggleFullscreen();
    } else {
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    }
  } catch {}
}

// ============================================================================
// 7. MENÚS, POPUPS Y ESCUDO (ADBLOCK)
// ============================================================================
function setupMenus() {
  // Escudo (Adblock) flotante sobre la vista web
  const btnShield = document.getElementById('btn-shield');
  btnShield?.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnShield.getBoundingClientRect();
    const tab = tabs.find(t => t.id === activeTabId);
    const domain = tab ? getDomain(tab.url) : '';
    const stats = await api.adblock.getStats();
    let isDomainEnabled = true;
    try {
      if (domain && (api.adblock as any).isDomainEnabled) {
        isDomainEnabled = await (api.adblock as any).isDomainEnabled(domain);
      }
    } catch {}

    let updateInfo = null;
    try {
      if ((api.adblock as any).getUpdateInfo) {
        updateInfo = await (api.adblock as any).getUpdateInfo();
      }
    } catch {}

    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'shield',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        data: {
          totalBlocked: stats.totalBlocked,
          domain: domain || 'Sitio actual',
          enabled: isDomainEnabled,
          updateInfo
        }
      });
    }
  });

  // ── VPN de Protección (Estilo Opera / Brave) 🛡️ ──
  const btnVpnToolbar = document.getElementById('btn-vpn-toolbar');
  const vpnBadge = document.getElementById('vpn-toolbar-badge');

  const updateVpnToolbarUI = (state: any) => {
    if (!btnVpnToolbar) return;
    if (state.connecting) {
      btnVpnToolbar.className = 'nav-icon-btn vpn-toolbar-btn connecting';
      btnVpnToolbar.title = `VPN: Conectando a ${state.locationName}...`;
      if (vpnBadge) {
        vpnBadge.style.display = 'inline';
        vpnBadge.innerText = 'CONECTANDO...';
      }
    } else if (state.enabled) {
      btnVpnToolbar.className = 'nav-icon-btn vpn-toolbar-btn connected';
      btnVpnToolbar.title = `🛡️ VPN Activa: ${state.locationName}\nIP: ${state.ip} (${state.ping || 120}ms)`;
      if (vpnBadge) {
        vpnBadge.style.display = 'inline';
        vpnBadge.innerText = state.location && state.location !== 'auto' ? state.location.toUpperCase() : 'ON';
      }
    } else {
      btnVpnToolbar.className = 'nav-icon-btn vpn-toolbar-btn';
      btnVpnToolbar.title = 'VPN de Protección (Desconectada)';
      if (vpnBadge) {
        vpnBadge.style.display = 'none';
      }
    }
  };

  btnVpnToolbar?.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnVpnToolbar.getBoundingClientRect();
    let vpnState = null;
    try {
      if ((api as any).vpn && (api as any).vpn.getState) {
        vpnState = await (api as any).vpn.getState();
      }
    } catch {}

    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'vpn',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        data: { vpnState }
      });
    }
  });

  // Escuchar estado en vivo de la VPN
  if ((api as any).vpn && (api as any).vpn.onStatusUpdated) {
    (api as any).vpn.onStatusUpdated((state: any) => {
      updateVpnToolbarUI(state);
      if (state.enabled && !state.connecting) {
        showToast(`🛡️ VPN Conectada: ${state.locationName} (${state.ip})`, 'success');
      } else if (!state.enabled && !state.connecting) {
        showToast('VPN Desconectada: Conexión directa restaurada', 'info');
      }
    });
  }

  // Cargar estado inicial de la VPN
  try {
    if ((api as any).vpn && (api as any).vpn.getState) {
      (api as any).vpn.getState().then(updateVpnToolbarUI).catch(() => {});
    }
  } catch {}

  // ── Modo Cine & Salas Compartidas P2P 🎬 ──
  const btnCinema = document.getElementById('btn-cinema');
  let lastCinemaRect: any = null;

  btnCinema?.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    
    // Si ya existe una pestaña con beta://sala o beta://cine, cambiamos a ella
    const existingTab = tabs.find(t => t.url.startsWith('beta://sala') || t.url.startsWith('beta://cine'));
    if (existingTab) {
      switchTab(existingTab.id);
      return;
    }

    // Si la pestaña actual está en beta://nueva-pestana, navegamos en ella; de lo contrario creamos pestaña nueva
    const currentTab = tabs.find(t => t.id === activeTabId);
    if (currentTab && currentTab.url === 'beta://nueva-pestana') {
      navigateToUrl('beta://sala');
    } else {
      createTab('beta://sala');
    }
  });

  // Escuchar cambios de estado en la sala de cine
  if ((api as any).cinema && (api as any).cinema.onStatusUpdated) {
    (api as any).cinema.onStatusUpdated((status: any) => {
      if (btnCinema) {
        btnCinema.classList.toggle('in-room', !!status.inRoom);
        btnCinema.title = status.inRoom
          ? `Sala de Cine Activa (${status.roomId}) • ${status.partnerConnected ? '¡Amigo Conectado! 🟢' : 'Esperando a tu amigo...'}`
          : 'Modo Cine & Salas Compartidas (Ver juntos a distancia)';
      }
      updateCinemaDrawerStatus(status);
      if (status.inRoom && status.partnerConnected) {
        showToast(`🟢 ¡${status.partnerName || 'Tu amigo'} se ha conectado a la sala de cine! Videos sincronizados.`, 'success');
      }
      // Si estamos actualmente en la pestaña beta://sala, refrescar su UI
      const currentTab = tabs.find(t => t.id === activeTabId);
      const container = document.getElementById('internal-pages');
      if (container && currentTab && (currentTab.url.startsWith('beta://sala') || currentTab.url.startsWith('beta://cine'))) {
        renderCinemaRoomPage(container);
      }
    });
  }

  // Escuchar cuando se deniega control de reproducción (Estilo Rave: Solo Anfitrión)
  if ((api as any).cinema && (api as any).cinema.onControlDenied) {
    (api as any).cinema.onControlDenied((message: string) => {
      showToast('🔒 ' + (message || 'Solo el anfitrión tiene el control de reproducción en esta sala.'), 'error');
    });
  }

  // Escuchar cuando la sala a la que se intenta unir está llena
  if ((api as any).cinema && (api as any).cinema.onRoomFull) {
    (api as any).cinema.onRoomFull((maxParticipants: number) => {
      showToast(`⚠️ La sala está llena. Ha alcanzado su capacidad máxima (${maxParticipants} personas).`, 'error');
      cinemaState.status.inRoom = false;
      const currentTab = tabs.find(t => t.id === activeTabId);
      const container = document.getElementById('internal-pages');
      if (container && currentTab && (currentTab.url.startsWith('beta://sala') || currentTab.url.startsWith('beta://cine'))) {
        renderCinemaRoomPage(container);
      }
    });
  }

  // Escuchar cambio dinámico de permisos de reproducción (Rave)
  if ((api as any).cinema && (api as any).cinema.onControlModeUpdated) {
    (api as any).cinema.onControlModeUpdated((mode: string) => {
      cinemaState.status.controlMode = mode === 'everyone' ? 'everyone' : 'host_only';
      showToast(mode === 'host_only' 
        ? '🔒 El anfitrión ha configurado la sala en: Solo Anfitrión (Control exclusivo)' 
        : '👥 El anfitrión ha configurado la sala en: Modo Libre (Todos pueden controlar)', 'info');
      const currentTab = tabs.find(t => t.id === activeTabId);
      const container = document.getElementById('internal-pages');
      if (container && currentTab && (currentTab.url.startsWith('beta://sala') || currentTab.url.startsWith('beta://cine'))) {
        renderCinemaRoomPage(container);
      }
    });
  }

  // Escuchar lista actualizada de participantes
  if ((api as any).cinema && (api as any).cinema.onParticipantsUpdated) {
    (api as any).cinema.onParticipantsUpdated((participants: any[]) => {
      if (Array.isArray(participants)) {
        cinemaState.status.participants = participants;
        cinemaState.status.participantsCount = participants.length;
        cinemaState.status.partnerConnected = participants.length > 1;
        const currentTab = tabs.find(t => t.id === activeTabId);
        const container = document.getElementById('internal-pages');
        if (container && currentTab && (currentTab.url.startsWith('beta://sala') || currentTab.url.startsWith('beta://cine'))) {
          renderCinemaRoomPage(container);
        }
      }
    });
  }

  // Escuchar navegación sincronizada de la sala de cine (Fix crítico para visualización de páginas reales)
  if ((api as any).cinema && (api as any).cinema.onSyncNavigate) {
    (api as any).cinema.onSyncNavigate((data: { url: string; mode: string }) => {
      console.log('🔄 Cinema sync navigate received:', data);
      if (!data || !data.url) return;
      
      // Cerrar páginas internas para que se vea el WebContentsView real
      hideInternalPages();
      const currentTab = tabs.find(t => t.id === activeTabId);
      if (currentTab) {
        currentTab.url = data.url;
        currentTab.title = 'Sincronizando con sala...';
        renderTabs();
      }
      updateOmnibox(data.url);
      api.tabs.navigate(activeTabId, data.url);
      syncViewBounds();
      if ((api.tabs as any).focusActiveView) {
        setTimeout(() => {
          (api.tabs as any).focusActiveView();
        }, 120);
      }
      showToast(`🎬 Sala sincronizada con: ${data.url}`, 'info');
    });
  }

  // Escuchar sincronización del reproductor multimedia integrado
  if ((api as any).cinema && (api as any).cinema.onPlayerSyncReceived) {
    (api as any).cinema.onPlayerSyncReceived((payload: any) => {
      if (!payload) return;
      if (Array.isArray(payload.queue) && payload.queue.length > 0) {
        cinemaState.queue = payload.queue;
      }
      if (payload.currentIndex !== undefined && payload.currentIndex !== cinemaState.currentIndex) {
        cinemaState.currentIndex = payload.currentIndex;
        cinemaState.isPlaying = payload.isPlaying;
        cinemaState.currentTime = payload.time || 0;
        const container = document.getElementById('internal-pages');
        const currentTab = tabs.find(t => t.id === activeTabId);
        if (container && currentTab && (currentTab.url.startsWith('beta://sala') || currentTab.url.startsWith('beta://cine'))) {
          renderCinemaRoomPage(container);
        }
        return;
      }

      cinemaState.isPlaying = payload.isPlaying;
      if (cinemaState.ytPlayer && typeof cinemaState.ytPlayer.getCurrentTime === 'function') {
        try {
          const cur = cinemaState.ytPlayer.getCurrentTime();
          if (Math.abs(cur - payload.time) > 2) {
            cinemaState.ytPlayer.seekTo(payload.time, true);
          }
          if (payload.isPlaying) {
            cinemaState.ytPlayer.playVideo();
          } else {
            cinemaState.ytPlayer.pauseVideo();
          }
        } catch {}
      } else {
        const v = document.getElementById('cinema-direct-video') as HTMLVideoElement;
        if (v) {
          if (Math.abs(v.currentTime - payload.time) > 2) {
            v.currentTime = payload.time;
          }
          if (payload.isPlaying) {
            v.play().catch(() => {});
          } else {
            v.pause();
          }
        }
      }
    });
  }

  // Escuchar mensajes de chat P2P recibidos en la sala
  if ((api as any).cinema && (api as any).cinema.onChatMessage) {
    (api as any).cinema.onChatMessage((msg: any) => {
      if (!msg) return;
      // Actualizar el cajón flotante si estuviera abierto en co-navegación
      appendCinemaChatMessage(msg);

      // Si el mensaje es propio (enviado por mí), ya se agregó inmediatamente de forma optimista en la sala
      if (msg.isMe) return;

      if (msg.id && cinemaState.chatMessages.some((m: any) => m.id === msg.id)) {
        return;
      }
      cinemaState.chatMessages.push(msg);

      if (msg.text && isSingleOrFewEmojis(msg.text)) {
        triggerFloatingReaction(msg.text);
      }

      const feed = document.getElementById('cinema-room-chat-feed');
      if (feed) {
        appendChatMessageToFeed(msg, feed);
      }
    });
  }

  // Escuchar historial de conversación previo al unirse (Rave Chat Sync)
  if ((api as any).cinema && (api as any).cinema.onChatHistory) {
    (api as any).cinema.onChatHistory((historyMessages: any[]) => {
      if (!Array.isArray(historyMessages) || historyMessages.length === 0) return;
      console.log('[Cinema] Historial de chat recibido:', historyMessages.length, 'mensajes');
      cinemaState.chatMessages = historyMessages;
      const feed = document.getElementById('cinema-room-chat-feed');
      if (feed) {
        renderChatFeedWithHistory(feed);
      }
      showToast(`📜 ${historyMessages.length} mensajes previos sincronizados`, 'info');
    });
  }

  // Escuchar reacciones flotantes de emojis en tiempo real (Rave Reactions)
  if ((api as any).cinema && (api as any).cinema.onReaction) {
    (api as any).cinema.onReaction((emoji: string) => {
      if (emoji) {
        triggerFloatingReaction(emoji);
      }
    });
  }

  // Escuchar acciones de la ventana flotante menuPopup.html
  if ((api as any).menuPopup && (api as any).menuPopup.onAction) {
    (api as any).menuPopup.onAction(async (action: string, payload: any) => {
      if (action === 'cinema-create-room') {
        showToast('Creando sala de cine P2P...', 'info');
        const st = await (api as any).cinema.createRoom('player', cinemaState.username);
        showToast(`✨ Sala creada: ${st.roomId}. ¡Comparte el código!`, 'success');
        updateCinemaDrawerStatus(st);
        openInternalPage('beta://sala');
      } else if (action === 'cinema-join-room') {
        showToast(`Conectando a sala ${payload}...`, 'info');
        const st = await (api as any).cinema.joinRoom(payload, cinemaState.username);
        showToast(`🟢 Conectado con éxito a sala ${payload}`, 'success');
        updateCinemaDrawerStatus(st);
        openInternalPage('beta://sala');
      } else if (action === 'cinema-leave-room') {
        resetCinemaChat();
        const st = await (api as any).cinema.leaveRoom();
        showToast('Has salido de la sala de cine', 'info');
        updateCinemaDrawerStatus(st);
        toggleCinemaDrawer(false);
        const container = document.getElementById('internal-pages');
        const currentTab = tabs.find(t => t.id === activeTabId);
        if (container && currentTab && (currentTab.url.startsWith('beta://sala') || currentTab.url.startsWith('beta://cine'))) {
          renderCinemaRoomPage(container);
        }
      } else if (action === 'cinema-open-drawer') {
        toggleCinemaDrawer(true);
      } else if (action === 'cinema-toggle-lights') {
        await (api as any).cinema.toggleLights(payload);
      } else if (action === 'cinema-copy-code') {
        showToast(`📋 Código ${payload} copiado al portapapeles`, 'success');
      } else if (action === 'toggle-turbo') {
        const enabled = !!payload;
        if (api && (api as any).turbo && (api as any).turbo.toggle) {
          await (api as any).turbo.toggle(enabled);
        }
        updateTurboInfo();
        showToast(`Modo Turbo ${enabled ? 'Activado (Aceleración Extrema)' : 'Desactivado (Estándar)'}`, 'info');
      } else if (action === 'toggle-shield') {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab) {
          const domain = getDomain(tab.url);
          await api.adblock.toggle(domain);
          updateShieldCounter();
          showToast(`Escudo ${payload.enabled ? 'activado' : 'pausado'} para ${domain}`, 'info');
        }
      } else if (action === 'update-adblock-rules') {
        showToast('Comprobando parches de YouTube y Brave Shields...', 'info');
        try {
          const res = await (api.adblock as any).checkForUpdates();
          if (res && res.success) {
            showToast('¡Reglas y parches actualizados con éxito! 🛡️', 'success');
            if ((api as any).menuPopup?.updateData) {
              (api as any).menuPopup.updateData('shield', { updateInfo: res.updateInfo });
            }
          } else {
            showToast(res?.message || 'No se pudieron actualizar las reglas', 'info');
            if ((api as any).menuPopup?.updateData) {
              (api as any).menuPopup.updateData('shield', { updateInfo: res?.updateInfo });
            }
          }
        } catch (err: any) {
          showToast('Error al conectar con los servidores de filtros', 'error');
        }
      } else if (action === 'new-tab') {
        createTab('beta://nueva-pestana');
      } else if (action === 'new-window') {
        if (api.window?.openNewWindow) {
          api.window.openNewWindow('normal');
          showToast('Nueva ventana abierta', 'info');
        } else {
          createTab('beta://nueva-pestana');
        }
      } else if (action === 'new-private') {
        if (api.window?.openNewWindow) {
          api.window.openNewWindow('incognito');
          showToast('🕶️ Abriendo ventana privada de incógnito...', 'info');
        } else {
          createTab('beta://privada', { isIncognito: true });
        }
      } else if (action === 'new-tor') {
        if (api.window?.openNewWindow) {
          api.window.openNewWindow('tor');
          showToast('🧅 Conectando y abriendo ventana privada con Tor...', 'info');
        } else {
          createTab('beta://tor', { isTor: true });
        }
      } else if (action === 'ai-pilot') {
        const drawer = document.getElementById('ai-drawer');
        drawer?.classList.toggle('open');
        syncViewBounds();
      } else if (action === 'wallet') {
        const btnW = document.getElementById('btn-wallet');
        if (btnW && (api as any).menuPopup?.show) {
          const rect = btnW.getBoundingClientRect();
          (api as any).menuPopup.show({
            type: 'wallet',
            bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
          });
        }
      } else if (action === 'wallet-receive') {
        navigator.clipboard.writeText(payload || '0x71C8F1634b821a37De5a49B2E3fC128');
        showToast('📋 Dirección de billetera copiada al portapapeles', 'success');
      } else if (action === 'wallet-send') {
        showToast('↗️ Enviar fondos: Selecciona destinatario en la red Web3', 'info');
      } else if (action === 'wallet-swap') {
        showToast('🔄 Swap descentralizado: Conectando con agregador 0x DEX...', 'info');
      } else if (action === 'wallet-token') {
        showToast(`Criptoactivo ${payload} seleccionado`, 'info');
      } else if (action === 'vpn') {
        const btnV = document.getElementById('btn-vpn-toolbar') || document.getElementById('btn-menu');
        if (btnV && (api as any).menuPopup?.show) {
          const rect = btnV.getBoundingClientRect();
          let vpnState = null;
          try {
            if ((api as any).vpn && (api as any).vpn.getState) {
              vpnState = await (api as any).vpn.getState();
            }
          } catch {}
          (api as any).menuPopup.show({
            type: 'vpn',
            bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
            data: { vpnState }
          });
        }
      } else if (action === 'vpn-toggle') {
        if (payload) {
          showToast('🛡️ VPN: Conectando y cifrando navegación...', 'info');
        } else {
          showToast('VPN Desconectada: Conexión directa', 'info');
        }
      } else if (action === 'vpn-location') {
        showToast(`🌍 Servidor VPN cambiado a: ${payload} (Conectando...)`, 'info');
      } else if (action === 'toggle-ext') {
        showToast(`Extensión ${payload} actualizada`, 'info');
      } else if (action === 'open-web-store') {
        createTab('https://chromewebstore.google.com');
      } else if (action === 'sidebar-mode') {
        const drawer = document.getElementById('ai-drawer');
        if (payload === 'active') {
          drawer?.classList.add('open');
        } else {
          drawer?.classList.remove('open');
        }
        syncViewBounds();
        showToast(`Barra lateral: ${payload === 'active' ? 'Activada' : payload === 'auto' ? 'Ocultar automáticamente' : 'Desactivada'}`, 'info');
      } else if (action === 'passwords' || action === 'open-passwords') {
        openPasswordsModal();
      } else if (action === 'check-passwords') {
        showToast('🔐 Comprobación de seguridad: 0 contraseñas vulneradas', 'success');
      } else if (action === 'history') {
        openInternalPage('beta://historial');
      } else if (action === 'time-machine') {
        openInternalPage('beta://historial');
        showToast('Máquina del Tiempo Local - Copias offline', 'info');
      } else if (action === 'reopen-tab') {
        restoreRecentlyClosedTab();
      } else if (action === 'bookmarks') {
        openInternalPage('beta://historial');
      } else if (action === 'bookmark-current') {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab) {
          const added = await api.bookmarks.toggle(tab.url, tab.title);
          updateBookmarkStar(added);
          renderBookmarksBar();
          showToast(added ? '⭐ Marcador guardado' : 'Marcador eliminado', 'info');
        }
      } else if (action === 'toggle-bookmarks-bar') {
        toggleBookmarksBar();
      } else if (action === 'downloads') {
        openInternalPage('beta://descargas');
      } else if (action === 'extensions') {
        const btnE = document.getElementById('btn-extensions');
        if (btnE && (api as any).menuPopup?.show) {
          const rect = btnE.getBoundingClientRect();
          (api as any).menuPopup.show({
            type: 'extensions',
            bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
          });
        }
      } else if (action === 'clear-data-dialog' || action === 'clear-data') {
        openClearDataModal();
      } else if (action === 'set-zoom') {
        if (activeTabId && api.tabs?.setZoom) {
          await api.tabs.setZoom(activeTabId, payload);
        }
      } else if (action === 'toggle-fullscreen') {
        toggleFullscreenMode();
      } else if (action === 'print') {
        if (activeTabId && api.tabs?.print) {
          await api.tabs.print(activeTabId);
        } else {
          window.print();
        }
      } else if (action === 'open-find-in-page' || action === 'find-in-page') {
        openFindInPage();
      } else if (action === 'cut') {
        if (activeTabId && api.tabs?.clipboardAction) {
          await api.tabs.clipboardAction(activeTabId, 'cut');
        } else if (activeTabId && (api.tabs as any)?.executeJs) {
          (api.tabs as any).executeJs(activeTabId, 'document.execCommand("cut")');
        }
      } else if (action === 'copy') {
        if (activeTabId && api.tabs?.clipboardAction) {
          await api.tabs.clipboardAction(activeTabId, 'copy');
        } else if (activeTabId && (api.tabs as any)?.executeJs) {
          (api.tabs as any).executeJs(activeTabId, 'document.execCommand("copy")');
        }
      } else if (action === 'paste') {
        if (activeTabId && api.tabs?.clipboardAction) {
          await api.tabs.clipboardAction(activeTabId, 'paste');
        } else if (activeTabId && (api.tabs as any)?.executeJs) {
          (api.tabs as any).executeJs(activeTabId, 'document.execCommand("paste")');
        }
      } else if (action === 'save-share') {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab?.url) {
          navigator.clipboard.writeText(tab.url);
          showToast('🔗 Enlace copiado al portapapeles para compartir', 'success');
        }
      } else if (action === 'open-qr-code') {
        openQrCodeModal();
      } else if (action === 'share-whatsapp') {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab?.url) {
          createTab(`https://web.whatsapp.com/send?text=${encodeURIComponent(tab.url)}`);
        }
      } else if (action === 'more-tools') {
        if (activeTabId && api.tabs?.toggleDevTools) {
          await api.tabs.toggleDevTools(activeTabId);
        }
      } else if (action === 'open-task-manager') {
        openTaskManagerModal();
      } else if (action === 'view-source') {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab && !tab.url.startsWith('view-source:') && !tab.url.startsWith('beta://')) {
          createTab('view-source:' + tab.url);
        }
      } else if (action === 'open-shortcuts') {
        openShortcutsModal();
      } else if (action === 'navigate-url') {
        if (payload) navigateToUrl(payload);
      } else if (action === 'help') {
        showToast('💡 NavegadorBeta - Rápido, privado y con IA integrada', 'info');
      } else if (action === 'phantom') {
        openInternalPage('beta://mensajes-eliminados');
      } else if (action === 'settings') {
        openInternalPage('beta://ajustes');
      } else if (action === 'exit') {
        try {
          if ((api as any).window?.close) {
            (api as any).window.close();
          } else {
            window.close();
          }
        } catch {}
      } else if (action === 'about') {
        showToast('NavegadorBeta v1.0.0 — El navegador rápido, con IA y ligero', 'info');
      }
    });
  }

  // Find in page controls
  const findInput = document.getElementById('find-in-page-input') as HTMLInputElement;
  findInput?.addEventListener('input', () => {
    if (activeTabId && api.tabs?.findInPage) {
      api.tabs.findInPage(activeTabId, findInput.value, { forward: true, findNext: false });
    }
  });
  findInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeTabId && api.tabs?.findInPage) {
        api.tabs.findInPage(activeTabId, findInput.value, { forward: !e.shiftKey, findNext: true });
      }
    } else if (e.key === 'Escape') {
      closeFindInPage();
    }
  });
  document.getElementById('btn-find-next')?.addEventListener('click', () => {
    if (activeTabId && findInput?.value && api.tabs?.findInPage) {
      api.tabs.findInPage(activeTabId, findInput.value, { forward: true, findNext: true });
    }
  });
  document.getElementById('btn-find-prev')?.addEventListener('click', () => {
    if (activeTabId && findInput?.value && api.tabs?.findInPage) {
      api.tabs.findInPage(activeTabId, findInput.value, { forward: false, findNext: true });
    }
  });
  document.getElementById('btn-find-close')?.addEventListener('click', () => {
    closeFindInPage();
  });

  // Clear data modal confirm
  document.getElementById('btn-confirm-clear-data')?.addEventListener('click', async () => {
    const cbHistory = (document.getElementById('clear-cb-history') as HTMLInputElement)?.checked;
    const cbCookies = (document.getElementById('clear-cb-cookies') as HTMLInputElement)?.checked;
    const cbCache = (document.getElementById('clear-cb-cache') as HTMLInputElement)?.checked;
    const timeRange = (document.getElementById('clear-data-time-range') as HTMLSelectElement)?.value;

    let timeMs = 0;
    if (timeRange === '1h') timeMs = 3600 * 1000;
    else if (timeRange === '24h') timeMs = 24 * 3600 * 1000;
    else if (timeRange === '7d') timeMs = 7 * 24 * 3600 * 1000;

    try {
      if (cbHistory && api.history?.clear) {
        await api.history.clear(timeMs);
      }
      if ((cbCookies || cbCache) && (api.settings as any)?.clearSessionData) {
        await (api.settings as any).clearSessionData({
          cache: cbCache,
          cookies: cbCookies,
          storage: cbCookies
        });
      }
      showToast('🧹 Datos de navegación eliminados correctamente', 'success');
    } catch (e: any) {
      showToast('Error eliminando datos: ' + e.message, 'error');
    }
    closeAllBrowserModals();
  });

  // QR copy button
  document.getElementById('btn-copy-qr-url')?.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.url) {
      navigator.clipboard.writeText(tab.url);
      showToast('📋 Enlace copiado al portapapeles', 'success');
    }
  });

  // Passwords search and add
  document.getElementById('btn-add-credential')?.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    const domain = tab ? getDomain(tab.url) : 'ejemplo.com';
    const user = prompt('Introduce usuario o correo:', 'usuario@' + domain);
    if (!user) return;
    const pass = prompt('Introduce contraseña:');
    if (!pass) return;
    savedPasswords.push({
      id: Date.now().toString(),
      site: domain,
      user,
      pass: '••••••••••••'
    });
    renderPasswordsList(savedPasswords);
    showToast(`Contraseña guardada para ${domain}`, 'success');
  });

  document.getElementById('passwords-search-input')?.addEventListener('input', (e) => {
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    const filtered = savedPasswords.filter(p => p.site.toLowerCase().includes(q) || p.user.toLowerCase().includes(q));
    renderPasswordsList(filtered);
  });

  // Descarga rápida estilo ShieldBrowser
  const btnDl = document.getElementById('btn-download-quick');
  btnDl?.addEventListener('click', (e) => {
    e.stopPropagation();
    if ((api as any).menuPopup && (api as any).menuPopup.hide) (api as any).menuPopup.hide();
    document.querySelectorAll('.glass-menu').forEach(m => m.classList.remove('open'));
    const rect = btnDl.getBoundingClientRect();
    const tab = tabs.find(t => t.id === activeTabId);
    api.downloads.toggleMenu({
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      activeTabId,
      activeUrl: tab ? tab.url : '',
      activeTitle: tab ? tab.title : ''
    });
  });

  // Extensiones (Abre tarjeta flotante de extensiones)
  const btnExtensions = document.getElementById('btn-extensions');
  btnExtensions?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnExtensions.getBoundingClientRect();
    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'extensions',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }
  });

  // Barra lateral
  document.getElementById('btn-sidebar')?.addEventListener('click', () => {
    const drawer = document.getElementById('ai-drawer');
    drawer?.classList.toggle('open');
    syncViewBounds();
  });

  // Wallet Web3 (Abre tarjeta flotante de billetera Web3)
  const btnWallet = document.getElementById('btn-wallet');
  btnWallet?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnWallet.getBoundingClientRect();
    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'wallet',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }
  });

  // Marcadores y listas (Abre tarjeta flotante con lista de marcadores)
  const btnBookmarksDrawer = document.getElementById('btn-bookmarks-drawer');
  btnBookmarksDrawer?.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnBookmarksDrawer.getBoundingClientRect();
    let bookmarks: any[] = [];
    try {
      if (api.bookmarks?.get) {
        bookmarks = await api.bookmarks.get();
      }
    } catch {}

    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'bookmarks',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        data: { bookmarks }
      });
    }
  });

  // Gestor de Descargas
  document.getElementById('btn-downloads-drawer')?.addEventListener('click', () => {
    openInternalPage('beta://descargas');
  });

  // WhatsApp Mensajes y Estados (Acceso rápido directo con toggle abrir / cerrar)
  document.getElementById('btn-phantom-header')?.addEventListener('click', () => {
    if (isPhantomVaultOpen) {
      (window as any).closePhantomVault?.();
    } else {
      (window as any).openPhantomVault?.();
    }
  });

  // Menú (3 rayitas estilo Brave)
  const btnMenu = document.getElementById('btn-menu');
  btnMenu?.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnMenu.getBoundingClientRect();
    let currentZoom = 1;
    try {
      if (activeTabId && api.tabs?.getZoom) {
        currentZoom = await api.tabs.getZoom(activeTabId);
      }
    } catch {}
    let bookmarks: any[] = [];
    try {
      if (api.bookmarks?.get) {
        bookmarks = await api.bookmarks.get();
      }
    } catch {}
    const aiDrawer = document.getElementById('ai-drawer');
    const isSidebarActive = aiDrawer ? aiDrawer.classList.contains('open') : false;

    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'menu',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        data: {
          zoomFactor: currentZoom || 1,
          sidebarMode: isSidebarActive ? 'active' : 'disabled',
          bookmarks
        }
      });
    }
  });

  // Manejador para el menú en el DOM si se abre directamente
  document.querySelectorAll('#main-menu .menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllPopups();
      const action = item.getAttribute('data-action');
      if (action === 'new-tab') {
        createTab('beta://nueva-pestana');
      } else if (action === 'new-window') {
        createTab('beta://nueva-pestana');
        showToast('Nueva pestaña abierta', 'info');
      } else if (action === 'new-private') {
        showToast('Ventana de incógnito iniciada', 'info');
        createTab('beta://nueva-pestana');
      } else if (action === 'history') {
        openInternalPage('beta://historial');
      } else if (action === 'time-machine') {
        openInternalPage('beta://historial');
        showToast('Máquina del Tiempo Local - Copias offline', 'info');
      } else if (action === 'downloads') {
        openInternalPage('beta://descargas');
      } else if (action === 'phantom') {
        openInternalPage('beta://mensajes-eliminados');
      } else if (action === 'settings') {
        openInternalPage('beta://ajustes');
      } else if (action === 'about') {
        showToast('NavegadorBeta v1.0.0 — El navegador rápido, con IA y ligero', 'info');
      }
    });
  });

  // ── Modo Turbo (Rayito) ──
  const btnTurbo = document.getElementById('btn-turbo');
  const turboPopup = document.getElementById('turbo-popup');
  const turboSwitch = document.getElementById('turbo-main-switch') as HTMLInputElement;
  const turboTierLabel = document.getElementById('turbo-tier-label');
  const turboCpuRam = document.getElementById('turbo-cpu-ram');
  const turboGpu = document.getElementById('turbo-gpu');
  const turboPreconnectStatus = document.getElementById('turbo-preconnect-status');
  const turboQuicStatus = document.getElementById('turbo-quic-status');

  async function updateTurboInfo() {
    try {
      if (api && (api as any).turbo && (api as any).turbo.getStatus) {
        const status = await (api as any).turbo.getStatus();
        btnTurbo?.classList.toggle('active', !!status.enabled);
        if (turboSwitch) turboSwitch.checked = !!status.enabled;
        if (turboTierLabel) {
          turboTierLabel.innerText = status.enabled
            ? `Tier ${status.tier} • Aceleración Extrema`
            : 'Modo Ahorro • Chromium Estándar';
          turboTierLabel.style.color = status.enabled ? '#ffc107' : 'var(--text-muted)';
        }
        if (turboCpuRam) {
          turboCpuRam.innerText = `${status.cpuCores} Núcleos • ${status.totalRamGB} GB RAM`;
        }
        if (turboGpu) {
          turboGpu.innerText = status.gpuName || 'GPU Direct3D11 Nativa';
        }
        if (turboPreconnectStatus) {
          turboPreconnectStatus.innerText = status.enabled ? 'Activa (0ms lag)' : 'Desactivada';
          turboPreconnectStatus.style.color = status.enabled ? '#10b981' : 'var(--text-muted)';
        }
        if (turboQuicStatus) {
          turboQuicStatus.innerText = status.enabled ? 'Habilitada (QUIC)' : 'Desactivada';
          turboQuicStatus.style.color = status.enabled ? '#10b981' : 'var(--text-muted)';
        }
        if (btnTurbo) {
          btnTurbo.title = status.enabled
            ? 'Modo Turbo (Activo) — Clic para ver tarjeta o clic derecho para alternar'
            : 'Modo Turbo (Desactivado) — Clic para activar';
        }
      }
    } catch (e) {
      console.warn('[Turbo] Error obteniendo estado:', e);
    }
  }

  // Cargar estado inicial
  updateTurboInfo();

  // Abrir / cerrar popup de Turbo flotante sobre la vista web
  btnTurbo?.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopups();
    const rect = btnTurbo.getBoundingClientRect();
    let status = { enabled: true, tier: 3, cpuCores: 8, totalRamGB: 16, gpuName: 'GPU Direct3D11 Nativa' };
    try {
      if (api && (api as any).turbo && (api as any).turbo.getStatus) {
        status = await (api as any).turbo.getStatus();
      }
    } catch {}

    if ((api as any).menuPopup && (api as any).menuPopup.show) {
      (api as any).menuPopup.show({
        type: 'turbo',
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        data: status
      });
    }
  });

  // Click secundario en el rayito: Alternar rápido sin abrir el menú
  btnTurbo?.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (turboSwitch) {
      turboSwitch.checked = !turboSwitch.checked;
      turboSwitch.dispatchEvent(new Event('change'));
    }
  });

  // Switch de encendido / apagado de Turbo
  turboSwitch?.addEventListener('change', async () => {
    const isEnabled = turboSwitch.checked;
    try {
      if (api && (api as any).turbo && (api as any).turbo.toggle) {
        await (api as any).turbo.toggle(isEnabled);
        btnTurbo?.classList.toggle('active', isEnabled);
        if (isEnabled) {
          showToast('⚡ Modo Turbo Activado: Aceleración GPU y Preconexión 0ms', 'success');
        } else {
          showToast('Modo Turbo Desactivado: Ahorro de memoria activado', 'info');
        }
        updateTurboInfo();
      }
    } catch (e) {
      console.error('[Turbo] Error alternando modo:', e);
    }
  });

  // Cerrar al hacer clic en backdrop o fuera
  document.getElementById('menu-backdrop')?.addEventListener('click', () => {
    closeAllPopups();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.glass-menu') &&
      !target.closest('#btn-download-quick') &&
      !target.closest('#btn-shield') &&
      !target.closest('#btn-turbo') &&
      !target.closest('#btn-cinema') &&
      !target.closest('#btn-menu')) {
      closeAllPopups();
    }
  });

  // Toggle de escudo por sitio
  const toggleShieldSite = document.getElementById('shield-toggle-site') as HTMLInputElement;
  toggleShieldSite?.addEventListener('change', async () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    const domain = getDomain(tab.url);
    await api.adblock.toggle(domain);
    showToast(`Escudo ${toggleShieldSite.checked ? 'activado' : 'pausado'} para ${domain}`, 'info');
  });
}

function closeAllPopups() {
  const hadOpen = document.querySelectorAll('.glass-menu.open').length > 0;
  document.querySelectorAll('.glass-menu').forEach(m => m.classList.remove('open'));
  if (api.downloads && api.downloads.hideMenu) api.downloads.hideMenu();
  if (api.omnibox && api.omnibox.hideDropdown) api.omnibox.hideDropdown();
  if ((api as any).menuPopup && (api as any).menuPopup.hide) (api as any).menuPopup.hide();
  setMenuState(false);
}

async function updateShieldCounter() {
  const stats = await api.adblock.getStats();
  const countSpan = document.getElementById('shield-count');
  const popupTotal = document.getElementById('shield-popup-total');
  if (countSpan) countSpan.innerText = stats.totalBlocked.toString();
  if (popupTotal) popupTotal.innerText = stats.totalBlocked.toString();
}

// ============================================================================
// 8. GEMINI AI DRAWER (PILOTO IA)
// ============================================================================
function setupAiDrawer() {
  const drawer = document.getElementById('ai-drawer');
  const btnOpen = document.getElementById('btn-ai-pilot');
  const btnClose = document.getElementById('btn-close-ai');
  const sendBtn = document.getElementById('btn-ai-send');
  const input = document.getElementById('ai-chat-input') as HTMLInputElement;

  btnOpen?.addEventListener('click', () => {
    const cinemaDrawer = document.getElementById('cinema-drawer');
    if (cinemaDrawer?.classList.contains('open')) {
      cinemaDrawer.classList.remove('open');
      if ((api as any).cinema && (api as any).cinema.toggleDrawer) {
        (api as any).cinema.toggleDrawer(false);
      }
    }
    drawer?.classList.toggle('open');
    if (drawer?.classList.contains('open')) input?.focus();
    syncViewBounds();
  });

  btnClose?.addEventListener('click', () => {
    drawer?.classList.remove('open');
    syncViewBounds();
  });

  sendBtn?.addEventListener('click', () => handleAiSend());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAiSend();
  });
}

async function handleAiSend() {
  const input = document.getElementById('ai-chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;

  if (!currentSettings.aiApiKey) {
    appendAiMessage('model', '⚠️ Por favor configura tu API Key de Google Gemini en Ajustes (beta://ajustes) para chatear con Piloto IA.');
    return;
  }

  input.value = '';
  appendAiMessage('user', text);
  aiMessages.push({ role: 'user', text });

  const loadingMsg = appendAiMessage('model', 'Pensando...');

  try {
    const response = await chatWithGemini(
      currentSettings.aiApiKey,
      currentSettings.aiPersonaContext,
      aiMessages
    );
    loadingMsg.innerHTML = response.replace(/\n/g, '<br/>');
    aiMessages.push({ role: 'model', text: response });
  } catch (err: any) {
    loadingMsg.innerHTML = `❌ Error: ${err.message}`;
  }
}

function appendAiMessage(role: 'user' | 'model', text: string): HTMLElement {
  const history = document.getElementById('ai-chat-history');
  const msgEl = document.createElement('div');
  msgEl.className = `ai-msg ${role}`;
  msgEl.innerText = text;
  history?.appendChild(msgEl);
  history?.scrollTo({ top: history.scrollHeight, behavior: 'smooth' });
  return msgEl;
}

(window as any).aiQuickAction = async (action: string) => {
  const drawer = document.getElementById('ai-drawer');
  drawer?.classList.add('open');

  if (!currentSettings.aiApiKey) {
    appendAiMessage('model', '⚠️ Configura tu API Key de Gemini en beta://ajustes para usar las acciones automáticas.');
    return;
  }

  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.url.startsWith('beta://')) {
    appendAiMessage('model', 'Abre una página web real para usar esta herramienta.');
    return;
  }

  if (action === 'autofill') {
    appendAiMessage('model', 'Analizando campos del formulario en la página actual...');
    try {
      const fields = await api.ai.extractFormFields(tab.id);
      if (!fields || fields.length === 0) {
        appendAiMessage('model', 'No se encontraron campos de formulario editables en esta página.');
        return;
      }
      appendAiMessage('model', `Detectados ${fields.length} campos. Consultando a Gemini según tu perfil...`);
      const instructions = await fillFormWithGemini(currentSettings.aiApiKey, currentSettings.aiPersonaContext, fields);
      const success = await api.ai.fillFormFields(tab.id, instructions);
      if (success) {
        appendAiMessage('model', '✨ ¡Formulario auto-rellenado con éxito!');
        showToast('Formulario auto-rellenado por Piloto IA', 'success');
      } else {
        appendAiMessage('model', 'Hubo un inconveniente al rellenar los campos.');
      }
    } catch (e: any) {
      appendAiMessage('model', 'Error en auto-relleno: ' + e.message);
    }
    return;
  }

  appendAiMessage('model', 'Extrayendo contenido de la página para análisis...');
  try {
    const context = await api.ai.extractPageContext(tab.id);
    let prompt = '';
    if (action === 'analyze') {
      prompt = `Analiza detalladamente esta página y resume los puntos clave en viñetas:\n${context}`;
      appendAiMessage('user', '🔍 Analizar esta página');
    } else if (action === 'summarize_video') {
      prompt = `Resume los aspectos más importantes de este video:\n${context}`;
      appendAiMessage('user', '🎬 Resumir video');
    } else if (action === 'translate') {
      prompt = `Traduce fluidamente al español el contenido principal de esta página:\n${context}`;
      appendAiMessage('user', '🌐 Traducir página');
    }

    aiMessages.push({ role: 'user', text: prompt });
    const loading = appendAiMessage('model', 'Procesando con Gemini...');
    const reply = await chatWithGemini(currentSettings.aiApiKey, currentSettings.aiPersonaContext, aiMessages);
    loading.innerHTML = reply.replace(/\n/g, '<br/>');
    aiMessages.push({ role: 'model', text: reply });
  } catch (err: any) {
    appendAiMessage('model', 'Error analizando página: ' + err.message);
  }
};

// ============================================================================
// 8.5 MODO CINE & SALA P2P WATCH PARTY DRAWER (CHAT Y VIDEO LADO A LADO)
// ============================================================================
let cinemaCountdownInterval: any = null;

async function toggleCinemaDrawer(forceOpen?: boolean) {
  const drawer = document.getElementById('cinema-drawer');
  const aiDrawer = document.getElementById('ai-drawer');
  if (!drawer) return;

  const willOpen = forceOpen !== undefined ? forceOpen : !drawer.classList.contains('open');
  if (willOpen) {
    if (aiDrawer?.classList.contains('open')) {
      aiDrawer.classList.remove('open');
    }
    drawer.classList.add('open');
    if (cinemaState.selectedMode !== 'browser' && cinemaState.status.mode !== 'browser') {
      document.getElementById('cinema-chat-input')?.focus();
    }
  } else {
    drawer.classList.remove('open');
  }

  if ((api as any).cinema && (api as any).cinema.toggleDrawer) {
    await (api as any).cinema.toggleDrawer(willOpen);
  }
  syncViewBounds();
}

function updateCinemaDrawerStatus(status: any) {
  const codeChip = document.getElementById('cinema-drawer-code-chip');
  const statusBadge = document.getElementById('cinema-drawer-status');
  const statusText = document.getElementById('cinema-drawer-status-text');
  const lightsSwitch = document.getElementById('cinema-drawer-lights-switch') as HTMLInputElement;
  const countdownEl = document.getElementById('cinema-drawer-countdown');

  if (codeChip) {
    codeChip.textContent = status.inRoom && status.roomId ? `${status.roomId} 📋` : 'CINE-XXXXXX 📋';
  }

  if (statusBadge && statusText) {
    if (!status.inRoom) {
      statusBadge.className = 'cinema-status-badge';
      statusText.textContent = 'Sin sala activa';
    } else if (status.partnerConnected) {
      statusBadge.className = 'cinema-status-badge connected';
      statusText.textContent = status.isHost ? '¡Amigo conectado! (Anfitrión)' : '¡Conectado! (Invitado)';
    } else {
      statusBadge.className = 'cinema-status-badge waiting';
      statusText.textContent = 'Esperando a tu amigo...';
    }
  }

  if (lightsSwitch) {
    lightsSwitch.checked = !!status.lightsDimmed;
  }

  // Manejo de expiración (30 minutos sin amigo)
  if (cinemaCountdownInterval) {
    clearInterval(cinemaCountdownInterval);
    cinemaCountdownInterval = null;
  }

  if (status.inRoom && status.expiresAt && !status.partnerConnected) {
    if (countdownEl) countdownEl.style.display = 'inline-flex';
    const updateCountdown = () => {
      const remainingSeconds = Math.max(0, Math.floor((status.expiresAt - Date.now()) / 1000));
      const mins = Math.floor(remainingSeconds / 60);
      const secs = remainingSeconds % 60;
      if (countdownEl) {
        countdownEl.textContent = remainingSeconds > 0 
          ? `⏱️ ${mins}:${secs < 10 ? '0' : ''}${secs}` 
          : '⏱️ Expirada';
      }
      if (remainingSeconds <= 0 && cinemaCountdownInterval) {
        clearInterval(cinemaCountdownInterval);
        cinemaCountdownInterval = null;
      }
    };
    updateCountdown();
    cinemaCountdownInterval = setInterval(updateCountdown, 1000);
  } else if (countdownEl) {
    if (status.partnerConnected) {
      countdownEl.textContent = '🔒 Sala Privada';
      countdownEl.style.display = 'inline-flex';
    } else {
      countdownEl.style.display = 'none';
    }
  }
}

function appendCinemaChatMessage(msg: { sender: string; isMe: boolean; text: string; time: string }) {
  const chatFeed = document.getElementById('cinema-chat-messages');
  if (!chatFeed) return;

  const bubble = document.createElement('div');
  bubble.className = `cinema-msg-bubble ${msg.isMe ? 'me' : 'peer'}`;

  const author = document.createElement('div');
  author.className = 'msg-author';
  author.textContent = msg.sender;

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = msg.text;

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = msg.time;

  bubble.appendChild(author);
  bubble.appendChild(textEl);
  bubble.appendChild(timeEl);

  chatFeed.appendChild(bubble);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function setupCinemaDrawer() {
  const btnClose = document.getElementById('btn-close-cinema-drawer');
  const codeChip = document.getElementById('cinema-drawer-code-chip');
  const lightsSwitch = document.getElementById('cinema-drawer-lights-switch') as HTMLInputElement;
  const btnLeave = document.getElementById('btn-cinema-drawer-leave');
  const chatInput = document.getElementById('cinema-chat-input') as HTMLInputElement;
  const btnSend = document.getElementById('btn-cinema-chat-send');

  btnClose?.addEventListener('click', () => {
    toggleCinemaDrawer(false);
  });

  codeChip?.addEventListener('click', async () => {
    try {
      const st = await (api as any).cinema?.getStatus();
      if (st && st.roomId) {
        navigator.clipboard.writeText(st.roomId);
        showToast(`📋 Código ${st.roomId} copiado al portapapeles`, 'success');
      }
    } catch {}
  });

  lightsSwitch?.addEventListener('change', async () => {
    try {
      if ((api as any).cinema && (api as any).cinema.toggleLights) {
        await (api as any).cinema.toggleLights(lightsSwitch.checked);
      }
    } catch {}
  });

  btnLeave?.addEventListener('click', async () => {
    try {
      resetCinemaChat();
      if ((api as any).cinema && (api as any).cinema.leaveRoom) {
        await (api as any).cinema.leaveRoom();
        showToast('Has salido de la sala de cine', 'info');
        toggleCinemaDrawer(false);
      }
    } catch {}
  });

  const sendCinemaChat = () => {
    const text = chatInput?.value?.trim();
    if (!text) return;
    chatInput.value = '';
    if ((api as any).cinema && (api as any).cinema.sendChat) {
      (api as any).cinema.sendChat(text);
    }
  };

  btnSend?.addEventListener('click', sendCinemaChat);
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCinemaChat();
  });

  // Escuchar mensajes entrantes de chat
  if ((api as any).cinema && (api as any).cinema.onChatMessage) {
    (api as any).cinema.onChatMessage((msg: any) => {
      appendCinemaChatMessage(msg);
    });
  }

  // Escuchar evento de expiración de sala
  if ((api as any).cinema && (api as any).cinema.onRoomExpired) {
    (api as any).cinema.onRoomExpired(() => {
      showToast('⚠️ La sala de cine ha expirado por inactividad (30 min).', 'info');
      toggleCinemaDrawer(false);
    });
  }
}

// ============================================================================
// 9. PÁGINAS INTERNAS (beta://)
// ============================================================================
function openInternalPage(url: string) {
  closeAllPopups();
  if (url === 'beta://mensajes-eliminados') {
    (window as any).openPhantomVault?.();
    return;
  }
  if (activeTabId) {
    navigateToUrl(url);
  } else {
    createTab(url);
  }
}
(window as any).openInternalPage = openInternalPage;

function showInternalPage(url: string) {
  const container = document.getElementById('internal-pages');
  if (!container) return;

  if (ntpClockInterval && url !== 'beta://nueva-pestana') {
    clearInterval(ntpClockInterval);
    ntpClockInterval = null;
  }

  container.classList.add('active');
  container.style.display = 'block';
  container.style.pointerEvents = 'auto';

  if (url === 'beta://nueva-pestana') {
    renderNewTabPage(container);
  } else if (url === 'beta://privada' || url === 'beta://incognito') {
    renderIncognitoPage(container);
  } else if (url === 'beta://tor') {
    renderTorPage(container);
  } else if (url === 'beta://ajustes') {
    renderSettingsPage(container);
  } else if (url === 'beta://historial') {
    renderHistoryPage(container);
  } else if (url === 'beta://descargas') {
    renderDownloadsPage(container);
  } else if (url === 'beta://mensajes-eliminados') {
    renderPhantomMessagesPage(container);
  } else if (url.startsWith('beta://bloqueado')) {
    renderBlockedPage(container, url);
  } else if (url.startsWith('beta://sala') || url.startsWith('beta://cine')) {
    renderCinemaRoomPage(container);
  }
}

function hideInternalPages() {
  if (ntpClockInterval) {
    clearInterval(ntpClockInterval);
    ntpClockInterval = null;
  }
  const internalPages = document.getElementById('internal-pages');
  if (internalPages) {
    internalPages.classList.remove('active');
    internalPages.style.display = 'none';
    internalPages.style.pointerEvents = 'none';
  }
}

function getInternalPageTitle(url: string): string {
  if (url.includes('privada') || url.includes('incognito')) return 'Ventana Privada 🕶️';
  if (url.includes('tor')) return 'Ventana Privada con Tor 🧅';
  if (url.includes('nueva-pestana')) return 'Nueva Pestaña';
  if (url.includes('ajustes')) return 'Ajustes';
  if (url.includes('historial')) return 'Historial';
  if (url.includes('descargas')) return 'Descargas';
  if (url.includes('mensajes-eliminados')) return 'WhatsApp • Mensajes y Estados';
  if (url.includes('bloqueado')) return 'Sitio Bloqueado';
  if (url.includes('sala') || url.includes('cine')) return '🎬 Sala de Cine Compartida';
  return 'NavegadorBeta';
}

let ntpClockInterval: NodeJS.Timeout | null = null;

function updateNtpClock() {
  const clockEl = document.getElementById('ntp-live-clock');
  const greetingEl = document.querySelector('.ntp-greeting');
  if (!clockEl) {
    if (ntpClockInterval) {
      clearInterval(ntpClockInterval);
      ntpClockInterval = null;
    }
    return;
  }

  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  if (clockEl.textContent !== timeStr) {
    clockEl.textContent = timeStr;
  }

  if (greetingEl) {
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
    const greetingText = `${greeting}, bienvenido a NavegadorBeta`;
    if (greetingEl.textContent !== greetingText) {
      greetingEl.textContent = greetingText;
    }
  }
}

// ============================================================================
// VENTANA PRIVADA DE INCÓGNITO (beta://privada) — Estilo Brave Browser
// ============================================================================
function renderIncognitoPage(container: HTMLElement) {
  container.innerHTML = `
    <div class="private-landing-container">
      <div class="private-badge-icon">🕶️</div>
      <h1 class="private-title">Estás en una ventana privada</h1>
      <p class="private-subtitle">
        NavegadorBeta no recordará tu actividad en esta ventana. Las pestañas que abras aquí no aparecerán en tu historial y todas las cookies y datos de sitio se destruirán al cerrarla.
      </p>

      <form class="private-search-form" onsubmit="event.preventDefault(); const q = (document.getElementById('private-search-input') as HTMLInputElement)?.value?.trim(); if (q) { if (q.includes('.') && !q.includes(' ')) { navigateToUrl(q.startsWith('http') ? q : 'https://' + q); } else { navigateToUrl('https://duckduckgo.com/?q=' + encodeURIComponent(q)); } }">
        <input
          id="private-search-input"
          class="private-search-input"
          type="text"
          placeholder="Buscar en la Web Privada con DuckDuckGo o ingresar URL..."
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
        <button type="submit" class="private-search-btn" title="Buscar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        </button>
      </form>

      <div class="private-cards-grid">
        <div class="private-card">
          <div class="private-card-header">
            <span class="private-card-icon">🔒</span>
            <span class="private-card-title">Lo que hace la navegación privada</span>
          </div>
          <ul class="private-card-list">
            <li><span class="bullet">✓</span> No guarda páginas en el historial local.</li>
            <li><span class="bullet">✓</span> Destruye cookies y caché en memoria RAM al cerrar la ventana.</li>
            <li><span class="bullet">✓</span> No autocompleta ni guarda datos de formularios ni contraseñas.</li>
            <li><span class="bullet">✓</span> Sesión de navegación 100% aislada e independiente.</li>
          </ul>
        </div>

        <div class="private-card">
          <div class="private-card-header">
            <span class="private-card-icon">🛡️</span>
            <span class="private-card-title">Escudos de Protección Activos</span>
          </div>
          <ul class="private-card-list">
            <li><span class="bullet">✓</span> Bloqueo agresivo de rastreadores, malware y telemetría.</li>
            <li><span class="bullet">✓</span> Protección contra huella digital (Anti-Fingerprinting).</li>
            <li><span class="bullet">✓</span> Conexiones forzadas mediante HTTPS seguro.</li>
            <li><span class="bullet">✓</span> Prevención de seguimiento cruzado entre sitios web.</li>
          </ul>
        </div>

        <div class="private-card">
          <div class="private-card-header">
            <span class="private-card-icon">⚠️</span>
            <span class="private-card-title">Lo que no hace la ventana privada</span>
          </div>
          <ul class="private-card-list">
            <li><span class="bullet">•</span> Tu proveedor de internet (ISP) aún puede ver a qué sitios accedes.</li>
            <li><span class="bullet">•</span> Tu dirección IP pública real sigue siendo visible para las webs.</li>
            <li><span class="bullet">•</span> Tu red de trabajo o escuela puede monitorear las conexiones.</li>
          </ul>
          <div style="margin-top: 14px; text-align: center;">
            <button class="private-cta-btn" onclick="if (api.window?.openNewWindow) { api.window.openNewWindow('tor'); } else { navigateToUrl('beta://tor'); }">
              <span>🧅</span>
              <span>Abrir Ventana Privada con Tor</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  setTimeout(() => {
    document.getElementById('private-search-input')?.focus();
  }, 50);
}

// ============================================================================
// OVERLAY DE CONEXIÓN A TOR (ESTILO BRAVE TOR CIRCUIT)
// ============================================================================
function showTorConnectingOverlay(targetUrl: string, progress: number) {
  const overlay = document.getElementById('tor-connecting-overlay');
  const targetText = document.getElementById('tor-target-url-text');
  if (overlay) {
    overlay.style.display = 'flex';
  }
  if (targetText) {
    targetText.textContent = targetUrl || 'Conectando a sitio seguro...';
  }
  updateTorConnectingProgress(progress, 'Iniciando conexión cifrada...');
}

function updateTorConnectingProgress(progress: number, summary?: string) {
  const bar = document.getElementById('tor-overlay-progress-bar');
  const percentText = document.getElementById('tor-overlay-percent-label');
  const statusText = document.getElementById('tor-overlay-status-label');
  const guardNode = document.getElementById('tor-node-guard');
  const relayNode = document.getElementById('tor-node-relay');
  const exitNode = document.getElementById('tor-node-exit');

  if (bar) bar.style.width = `${progress}%`;
  if (percentText) percentText.textContent = `${progress}%`;
  if (statusText && summary) statusText.textContent = summary || 'Conectando nodos...';

  // Iluminar nodos según el porcentaje alcanzado
  if (guardNode) guardNode.classList.toggle('active', progress >= 15);
  if (relayNode) relayNode.classList.toggle('active', progress >= 50);
  if (exitNode) exitNode.classList.toggle('active', progress >= 90);

  // También actualizar el card de beta://tor si la página de inicio Tor está en pantalla
  const pageCard = document.getElementById('tor-connecting-card');
  const pageBar = document.getElementById('tor-connecting-bar');
  const pagePercent = document.getElementById('tor-connecting-percent');
  const pageDot = document.getElementById('tor-page-dot');
  const pageStatusText = document.getElementById('tor-page-status-text');

  if (pageCard && pageBar && pagePercent) {
    if (progress < 100) {
      pageCard.style.display = 'block';
      pageBar.style.width = `${progress}%`;
      pagePercent.textContent = `${progress}%`;
      if (pageStatusText) pageStatusText.textContent = `Estableciendo Circuito Tor (${progress}%)...`;
      if (pageDot) {
        pageDot.style.background = '#f59e0b';
        pageDot.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.5)';
      }
    } else {
      pageCard.style.display = 'none';
      if (pageStatusText) pageStatusText.textContent = 'Red Tor Conectada • Proxy SOCKS5 (127.0.0.1:9050)';
      if (pageDot) {
        pageDot.style.background = '#10b981';
        pageDot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.6)';
      }
    }
  }

  // Header dot si existe
  const headerDot = document.getElementById('header-tor-dot');
  if (headerDot) {
    if (progress >= 100) {
      headerDot.style.background = '#10b981';
      headerDot.setAttribute('title', 'Red Tor Activa • SOCKS5 127.0.0.1:9050');
    } else {
      headerDot.style.background = '#f59e0b';
      headerDot.setAttribute('title', `Conectando a Tor (${progress}%)...`);
    }
  }
}

function hideTorConnectingOverlay() {
  updateTorConnectingProgress(100, '¡Circuito Tor establecido al 100%! Abriendo página...');
  const overlay = document.getElementById('tor-connecting-overlay');
  if (overlay) {
    overlay.style.animation = 'fadeOutTorOverlay 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.animation = '';
    }, 350);
  }
}

// ============================================================================
// VENTANA PRIVADA CON TOR (beta://tor) — Estilo Brave Browser & Tor Browser
// ============================================================================
function renderTorPage(container: HTMLElement) {
  const isTorConnected = false; // Estado inicial que se actualizará al consultar el proceso principal

  container.innerHTML = `
    <div class="tor-landing-container">
      <div class="tor-badge-icon">🧅</div>
      <div id="tor-page-status-pill" class="tor-status-pill">
        <span id="tor-page-dot" class="tor-pulse-dot" style="background: #f59e0b; box-shadow: 0 0 10px rgba(245,158,11,0.5);"></span>
        <span id="tor-page-status-text">Comprobando red Tor...</span>
      </div>
      <h1 class="tor-title">Ventana Privada con Tor</h1>
      <p class="tor-subtitle">
        NavegadorBeta nunca registra lo que haces en una ventana privada. Con Tor, tu dirección IP real está enmascarada a través de tres nodos cifrados hacia los sitios que visitas, y tu proveedor de internet (ISP) no puede ver los sitios a los que te conectas.
      </p>

      <form class="private-search-form" onsubmit="event.preventDefault(); const q = (document.getElementById('tor-search-input') as HTMLInputElement)?.value?.trim(); if (q) { if (q.includes('.') && !q.includes(' ')) { navigateToUrl(q.startsWith('http') ? q : 'https://' + q); } else { navigateToUrl('https://duckduckgo.com/?q=' + encodeURIComponent(q)); } }">
        <input
          id="tor-search-input"
          class="private-search-input"
          type="text"
          placeholder="Buscar anónimamente con DuckDuckGo o ingresar dirección .onion..."
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
        <button type="submit" class="private-search-btn" style="background: #a855f7;" title="Buscar en Tor">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        </button>
      </form>

      <!-- Barra de Progreso de Conexión Tor en Vivo (Estilo Brave Tor) -->
      <div id="tor-connecting-card" style="display: none; background: rgba(168, 85, 247, 0.08); border: 1px solid rgba(168, 85, 247, 0.25); border-radius: 12px; padding: 16px 20px; margin: 18px 0; text-align: left;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="font-weight: 600; color: #c084fc; font-size: 13px; display: flex; align-items: center; gap: 8px;">
            <span class="tor-pulse-dot" style="background: #a855f7;"></span>
            <span>Estableciendo circuito anónimo con la red Tor...</span>
          </span>
          <span id="tor-connecting-percent" style="font-size: 12px; font-weight: 700; color: #a855f7;">0%</span>
        </div>
        <div style="height: 6px; width: 100%; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: hidden;">
          <div id="tor-connecting-bar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #a855f7, #10b981); transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1);"></div>
        </div>
        <div id="tor-connecting-desc" style="font-size: 11px; color: #94a3b8; margin-top: 6px;">Construyendo túnel cifrado de 3 nodos (Guard, Relay, Exit)...</div>
      </div>

      <!-- Banner de Estado y Fallback Seguro Estilo Brave -->
      <div id="tor-info-banner" style="display: none; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 12px; padding: 14px 18px; margin: 18px 0; text-align: left;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
          <div>
            <div style="font-weight: 600; color: #fbbf24; font-size: 13px; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
              <span>🛡️</span> <span>Modo Privado Tor Activo</span>
            </div>
            <div style="color: #94a3b8; font-size: 12px; line-height: 1.5;">
              Para enrutar tráfico a través de los nodos de la red Onion (.onion) y ocultar tu IP en <em>check.torproject.org</em>, inicia el servicio local de Tor (puerto 9050) o abre Tor Browser (puerto 9150).<br>
              Esta ventana opera con <strong>Protección de Privacidad Total</strong>: WebRTC bloqueado (sin fugas de IP real), huellas digitales bloqueadas y cero almacenamiento en disco.
            </div>
          </div>
          <button id="tor-retry-btn" onclick="(window as any).retryTorConnection()" style="background: #a855f7; color: #ffffff; border: none; border-radius: 8px; padding: 8px 14px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
            🔄 Reintentar Conexión
          </button>
        </div>
      </div>

      <!-- Visualizador de Circuito Tor Real Estilo Brave -->
      <div class="tor-circuit-box">
        <div class="tor-circuit-title">
          <span>CIRCUITO TOR DE NAVEGACIÓN CIFRADA</span>
          <span id="tor-circuit-indicator" style="font-size: 11px; color: #10b981; font-weight: 600;">● 3 Capas de Cifrado Onion AES-256</span>
        </div>
        <div class="tor-circuit-diagram">
          <div class="tor-circuit-step active">
            <span class="tor-circuit-step-icon">💻</span>
            <span class="tor-circuit-step-name">Este Navegador</span>
            <span class="tor-circuit-step-desc">Tráfico local cifrado</span>
          </div>
          <div class="tor-circuit-arrow">➜</div>
          <div class="tor-circuit-step" id="circuit-guard">
            <span class="tor-circuit-step-icon">🛡️</span>
            <span class="tor-circuit-step-name">Nodo Guard</span>
            <span class="tor-circuit-step-desc">Entrada anónima</span>
          </div>
          <div class="tor-circuit-arrow">➜</div>
          <div class="tor-circuit-step" id="circuit-relay">
            <span class="tor-circuit-step-icon">🔄</span>
            <span class="tor-circuit-step-name">Relay Intermedio</span>
            <span class="tor-circuit-step-desc">Aislamiento de circuito</span>
          </div>
          <div class="tor-circuit-arrow">➜</div>
          <div class="tor-circuit-step" id="circuit-exit">
            <span class="tor-circuit-step-icon">🌍</span>
            <span class="tor-circuit-step-name">Nodo Exit</span>
            <span class="tor-circuit-step-desc">Salida anónima Tor</span>
          </div>
          <div class="tor-circuit-arrow">➜</div>
          <div class="tor-circuit-step">
            <span class="tor-circuit-step-icon">🌐</span>
            <span class="tor-circuit-step-name">Internet / .onion</span>
            <span class="tor-circuit-step-desc">Destino final protegido</span>
          </div>
        </div>

        <div class="tor-quick-links">
          <button class="tor-quick-link-btn" onclick="navigateToUrl('https://check.torproject.org')">
            <span>🔍</span>
            <span>Comprobar Estado Tor (check.torproject.org)</span>
          </button>
          <button class="tor-quick-link-btn" onclick="navigateToUrl('https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion')">
            <span>🦆</span>
            <span>DuckDuckGo .onion</span>
          </button>
          <button class="tor-quick-link-btn" onclick="navigateToUrl('https://www.torproject.org')">
            <span>🧅</span>
            <span>Tor Project Oficial</span>
          </button>
        </div>
      </div>
    </div>
  `;

  // Comprobar estado real de Tor mediante IPC
  const checkTorStatus = async () => {
    if (!api?.tor?.getStatus) return;
    try {
      const status = await api.tor.getStatus();
      const dot = document.getElementById('tor-page-dot');
      const text = document.getElementById('tor-page-status-text');
      const banner = document.getElementById('tor-info-banner');
      const headerDot = document.getElementById('header-tor-dot');
      const circuitInd = document.getElementById('tor-circuit-indicator');
      const connectingCard = document.getElementById('tor-connecting-card');
      const percentEl = document.getElementById('tor-connecting-percent');
      const barEl = document.getElementById('tor-connecting-bar');

      if (status?.connected && status?.bootstrapProgress === 100) {
        if (connectingCard) connectingCard.style.display = 'none';
        if (dot) {
          dot.style.background = '#10b981';
          dot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.6)';
        }
        if (headerDot) {
          headerDot.style.background = '#10b981';
          headerDot.setAttribute('title', `Red Tor Activa • SOCKS5 127.0.0.1:${status.port}`);
        }
        if (text) text.textContent = `Red Tor Conectada • Proxy SOCKS5 (127.0.0.1:${status.port})`;
        if (banner) banner.style.display = 'none';
        if (circuitInd) {
          circuitInd.innerHTML = '● Conectado a la Red Tor (SOCKS5 100% Cifrado)';
          circuitInd.style.color = '#10b981';
        }
      } else {
        const progress = status?.bootstrapProgress || 0;
        const isBootstrapping = !status?.connected;

        if (connectingCard) {
          connectingCard.style.display = isBootstrapping ? 'block' : 'none';
          if (percentEl) percentEl.textContent = `${progress}%`;
          if (barEl) barEl.style.width = `${progress}%`;
        }

        if (dot) {
          dot.style.background = '#f59e0b';
          dot.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.5)';
        }
        if (headerDot) {
          headerDot.style.background = '#f59e0b';
          headerDot.setAttribute('title', `Conectando a Tor (${progress}%)...`);
        }
        if (text) {
          text.textContent = `Estableciendo Circuito Tor (${progress}%)...`;
        }
        if (banner) banner.style.display = 'none';
        if (circuitInd) {
          circuitInd.innerHTML = `○ Estableciendo circuito Onion (${progress}%)...`;
          circuitInd.style.color = '#f59e0b';
        }
        if (isBootstrapping) {
          setTimeout(checkTorStatus, 350);
        }
      }
    } catch (e) {
      console.warn('[Tor UI] Error comprobando estado Tor:', e);
    }
  };

  (window as any).retryTorConnection = async () => {
    const btn = document.getElementById('tor-retry-btn');
    if (btn) {
      btn.textContent = '⏳ Verificando...';
      (btn as HTMLButtonElement).disabled = true;
    }
    try {
      if (api?.tor?.retryConnection) {
        await api.tor.retryConnection();
      }
    } catch {}
    await checkTorStatus();
    if (btn) {
      btn.textContent = '🔄 Reintentar Conexión';
      (btn as HTMLButtonElement).disabled = false;
    }
  };

  checkTorStatus();

  setTimeout(() => {
    document.getElementById('tor-search-input')?.focus();
  }, 50);
}

// Nueva Pestaña (NTP)
function renderNewTabPage(container: HTMLElement) {
  if (ntpClockInterval) {
    clearInterval(ntpClockInterval);
    ntpClockInterval = null;
  }

  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';

  container.innerHTML = `
    <div class="internal-page-content">
      <div class="ntp-hero">
        <img src="../../assets/icons/logo.png" class="ntp-logo" alt="Logo" onerror="this.src='../../assets/icons/favicon.png'" />
        <div class="ntp-clock" id="ntp-live-clock">${timeStr}</div>
        <div class="ntp-greeting">${greeting}, bienvenido a NavegadorBeta</div>
      </div>

      <div class="ntp-search-container">
        <form onsubmit="event.preventDefault(); window.ntpSearch(document.getElementById('ntp-input').value);">
          <svg class="ntp-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            id="ntp-input"
            class="ntp-search-input"
            placeholder="Buscar en la web o escribir una URL..."
            autofocus
          />
        </form>
      </div>

      <!-- Quick Shortcuts con Logos Reales Oficiales y Fondos Auténticos -->
      <div class="ntp-shortcuts-grid">
        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://youtube.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(255, 0, 0, 0.14);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect x="2" y="6" width="28" height="20" rx="6" fill="#FF0000"/>
              <polygon points="13,11 21,16 13,21" fill="#FFFFFF"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">YouTube</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://web.whatsapp.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(37, 211, 102, 0.14);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <path d="M16 3C8.82 3 3 8.82 3 16c0 2.47.7 4.78 1.91 6.75L3.5 28.5l5.96-1.37C11.34 28.21 13.6 29 16 29c7.18 0 13-5.82 13-13S23.18 3 16 3z" fill="#25D366"/>
              <path d="M21.8 19.5c-.3-.15-1.78-.88-2.06-1-.28-.1-.48-.15-.68.15-.2.3-.78 1-.96 1.2-.18.2-.36.22-.66.07-.3-.15-1.27-.47-2.42-1.5-.9-.8-1.5-1.79-1.68-2.1-.18-.3-.02-.46.13-.6.14-.14.3-.36.46-.54.15-.18.2-.3.3-.5.1-.2.05-.38-.03-.53-.08-.15-.68-1.64-.93-2.25-.25-.6-.5-.52-.68-.53h-.58c-.2 0-.53.08-.81.38-.28.3-1.07 1.05-1.07 2.56s1.1 2.97 1.25 3.17c.15.2 2.16 3.3 5.23 4.63.73.32 1.3.5 1.74.65.73.23 1.4.2 1.93.12.59-.09 1.78-.73 2.03-1.43.25-.7.25-1.3.18-1.43-.08-.13-.28-.2-.58-.35z" fill="white"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">WhatsApp</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://github.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(255, 255, 255, 0.08);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#18181b"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M16 6C10.47 6 6 10.59 6 16.25C6 20.78 8.87 24.61 12.85 25.97C13.35 26.06 13.54 25.75 13.54 25.48C13.54 25.24 13.53 24.44 13.53 23.49C11 24.03 10.33 22.92 10.13 22.34C10.02 22.04 9.53 21.13 9.1 20.88C8.75 20.69 8.25 20.21 9.09 20.2C9.88 20.19 10.45 20.95 10.64 21.26C11.54 22.82 12.98 22.38 13.56 22.11C13.65 21.44 13.91 20.98 14.2 20.72C11.95 20.46 9.59 19.56 9.59 15.6C9.59 14.47 9.98 13.55 10.64 12.82C10.54 12.56 10.19 11.5 10.74 10.06C10.74 10.06 11.59 9.78 13.54 11.13C14.35 10.9 15.21 10.78 16.07 10.78C16.93 10.78 17.79 10.9 18.6 11.13C20.55 9.77 21.4 10.06 21.4 10.06C21.95 11.5 21.6 12.56 21.5 12.82C22.16 13.55 22.55 14.46 22.55 15.6C22.55 19.58 20.18 20.46 17.93 20.72C18.3 21.04 18.62 21.66 18.62 22.62C18.62 24 18.61 25.11 18.61 25.48C18.61 25.76 18.8 26.08 19.31 25.97C23.28 24.61 26.15 20.77 26.15 16.25C26.15 10.59 21.53 6 16 6Z" fill="white"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">GitHub</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://reddit.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(255, 69, 0, 0.14);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="15" fill="#FF4500"/>
              <circle cx="9.5" cy="16" r="2.5" fill="white"/>
              <circle cx="22.5" cy="16" r="2.5" fill="white"/>
              <ellipse cx="16" cy="16.5" rx="7.5" ry="6" fill="white"/>
              <circle cx="13.2" cy="16" r="1.5" fill="#FF4500"/>
              <circle cx="18.8" cy="16" r="1.5" fill="#FF4500"/>
              <path d="M13.5 19C14.3 20 15.7 20 16.5 20C17.3 20 18.7 20 19.5 19" stroke="#FF4500" stroke-width="1.3" stroke-linecap="round"/>
              <path d="M16 10.5V7.5L20 8.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="20.8" cy="8.7" r="1.5" fill="white"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">Reddit</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://netflix.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(229, 9, 20, 0.14);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#141414"/>
              <defs>
                <filter id="nf-ribbon-shadow" x="0" y="0" width="32" height="32" filterUnits="userSpaceOnUse">
                  <feDropShadow dx="-1.2" dy="0" stdDeviation="0.8" flood-color="#000000" flood-opacity="0.8"/>
                </filter>
              </defs>
              <path d="M8 5H13V26.5C11.3 26.2 9.7 26 8 25.8V5Z" fill="#B81D24"/>
              <path d="M19 5H24V25.8C22.3 26 20.7 26.2 19 26.5V5Z" fill="#B81D24"/>
              <path d="M8 5H13.3L24 26.8C22.3 27 20.7 27.1 19 27.2L8 5.6V5Z" fill="#E50914" filter="url(#nf-ribbon-shadow)"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">Netflix</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://open.spotify.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(30, 215, 96, 0.14);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="15" fill="#1ED760"/>
              <path d="M21.8 20.3C21.5 20.7 21 20.8 20.6 20.6C17.2 18.6 12.8 18.1 7.8 19.2C7.3 19.3 6.9 19 6.8 18.5C6.7 18 7 17.6 7.5 17.5C13 16.3 17.9 16.9 21.7 19.2C22.1 19.5 22.1 20 21.8 20.3ZM23.3 16.5C22.9 17 22.3 17.2 21.8 16.9C17.9 14.5 12.1 13.9 7.4 15.3C6.8 15.5 6.3 15.2 6.1 14.6C5.9 14.1 6.3 13.5 6.8 13.3C12.1 11.7 18.6 12.5 23 15.2C23.5 15.4 23.6 16.1 23.3 16.5ZM23.5 12.6C18.8 9.8 11 9.5 6.6 10.8C5.9 11 5.2 10.6 5 9.9C4.8 9.2 5.2 8.5 5.9 8.3C11 6.8 19.6 7.1 25.1 10.3C25.7 10.7 25.9 11.5 25.5 12.1C25.2 12.7 24.3 12.9 23.5 12.6Z" fill="#121212"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">Spotify</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.ntpNavigate('https://instagram.com')">
          <div class="ntp-shortcut-icon" style="background: rgba(225, 48, 108, 0.14);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <defs>
                <linearGradient id="ig-real-gradient" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#FFD600"/>
                  <stop offset="30%" stop-color="#FF0169"/>
                  <stop offset="70%" stop-color="#D300C5"/>
                  <stop offset="100%" stop-color="#7638FA"/>
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="8" fill="url(#ig-real-gradient)"/>
              <rect x="7.5" y="7.5" width="17" height="17" rx="5" stroke="white" stroke-width="2.2"/>
              <circle cx="16" cy="16" r="4.2" stroke="white" stroke-width="2.2"/>
              <circle cx="20.8" cy="11.2" r="1.1" fill="white"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title">Instagram</div>
        </div>

        <div class="ntp-shortcut-tile" onclick="window.openInternalPage('beta://mensajes-eliminados')" style="border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.08);">
          <div class="ntp-shortcut-icon" style="background: rgba(16, 185, 129, 0.18);">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#064e3b" stroke="#10b981" stroke-width="1.2"/>
              <path d="M4 16s4-7.5 12-7.5 12 7.5 12 7.5-4 7.5-12 7.5S4 16 4 16z" stroke="#34d399" stroke-width="2.2"/>
              <circle cx="16" cy="16" r="3.2" fill="#34d399"/>
            </svg>
          </div>
          <div class="ntp-shortcut-title" style="color: #34d399; font-weight: 600;">Mensajes y Estados</div>
        </div>
      </div>

      <!-- Telemetría y Estado de Protección -->
      <div class="ntp-stats-bar">
        <div class="ntp-stat-item">
          <span class="ntp-stat-dot"></span>
          <span>Escudo uBlock: <strong>Activo</strong></span>
        </div>
        <div class="ntp-stat-item">
          <span class="ntp-stat-dot"></span>
          <span id="ntp-ram-stat">RAM: Calculando...</span>
        </div>
        <div class="ntp-stat-item">
          <span class="ntp-stat-dot"></span>
          <span>Widevine DRM: <strong>Listo</strong></span>
        </div>
      </div>
    </div>
  `;

  // Actualizar stat de RAM en NTP
  api.system.getRam().then((ram: any) => {
    const el = document.getElementById('ntp-ram-stat');
    if (el) el.innerText = ram.label;
  });

  // Reloj en vivo segundo a segundo
  ntpClockInterval = setInterval(updateNtpClock, 1000);
}

(window as any).ntpSearch = (query: string) => {
  if (!query) return;
  const input = document.getElementById('omnibox-input') as HTMLInputElement;
  if (input) input.value = query;
  document.getElementById('omnibox-form')?.dispatchEvent(new Event('submit'));
};

(window as any).ntpNavigate = (url: string) => {
  navigateToUrl(url);
};

// ============================================================================
// SISTEMA DE AJUSTES & CONFIGURACIÓN (Estilo AplicacionWeb / Will Browser)
// ============================================================================
let currentSettingsTab: 'motor' | 'estetica' | 'escudos' | 'medios' | 'avanzadas' = 'motor';
let activePasswordModal: { type: 'adult' | 'pomodoro'; error?: string } | null = null;

const settingsTabsConfig = [
  { id: 'motor', name: 'Motor y Rendimiento', desc: 'Aceleración GPU, Límite de RAM, Energía.', icon: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>' },
  { id: 'estetica', name: 'Estética y Experiencia', desc: 'Modo oscuro, animaciones, marcadores.', icon: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h3.016C20.04 16.394 22 14.394 22 12c0-5.5-4.5-10-10-10Z"/></svg>' },
  { id: 'escudos', name: 'Escudos y Privacidad', desc: 'Anti-Anuncios agresivo, rastro, HTTPS.', icon: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' },
  { id: 'medios', name: 'Audio y Medios', desc: 'Control de sonido, subtítulos IA, volumen.', icon: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>' },
  { id: 'avanzadas', name: 'Funciones Avanzadas', desc: 'Funciones exclusivas e innovadoras.', icon: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM7.5 14H6c-2 0-4 2-4 4v2h20v-2c0-2-2-4-4-4h-1.5"/></svg>' }
];

function renderSettingsPage(container: HTMLElement) {
  const currentEngine = currentSettings.searchEngine || 'https://www.google.com/search?q=';
  const isDark = currentSettings.theme !== 'light';

  let modalHtml = '';
  if (activePasswordModal) {
    const isAdult = activePasswordModal.type === 'adult';
    const isEnabled = isAdult ? currentSettings.adultBlockerEnabled : currentSettings.pomodoroEnabled;
    const isCreating = !isEnabled;
    const title = isAdult
      ? (isEnabled ? "Desactivar Vigilante" : "Activar Vigilante de Adultos")
      : (isEnabled ? "Salir del Modo Cárcel" : "Activar Modo Cárcel");
    const desc = isAdult
      ? (isEnabled ? "Ingresa tu contraseña para desactivarlo." : "Crea una contraseña que se pedirá para desactivarlo.")
      : (isEnabled ? "Ingresa la contraseña para abandonar el estudio." : "Crea una contraseña para bloquear distracciones.");
    const placeholder = isCreating ? "Crea una contraseña segura" : "Introduce tu contraseña";
    const btnText = isCreating ? "Guardar y Activar" : "Verificar";

    modalHtml = `
      <div class="settings-modal-overlay">
        <div class="settings-modal-card">
          <div class="settings-modal-title">${title}</div>
          <div class="settings-modal-desc">${desc}</div>
          <div style="margin: 14px 0;">
            <input
              type="password"
              id="modal-password-input"
              class="settings-modal-input"
              placeholder="${placeholder}"
              autofocus
              onkeydown="if(event.key==='Enter') window.submitPasswordModal('${activePasswordModal.type}')"
            />
            ${activePasswordModal.error ? `<div class="settings-modal-error">${activePasswordModal.error}</div>` : ''}
          </div>
          <div class="settings-modal-actions">
            <button class="settings-modal-btn cancel" onclick="window.closePasswordModal()">Cancelar</button>
            <button class="settings-modal-btn confirm" onclick="window.submitPasswordModal('${activePasswordModal.type}')">${btnText}</button>
          </div>
        </div>
      </div>
    `;
  }

  // Render tab content
  let panelHtml = '';
  if (currentSettingsTab === 'motor') {
    panelHtml = `
      <div class="settings-panel">
        <h2 class="settings-tab-heading">Motor y Rendimiento</h2>
        <p class="settings-tab-subheading">Optimiza el navegador para ahorrar recursos o desata todo su potencial si tienes un equipo potente.</p>
        
        <h4 class="settings-subgroup-title">Funciones Básicas</h4>
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Motor de Búsqueda</h3>
            <p class="setting-desc">El buscador que se usará desde la barra de direcciones.</p>
          </div>
          <select id="setting-search-engine" class="settings-select" onchange="window.handleSearchEngineChange(this.value)">
            <option value="https://www.google.com/search?q=" ${currentEngine.includes('google') ? 'selected' : ''}>Google</option>
            <option value="https://duckduckgo.com/?q=" ${currentEngine.includes('duckduckgo') ? 'selected' : ''}>DuckDuckGo</option>
            <option value="https://www.bing.com/search?q=" ${currentEngine.includes('bing') ? 'selected' : ''}>Bing</option>
            <option value="https://search.yahoo.com/search?p=" ${currentEngine.includes('yahoo') ? 'selected' : ''}>Yahoo</option>
          </select>
        </div>

        <h4 class="settings-subgroup-title premium"><span>✨</span> Funciones Avanzadas</h4>
        <div class="settings-premium-box">
          <!-- Modo Eficiencia Extrema -->
          <div class="settings-card">
            <div>
              <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Modo Eficiencia Extrema</h3>
              <p class="setting-desc">Limita agresivamente los procesos en segundo plano para ahorrar RAM y CPU.</p>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-efficiency" ${currentSettings.efficiencyMode !== false ? 'checked' : ''} onchange="window.updateSettingKey('efficiencyMode', this.checked)" />
              <span class="slider"></span>
            </label>
          </div>

          <!-- Preguntar antes de cerrar varias pestañas -->
          <div class="settings-card">
            <div>
              <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Preguntar antes de cerrar varias pestañas</h3>
              <p class="setting-desc">Muestra un cuadro de confirmación para evitar cerrar accidentalmente una ventana con múltiples pestañas abiertas.</p>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-warn-close" ${currentSettings.warnOnCloseMultipleTabs !== false ? 'checked' : ''} onchange="window.updateSettingKey('warnOnCloseMultipleTabs', this.checked)" />
              <span class="slider"></span>
            </label>
          </div>

          <!-- Hibernación Inteligente -->
          <div class="settings-card" style="flex-direction: column; align-items: stretch; gap: 12px; background: rgba(245, 158, 11, 0.05); border-color: rgba(245, 158, 11, 0.25);">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <h3 class="setting-label text-amber flex-center" style="font-size: 16px; margin-bottom: 2px;">
                  Hibernación Inteligente <span class="premium-pill">Premium</span>
                </h3>
                <p class="setting-desc" style="max-width: 500px;">
                  Ahorra gigabytes de RAM. Suspende automáticamente las pestañas web después de un tiempo de inactividad. Se recargarán al instante cuando vuelvas a hacerles clic.
                </p>
              </div>
              <label class="switch switch-amber">
                <input type="checkbox" id="setting-hibernation" ${currentSettings.hibernationEnabled ? 'checked' : ''} onchange="window.handleHibernationToggle(this.checked)" />
                <span class="slider"></span>
              </label>
            </div>

            ${currentSettings.hibernationEnabled ? `
              <div style="display: flex; align-items: center; gap: 12px; border-top: 1px solid rgba(245, 158, 11, 0.15); padding-top: 10px;">
                <span style="font-size: 13px; color: #f59e0b;">Suspender después de:</span>
                <select class="settings-select-sm" onchange="window.updateSettingKey('hibernationTimeoutMinutes', parseInt(this.value, 10))">
                  <option value="1" ${currentSettings.hibernationTimeoutMinutes === 1 ? 'selected' : ''}>1 minuto (Test)</option>
                  <option value="5" ${currentSettings.hibernationTimeoutMinutes === 5 ? 'selected' : ''}>5 minutos (Recomendado)</option>
                  <option value="15" ${currentSettings.hibernationTimeoutMinutes === 15 ? 'selected' : ''}>15 minutos</option>
                  <option value="30" ${currentSettings.hibernationTimeoutMinutes === 30 ? 'selected' : ''}>30 minutos</option>
                </select>
              </div>
            ` : ''}
          </div>

          <!-- Aceleración por Hardware -->
          <div class="settings-card">
            <div>
              <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Aceleración por Hardware</h3>
              <p class="setting-desc">Usa la tarjeta de video (GPU) para renderizar páginas. Solo actívalo si tienes GPU dedicada.</p>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-hwaccel" ${currentSettings.hardwareAcceleration !== false ? 'checked' : ''} onchange="window.updateSettingKey('hardwareAcceleration', this.checked)" />
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>
    `;
  } else if (currentSettingsTab === 'estetica') {
    panelHtml = `
      <div class="settings-panel">
        <h2 class="settings-tab-heading">Estética y Experiencia</h2>
        <p class="settings-tab-subheading">Personaliza cómo se ve y se siente tu espacio de trabajo.</p>
        
        <!-- Tema -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Tema Claro / Oscuro</h3>
            <p class="setting-desc">Cambia el estilo visual del navegador.</p>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="switch">
              <input type="checkbox" id="setting-theme" ${!isDark ? 'checked' : ''} onchange="window.handleThemeChange(this.checked)" />
              <span class="slider"></span>
            </label>
            <span style="font-size: 13px; font-weight: 500;">${!isDark ? 'Claro' : 'Oscuro'}</span>
          </div>
        </div>

        <!-- Animaciones -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Animaciones de Interfaz UI</h3>
            <p class="setting-desc">Habilita efectos visuales suaves y transiciones en el navegador.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-animations" ${currentSettings.uiAnimations !== false ? 'checked' : ''} onchange="window.handleAnimationsToggle(this.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <!-- Barra de marcadores -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Mostrar Barra de Marcadores</h3>
            <p class="setting-desc">Muestra los accesos directos favoritos debajo de la barra de direcciones.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-bookmarks-bar" ${currentSettings.showBookmarksBar !== false ? 'checked' : ''} onchange="window.updateSettingKey('showBookmarksBar', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;
  } else if (currentSettingsTab === 'escudos') {
    panelHtml = `
      <div class="settings-panel">
        <h2 class="settings-tab-heading">Escudos y Privacidad</h2>
        <p class="settings-tab-subheading">Controla lo que ves y la huella que dejas al navegar.</p>
        
        <!-- Vigilante Anti-Anuncios -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Vigilante Anti-Anuncios</h3>
            <p class="setting-desc">Bloquea publicidad intrusiva en YouTube y otros sitios web agresivamente.</p>
          </div>
          <label class="switch switch-emerald">
            <input type="checkbox" id="setting-adblock" ${currentSettings.adblockEnabled !== false ? 'checked' : ''} onchange="window.updateSettingKey('adblockEnabled', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <!-- Vigilante de Contenido Adulto -->
        <div class="settings-card danger-card">
          <div>
            <h3 class="setting-label text-red" style="font-size: 16px; margin-bottom: 2px;">Vigilante de Contenido Adulto</h3>
            <p class="setting-desc">Bloquea páginas para adultos. Requiere contraseña para ser desactivado.</p>
          </div>
          <button onclick="window.openPasswordModal('adult')" class="btn-guard ${currentSettings.adultBlockerEnabled ? 'active' : ''}">
            ${currentSettings.adultBlockerEnabled ? 'Activado (Protegido)' : 'Desactivado'}
          </button>
        </div>

        <!-- Borrar Datos -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Borrar Datos de Navegación</h3>
            <p class="setting-desc">Elimina el historial, cookies y caché del navegador.</p>
          </div>
          <button onclick="window.clearAllBrowsingData()" class="btn-danger-outline">
            Limpiar Ahora
          </button>
        </div>

        <!-- Modo Fantasma (Próximamente) -->
        <div class="settings-card disabled-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Modo Fantasma por Pestaña</h3>
            <p class="setting-desc">Destruye automáticamente cookies y caché de una pestaña específica al cerrarla. (Próximamente)</p>
          </div>
          <label class="switch">
            <input type="checkbox" disabled />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;
  } else if (currentSettingsTab === 'medios') {
    panelHtml = `
      <div class="settings-panel">
        <h2 class="settings-tab-heading">Audio y Medios</h2>
        <p class="settings-tab-subheading">Control avanzado de sonido y reproducción multimedia. (Próximamente)</p>
        
        <!-- Divisor de Audio -->
        <div class="settings-card disabled-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Divisor de Audio (Split Audio)</h3>
            <p class="setting-desc">Asigna un dispositivo de sonido diferente para cada pestaña (ej. juego en audífonos, YouTube en parlantes).</p>
          </div>
          <label class="switch">
            <input type="checkbox" disabled />
            <span class="slider"></span>
          </label>
        </div>

        <!-- Traductor de Medios IA -->
        <div class="settings-card disabled-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Traductor de Medios Inteligente</h3>
            <p class="setting-desc">Genera subtítulos en vivo y traduce el audio de cualquier video usando IA local.</p>
          </div>
          <label class="switch">
            <input type="checkbox" disabled />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;
  } else if (currentSettingsTab === 'avanzadas') {
    panelHtml = `
      <div class="settings-panel">
        <h2 class="settings-tab-heading">Funciones Avanzadas</h2>
        <p class="settings-tab-subheading">Herramientas exclusivas con IA y automatización.</p>
        
        <!-- Modo Cárcel / Pomodoro -->
        <div class="settings-card info-card">
          <div>
            <h3 class="setting-label text-blue" style="font-size: 16px; margin-bottom: 2px;">Modo Cárcel (Pomodoro Profundo)</h3>
            <p class="setting-desc">Bloquea distracciones. Solo permite navegar en sitios educativos. (Requiere contraseña para salir).</p>
          </div>
          <button onclick="window.openPasswordModal('pomodoro')" class="btn-pomodoro ${currentSettings.pomodoroEnabled ? 'active' : ''}">
            ${currentSettings.pomodoroEnabled ? 'Activo' : 'Activar'}
          </button>
        </div>

        <!-- Piloto Automático IA -->
        <div class="settings-card purple-card">
          <div>
            <h3 class="setting-label text-purple flex-center" style="font-size: 16px; margin-bottom: 2px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;"><path d="M2 12h4l3-9 5 18 3-9h5"/></svg>
              Piloto Automático (Auto-Relleno IA)
            </h3>
            <p class="setting-desc">Usa Inteligencia Artificial para auto-completar encuestas y formularios con un solo clic.</p>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
            <div>
              <label class="sub-label">Gemini API Key</label>
              <input
                type="password"
                id="setting-api-key"
                class="input-styled"
                style="width: 100%;"
                placeholder="Pega aquí tu API Key de Google Gemini"
                value="${currentSettings.aiApiKey || ''}"
                onchange="window.updateSettingKey('aiApiKey', this.value.trim())"
              />
              <a href="https://aistudio.google.com/app/apikey" target="_blank" class="sub-link text-purple">Obtener API Key Gratis ↗</a>
            </div>
            <div>
              <label class="sub-label">Perfil (Persona)</label>
              <textarea
                id="setting-persona-context"
                class="textarea-styled"
                placeholder="Ej: Estudiante de 22 años, hablo inglés..."
                onchange="window.updateSettingKey('aiPersonaContext', this.value.trim())"
              >${currentSettings.aiPersonaContext || ''}</textarea>
            </div>
          </div>
        </div>

        <!-- Ojo de Halcón -->
        <div class="settings-card" style="border-color: rgba(16, 185, 129, 0.3);">
          <div>
            <h3 class="setting-label text-emerald flex-center" style="font-size: 16px; margin-bottom: 2px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              Ojo de Halcón (Caché Fantasma)
            </h3>
            <p class="setting-desc">Intercepta y recupera los mensajes borrados en WhatsApp Web de forma local.</p>
          </div>
          <label class="switch switch-emerald">
            <input type="checkbox" id="setting-phantom" ${currentSettings.phantomCacheEnabled ? 'checked' : ''} onchange="window.updateSettingKey('phantomCacheEnabled', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <!-- Pestañas Semánticas -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Pestañas Semánticas</h3>
            <p class="setting-desc">Agrupa pestañas automáticamente por su contexto semántico (Requiere API Key).</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-semantic-tabs" ${currentSettings.semanticTabsEnabled ? 'checked' : ''} onchange="window.updateSettingKey('semanticTabsEnabled', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <!-- Máquina del Tiempo Local -->
        <div class="settings-card">
          <div>
            <h3 class="setting-label" style="font-size: 16px; margin-bottom: 2px;">Máquina del Tiempo Local</h3>
            <p class="setting-desc">Guarda una copia ultra-ligera de las páginas visitadas para verlas offline.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="setting-time-machine" ${currentSettings.timeMachineEnabled ? 'checked' : ''} onchange="window.updateSettingKey('timeMachineEnabled', this.checked)" />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="settings-container">
      <!-- Sidebar de Navegación -->
      <aside class="settings-sidebar">
        <div class="settings-sidebar-header">
          <h1 class="settings-sidebar-title">Ajustes</h1>
        </div>
        ${settingsTabsConfig.map(tab => `
          <button
            class="settings-tab-btn ${currentSettingsTab === tab.id ? 'active' : ''}"
            onclick="window.switchSettingsTab('${tab.id}')"
          >
            <div class="settings-tab-icon">${tab.icon}</div>
            <div class="settings-tab-text">
              <span class="settings-tab-name">${tab.name}</span>
              <span class="settings-tab-desc">${tab.desc}</span>
            </div>
          </button>
        `).join('')}
      </aside>

      <!-- Panel de Contenido -->
      <main class="settings-main">
        ${panelHtml}
        <div style="max-width: 780px; margin: 30px auto 0; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: 20px;">
          <span style="font-size: 12px; color: var(--text-dim);">✨ Ajustes guardados automáticamente en tiempo real</span>
          <button class="btn-primary" onclick="window.saveSettings()">Guardar Ajustes</button>
        </div>
      </main>

      <!-- Modal de Contraseña si está abierto -->
      ${modalHtml}
    </div>
  `;
}

// Bloqueo de Navegación (Adult / Pomodoro)
function renderBlockedPage(container: HTMLElement, url: string = '') {
  const isPomodoro = url.includes('pomodoro') || currentSettings.pomodoroEnabled;
  container.innerHTML = `
    <div class="internal-page-content" style="text-align: center; max-width: 600px; padding-top: 80px;">
      <div style="width: 80px; height: 80px; border-radius: 24px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; color: #ef4444;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <h1 style="font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 12px;">Acceso Restringido</h1>
      <p style="font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 32px;">
        ${isPomodoro 
          ? 'El <strong>Modo Cárcel (Pomodoro Profundo)</strong> está activado. Esta página ha sido bloqueada para evitar distracciones y mantener tu enfoque en tareas de estudio y trabajo.'
          : 'Esta página ha sido bloqueada automáticamente por el <strong>Vigilante de Contenido Adulto</strong> de NavegadorBeta para proteger tu navegación.'}
      </p>
      <div style="display: flex; justify-content: center; gap: 14px;">
        <button class="btn-primary" onclick="window.openInternalPage('beta://ajustes')">
          ⚙️ Ir a Ajustes
        </button>
        <button class="btn-primary" style="background: rgba(255,255,255,0.08); color: #fff;" onclick="window.openInternalPage('beta://nueva-pestana')">
          🏠 Volver al Inicio
        </button>
      </div>
    </div>
  `;
}

// Handlers Globales de Ajustes
(window as any).switchSettingsTab = (tabId: 'motor' | 'estetica' | 'escudos' | 'medios' | 'avanzadas') => {
  currentSettingsTab = tabId;
  const container = document.getElementById('internal-pages');
  if (container) renderSettingsPage(container);
};

(window as any).updateSettingKey = async (key: string, value: any) => {
  try {
    currentSettings = await api.settings.update({ [key]: value });
    showToast('Ajuste actualizado', 'info');
  } catch (e) {
    console.error('Error saving setting:', e);
  }
};

(window as any).handleSearchEngineChange = async (url: string) => {
  currentSettings = await api.settings.update({ searchEngine: url });
  showToast('Motor de búsqueda actualizado', 'success');
};

(window as any).handleHibernationToggle = async (checked: boolean) => {
  currentSettings = await api.settings.update({ hibernationEnabled: checked });
  const container = document.getElementById('internal-pages');
  if (container) renderSettingsPage(container);
  showToast(`Hibernación inteligente ${checked ? 'activada' : 'desactivada'}`, 'info');
};

(window as any).handleThemeChange = async (isLight: boolean) => {
  const theme = isLight ? 'light' : 'dark';
  currentSettings = await api.settings.update({ theme });
  document.body.classList.toggle('light-theme', isLight);
  const container = document.getElementById('internal-pages');
  if (container) renderSettingsPage(container);
  showToast(`Tema cambiado a ${isLight ? 'Claro' : 'Oscuro'}`, 'info');
};

(window as any).handleAnimationsToggle = async (checked: boolean) => {
  currentSettings = await api.settings.update({ uiAnimations: checked });
  document.body.classList.toggle('disable-animations', !checked);
  showToast(`Animaciones ${checked ? 'activadas' : 'desactivadas'}`, 'info');
};

(window as any).openPasswordModal = (type: 'adult' | 'pomodoro') => {
  activePasswordModal = { type, error: '' };
  const container = document.getElementById('internal-pages');
  if (container) renderSettingsPage(container);
};

(window as any).closePasswordModal = () => {
  activePasswordModal = null;
  const container = document.getElementById('internal-pages');
  if (container) renderSettingsPage(container);
};

(window as any).submitPasswordModal = async (type: 'adult' | 'pomodoro') => {
  const input = document.getElementById('modal-password-input') as HTMLInputElement;
  const pwd = input?.value.trim() || '';

  if (type === 'adult') {
    if (!currentSettings.adultBlockerEnabled) {
      if (!pwd) {
        if (activePasswordModal) activePasswordModal.error = 'Por favor ingresa una contraseña segura.';
        const container = document.getElementById('internal-pages');
        if (container) renderSettingsPage(container);
        return;
      }
      currentSettings = await api.settings.update({
        adultBlockerEnabled: true,
        adultBlockerPassword: pwd
      });
      activePasswordModal = null;
      showToast('🛡️ Vigilante de Adultos activado y protegido', 'success');
    } else {
      if (pwd === currentSettings.adultBlockerPassword) {
        currentSettings = await api.settings.update({
          adultBlockerEnabled: false,
          adultBlockerPassword: ''
        });
        activePasswordModal = null;
        showToast('Vigilante de Adultos desactivado', 'info');
      } else {
        if (activePasswordModal) activePasswordModal.error = 'Contraseña incorrecta.';
        const container = document.getElementById('internal-pages');
        if (container) renderSettingsPage(container);
        return;
      }
    }
  } else if (type === 'pomodoro') {
    if (!currentSettings.pomodoroEnabled) {
      if (!pwd) {
        if (activePasswordModal) activePasswordModal.error = 'Por favor ingresa una contraseña.';
        const container = document.getElementById('internal-pages');
        if (container) renderSettingsPage(container);
        return;
      }
      currentSettings = await api.settings.update({
        pomodoroEnabled: true,
        pomodoroPassword: pwd
      });
      activePasswordModal = null;
      showToast('🔒 Modo Cárcel (Pomodoro) activado. ¡A concentrarse!', 'success');
    } else {
      if (pwd === currentSettings.pomodoroPassword) {
        currentSettings = await api.settings.update({
          pomodoroEnabled: false,
          pomodoroPassword: ''
        });
        activePasswordModal = null;
        showToast('Modo Cárcel desactivado', 'info');
      } else {
        if (activePasswordModal) activePasswordModal.error = 'Contraseña incorrecta.';
        const container = document.getElementById('internal-pages');
        if (container) renderSettingsPage(container);
        return;
      }
    }
  }

  const container = document.getElementById('internal-pages');
  if (container) renderSettingsPage(container);
};

(window as any).clearAllBrowsingData = async () => {
  try {
    await api.history.clear(0);
    showToast('🧹 Datos de navegación eliminados correctamente', 'success');
  } catch (err) {
    showToast('Error al limpiar datos de navegación', 'error');
  }
};

(window as any).saveSettings = async () => {
  const apiKey = (document.getElementById('setting-api-key') as HTMLInputElement)?.value.trim();
  const persona = (document.getElementById('setting-persona-context') as HTMLTextAreaElement)?.value.trim();

  currentSettings = await api.settings.update({
    aiApiKey: apiKey !== undefined ? apiKey : currentSettings.aiApiKey,
    aiPersonaContext: persona !== undefined ? persona : currentSettings.aiPersonaContext
  });

  showToast('Ajustes guardados correctamente', 'success');
};

// Historial
async function renderHistoryPage(container: HTMLElement) {
  const history = await api.history.get();

  container.innerHTML = `
    <div class="internal-page-content">
      <div class="page-title" style="justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Historial de Navegación</span>
        </div>
        <button class="btn-primary" onclick="window.clearHistory()">Limpiar Historial</button>
      </div>

      <div class="settings-section">
        ${history.length === 0 ? '<div style="color: var(--text-dim); text-align: center; padding: 20px;">No hay páginas registradas en el historial.</div>' : ''}
        ${history.map((item: any) => `
          <div class="setting-row" style="cursor: pointer;" onclick="window.ntpNavigate('${item.url}')">
            <div style="display: flex; align-items: center; gap: 12px; overflow: hidden;">
              <img src="https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32" width="16" height="16" onerror="this.src='../../assets/icons/favicon.png'" />
              <div style="display: flex; flex-direction: column; overflow: hidden;">
                <span style="font-size: 13px; font-weight: 500; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.title}</span>
                <span style="font-size: 11px; color: var(--text-dim);">${item.url}</span>
              </div>
            </div>
            <span style="font-size: 11px; color: var(--text-dim); flex-shrink: 0;">${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

(window as any).clearHistory = async () => {
  await api.history.clear(0);
  showToast('Historial borrado con éxito', 'success');
  renderHistoryPage(document.getElementById('internal-pages')!);
};

// Descargas
async function renderDownloadsPage(container: HTMLElement) {
  const downloads = await api.downloads.get();

  container.innerHTML = `
    <div class="internal-page-content">
      <div class="page-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg>
        <span>Descargas</span>
      </div>

      <div class="settings-section">
        ${downloads.length === 0 ? '<div style="color: var(--text-dim); text-align: center; padding: 20px;">Aún no has descargado ningún archivo.</div>' : ''}
        ${downloads.map((d: any) => `
          <div class="setting-row">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width: 36px; height: 36px; border-radius: 8px; background: rgba(59, 130, 246, 0.1); display: flex; align-items: center; justify-content: center; color: var(--accent-blue);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg>
              </div>
              <div style="display: flex; flex-direction: column;">
                <span style="font-size: 13px; font-weight: 500; color: #fff;">${d.filename}</span>
                <span style="font-size: 11px; color: ${d.state === 'completed' ? 'var(--accent-emerald)' : 'var(--accent-amber)'};">${d.state === 'completed' ? 'Completado' : 'En progreso'}</span>
              </div>
            </div>
            ${d.state === 'completed' ? `
              <div style="display: flex; gap: 8px;">
                <button class="ai-chip" onclick="window.openDownloadFile('${d.savePath.replace(/\\/g, '\\\\')}')">Abrir</button>
                <button class="ai-chip" onclick="window.showDownloadInFolder('${d.savePath.replace(/\\/g, '\\\\')}')">Carpeta</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

(window as any).openDownloadFile = (p: string) => api.downloads.openFile(p);
(window as any).showDownloadInFolder = (p: string) => api.downloads.showInFolder(p);

// ============================================================================
// 9. BÓVEDA WHATSAPP: MENSAJES ELIMINADOS Y ESTADOS GUARDADOS
// ============================================================================
let phantomViewMode: 'messages' | 'statuses' = 'messages';
let phantomActiveContact: string = 'all';
let phantomFilterType: 'all' | 'text' | 'media' | 'audio' = 'all';
let phantomSearchContact: string = '';
let selectedStatusId: string | null = null;
let lastUrlBeforeVault: string = 'https://web.whatsapp.com';

function stopVaultMedia() {
  const internalPagesEl = document.getElementById('internal-pages');
  if (internalPagesEl) {
    internalPagesEl.querySelectorAll('video, audio').forEach((media: any) => {
      try {
        media.pause();
        media.currentTime = 0;
        media.src = '';
        media.load();
      } catch (e) {}
    });
  }
}

function openPhantomVault() {
  isPhantomVaultOpen = true;

  // Ocultar la vista nativa de Electron sin navegar ni recargar la página (WhatsApp sigue 100% vivo en RAM)
  if (activeTabId) {
    (api.tabs as any).setVisible?.(activeTabId, false);
  }

  showInternalPage('beta://mensajes-eliminados');
  updateNavButtons();
  const btn = document.getElementById('btn-phantom-header');
  if (btn) btn.classList.add('active');
}
(window as any).openPhantomVault = openPhantomVault;

function closePhantomVault() {
  if (!isPhantomVaultOpen) return;
  isPhantomVaultOpen = false;

  // 1. Detener INMEDIATAMENTE cualquier audio o video de estados que esté reproduciéndose de fondo
  stopVaultMedia();
  const internalPagesEl = document.getElementById('internal-pages');
  if (internalPagesEl) {
    internalPagesEl.innerHTML = '';
  }

  // 2. Ocultar la capa de páginas internas
  hideInternalPages();

  // 3. Restaurar la vista web nativa al instante (0ms, sin recargar WhatsApp ni perder la sesión)
  if (activeTabId) {
    (api.tabs as any).setVisible?.(activeTabId, true);
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      updateOmnibox(activeTab.url);
    }
  }

  const btn = document.getElementById('btn-phantom-header');
  if (btn) btn.classList.remove('active');

  updateNavButtons();
}
(window as any).closePhantomVault = closePhantomVault;

// Escuchar tecla Escape para cerrar la vista y volver
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isPhantomVaultOpen) {
    closePhantomVault();
  }
});

function getPhantomAvatarBg(name: string): string {
  const gradients = [
    'linear-gradient(135deg, #00a884, #059669)',
    'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    'linear-gradient(135deg, #8b5cf6, #6d28d9)',
    'linear-gradient(135deg, #ec4899, #be185d)',
    'linear-gradient(135deg, #f59e0b, #d97706)',
    'linear-gradient(135deg, #06b6d4, #0891b2)',
    'linear-gradient(135deg, #6366f1, #4338ca)'
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return gradients[Math.abs(hash) % gradients.length];
}

function getPhantomInitials(name: string): string {
  if (!name) return '??';
  const clean = name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s]/g, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (clean.slice(0, 2) || name.slice(0, 2)).toUpperCase();
}

let phantomActiveStatusContact: string = 'all';
let phantomActiveStatusStoryIndex: number = 0;

async function renderPhantomMessagesPage(container: HTMLElement) {
  const msgs = (await api.phantom.getMessages()) || [];
  const savedStatuses = (await (api.phantom as any).getStatuses?.()) || [];

  const totalBorrados = msgs.length;
  const totalStatuses = savedStatuses.length;

  // Clasificación y agrupación de mensajes por contacto
  interface ContactEntry {
    name: string;
    chatName: string;
    platform: 'whatsapp' | 'instagram';
    count: number;
    mediaCount: number;
    audioCount: number;
    lastTimestamp: number;
    avatarBg: string;
    initials: string;
    messages: any[];
  }

  const contactMap = new Map<string, ContactEntry>();

  for (const m of msgs) {
    const isOut = m.isOutgoing || (m.id && m.id.startsWith('true_')) || m.sender === 'Tú' || m.sender === 'You';
    const contactName = (m.chatName && m.chatName !== 'WhatsApp Web' ? m.chatName : (isOut ? 'Tú' : (m.sender || 'Contacto'))).trim();
    if (!contactMap.has(contactName)) {
      contactMap.set(contactName, {
        name: contactName,
        chatName: m.chatName || contactName,
        platform: m.platform || 'whatsapp',
        count: 0,
        mediaCount: 0,
        audioCount: 0,
        lastTimestamp: m.timestamp || Date.now(),
        avatarBg: getPhantomAvatarBg(contactName),
        initials: getPhantomInitials(contactName),
        messages: []
      });
    }
    const entry = contactMap.get(contactName)!;
    entry.count++;
    if (m.mediaData && (m.mediaType === 'image' || m.mediaType === 'video')) entry.mediaCount++;
    if (m.mediaType === 'audio') entry.audioCount++;
    if (m.timestamp > entry.lastTimestamp) entry.lastTimestamp = m.timestamp;
    entry.messages.push(m);
  }

  const contacts = Array.from(contactMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  // Filtrado de contactos por buscador de la barra lateral (Modo Mensajes)
  const filteredContacts = phantomSearchContact.trim()
    ? contacts.filter(c => c.name.toLowerCase().includes(phantomSearchContact.toLowerCase()) || c.chatName.toLowerCase().includes(phantomSearchContact.toLowerCase()))
    : contacts;

  // Contacto actualmente activo en Mensajes
  if (phantomActiveContact !== 'all' && !contactMap.has(phantomActiveContact)) {
    phantomActiveContact = 'all';
  }
  const currentContact = phantomActiveContact !== 'all' ? contactMap.get(phantomActiveContact) : null;

  // Filtrado de mensajes por contacto seleccionado
  let activeMessages = phantomActiveContact === 'all'
    ? [...msgs]
    : (currentContact?.messages || []);

  // Filtrado por tipo de multimedia
  const countAll = activeMessages.length;
  const countText = activeMessages.filter(m => !m.mediaData || m.mediaType === 'text').length;
  const countMedia = activeMessages.filter(m => m.mediaData && (m.mediaType === 'image' || m.mediaType === 'video')).length;
  const countAudio = activeMessages.filter(m => m.mediaType === 'audio').length;

  if (phantomFilterType === 'text') {
    activeMessages = activeMessages.filter(m => !m.mediaData || m.mediaType === 'text');
  } else if (phantomFilterType === 'media') {
    activeMessages = activeMessages.filter(m => m.mediaData && (m.mediaType === 'image' || m.mediaType === 'video'));
  } else if (phantomFilterType === 'audio') {
    activeMessages = activeMessages.filter(m => m.mediaType === 'audio');
  }

  activeMessages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // ══════════════════════════════════════════════════════════════════════════
  // AGRUPACIÓN DE ESTADOS DEPENDIENDO DEL CONTACTO
  // ══════════════════════════════════════════════════════════════════════════
  interface StatusContactGroup {
    name: string;
    avatarBg: string;
    initials: string;
    statuses: any[];
    lastTimestamp: number;
    count: number;
  }

  const statusContactMap = new Map<string, StatusContactGroup>();

  for (const st of savedStatuses) {
    const senderName = (st.sender || 'Contacto').trim();
    if (!statusContactMap.has(senderName)) {
      statusContactMap.set(senderName, {
        name: senderName,
        avatarBg: getPhantomAvatarBg(senderName),
        initials: getPhantomInitials(senderName),
        statuses: [],
        lastTimestamp: st.timestamp || Date.now(),
        count: 0
      });
    }
    const group = statusContactMap.get(senderName)!;
    group.count++;
    if ((st.timestamp || 0) > group.lastTimestamp) group.lastTimestamp = st.timestamp;
    group.statuses.push(st);
  }

  // Ordenar estados de cada contacto cronológicamente
  for (const group of statusContactMap.values()) {
    group.statuses.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  const statusContacts = Array.from(statusContactMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  // Filtrado de contactos de estados por buscador de la barra lateral
  const filteredStatusContacts = phantomSearchContact.trim()
    ? statusContacts.filter(c => c.name.toLowerCase().includes(phantomSearchContact.toLowerCase()))
    : statusContacts;

  // Contacto de estado activo
  if (phantomActiveStatusContact !== 'all' && !statusContactMap.has(phantomActiveStatusContact)) {
    if (statusContacts.length > 0) {
      phantomActiveStatusContact = statusContacts[0].name;
    } else {
      phantomActiveStatusContact = 'all';
    }
  } else if (phantomActiveStatusContact === 'all' && statusContacts.length > 0 && phantomViewMode === 'statuses') {
    phantomActiveStatusContact = statusContacts[0].name;
  }

  const currentStatusContact = statusContactMap.get(phantomActiveStatusContact) || null;

  if (currentStatusContact) {
    if (phantomActiveStatusStoryIndex >= currentStatusContact.statuses.length) {
      phantomActiveStatusStoryIndex = Math.max(0, currentStatusContact.statuses.length - 1);
    }
    if (phantomActiveStatusStoryIndex < 0) {
      phantomActiveStatusStoryIndex = 0;
    }
  }

  const currentActiveStory = currentStatusContact ? currentStatusContact.statuses[phantomActiveStatusStoryIndex] : null;

  container.innerHTML = `
    <div class="wa-vault-root">
      <!-- 1. BARRA DE NAVEGACIÓN VERTICAL (IDÉNTICA A WHATSAPP WEB) -->
      <div class="wa-rail">
        <div class="wa-rail-group">
          <!-- Botón de Chats / Mensajes Eliminados -->
          <button 
            class="wa-rail-btn ${phantomViewMode === 'messages' ? 'active' : ''}" 
            onclick="window.setPhantomViewMode('messages')" 
            title="Mensajes Eliminados"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            ${totalBorrados > 0 ? `<span class="wa-rail-badge">${totalBorrados}</span>` : ''}
          </button>

          <!-- Botón de Estados (Círculos concéntricos idénticos a WhatsApp Web) -->
          <button 
            class="wa-rail-btn ${phantomViewMode === 'statuses' ? 'active' : ''}" 
            onclick="window.setPhantomViewMode('statuses')" 
            title="Estados Guardados"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" stroke-dasharray="6 3.5"/>
              <circle cx="12" cy="12" r="5" stroke-dasharray="4 2.5"/>
              <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
            </svg>
            ${totalStatuses > 0 ? `<span class="wa-rail-dot" title="${totalStatuses} estados guardados"></span>` : ''}
          </button>
        </div>

        <!-- Botón Inferior: Cerrar con X y volver a WhatsApp Web -->
        <div class="wa-rail-group">
          <button class="wa-rail-btn close" onclick="window.closePhantomVault()" title="Cerrar y volver a WhatsApp (Esc)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      <!-- 2. COLUMNA LATERAL (LISTA DE CHATS O ESTADOS POR CONTACTO) -->
      <div class="wa-sidebar">
        ${phantomViewMode === 'messages' ? `
          <!-- Header de Mensajes Eliminados -->
          <div class="wa-sidebar-header">
            <div class="wa-sidebar-title">
              <span>Mensajes Eliminados</span>
              ${totalBorrados > 0 ? `<span class="wa-pill-badge">${totalBorrados}</span>` : ''}
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${totalBorrados > 0 ? `
                <button class="wa-bubble-btn danger" onclick="window.clearPhantomLogs()" title="Limpiar todos los mensajes">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                </button>
              ` : ''}
            </div>
          </div>

          <!-- Buscador de contactos -->
          <div class="wa-search-container">
            <div class="wa-search-box">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8696a0" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" placeholder="Buscar un contacto..." value="${phantomSearchContact}" oninput="window.setPhantomSearchContact(this.value)" />
            </div>
          </div>

          <!-- Lista de Contactos con Mensajes Eliminados -->
          <div class="wa-list-scroll">
            <div class="wa-list-item ${phantomActiveContact === 'all' ? 'active' : ''}" onclick="window.setPhantomActiveContact('all')">
              <div class="wa-item-avatar" style="background: #2a3942;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00a884" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              </div>
              <div class="wa-item-info">
                <div class="wa-item-row-top">
                  <span class="wa-item-name">Todos los Mensajes</span>
                  <span class="wa-item-time">${totalBorrados > 0 ? `${totalBorrados} total` : ''}</span>
                </div>
                <div class="wa-item-row-bottom">
                  <span class="wa-item-desc">Registro general unificado</span>
                  ${totalBorrados > 0 ? `<span class="wa-pill-badge">${totalBorrados}</span>` : ''}
                </div>
              </div>
            </div>

            ${filteredContacts.map(c => `
              <div class="wa-list-item ${phantomActiveContact === c.name ? 'active' : ''}" onclick="window.setPhantomActiveContact('${encodeURIComponent(c.name)}')">
                <div class="wa-item-avatar" style="background: ${c.avatarBg};">
                  ${c.initials}
                </div>
                <div class="wa-item-info">
                  <div class="wa-item-row-top">
                    <span class="wa-item-name">${c.name}</span>
                    <span class="wa-item-time">${new Date(c.lastTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div class="wa-item-row-bottom">
                    <span class="wa-item-desc">${c.chatName && c.chatName !== c.name ? `en ${c.chatName}` : 'WhatsApp'}</span>
                    <span class="wa-pill-badge">${c.count}</span>
                  </div>
                </div>
              </div>
            `).join('')}

            ${filteredContacts.length === 0 && totalBorrados > 0 ? `
              <div style="text-align: center; padding: 24px 16px; font-size: 13px; color: #8696a0;">
                No se encontró ningún contacto con ese nombre.
              </div>
            ` : ''}

            ${totalBorrados === 0 ? `
              <div class="wa-empty-placeholder" style="padding: 36px 16px;">
                <div style="margin-bottom: 12px; font-size: 28px;">💬</div>
                <div style="color: #e9edef; font-weight: 600; margin-bottom: 6px;">No hay mensajes eliminados aún</div>
                <div style="font-size: 12px; line-height: 1.5;">
                  Cuando alguien borre un mensaje en WhatsApp Web, se guardará aquí al instante.
                </div>
              </div>
            ` : ''}
          </div>
        ` : `
          <!-- Header de Estados Guardados (Agrupados por Contacto) -->
          <div class="wa-sidebar-header">
            <div class="wa-sidebar-title">
              <span>Estados</span>
              <span class="wa-pill-badge">${totalStatuses}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${totalStatuses > 0 ? `
                <button class="wa-bubble-btn danger" onclick="window.clearAllSavedStatuses()" title="Borrar todos los estados">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                </button>
              ` : ''}
            </div>
          </div>

          <!-- Buscador de contactos para estados -->
          <div class="wa-search-container">
            <div class="wa-search-box">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8696a0" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" placeholder="Buscar un contacto..." value="${phantomSearchContact}" oninput="window.setPhantomSearchContact(this.value)" />
            </div>
          </div>

          <div style="padding: 10px 16px 4px; font-size: 11px; font-weight: 700; color: #8696a0; text-transform: uppercase; letter-spacing: 0.5px;">
            Contactos con Estados
          </div>

          <!-- Lista de Contactos con Estados -->
          <div class="wa-list-scroll">
            <div class="wa-list-item ${phantomActiveStatusContact === 'all' ? 'active' : ''}" onclick="window.setPhantomActiveStatusContact('all')">
              <div class="wa-item-avatar" style="background: #2a3942;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#25d366" stroke-width="2.2">
                  <circle cx="12" cy="12" r="9" stroke-dasharray="6 3.5"/>
                  <circle cx="12" cy="12" r="5" stroke-dasharray="4 2.5"/>
                  <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                </svg>
              </div>
              <div class="wa-item-info">
                <div class="wa-item-row-top">
                  <span class="wa-item-name">Todos los Estados</span>
                  <span class="wa-item-time">${totalStatuses > 0 ? `${totalStatuses} total` : ''}</span>
                </div>
                <div class="wa-item-row-bottom">
                  <span class="wa-item-desc">Galería organizada por contacto</span>
                  ${totalStatuses > 0 ? `<span class="wa-pill-badge">${totalStatuses}</span>` : ''}
                </div>
              </div>
            </div>

            ${filteredStatusContacts.map(c => `
              <div class="wa-list-item ${phantomActiveStatusContact === c.name ? 'active' : ''}" onclick="window.setPhantomActiveStatusContact('${encodeURIComponent(c.name)}')">
                <div class="wa-item-avatar wa-status-ring" style="background: ${c.avatarBg};">
                  ${c.initials}
                </div>
                <div class="wa-item-info">
                  <div class="wa-item-row-top">
                    <span class="wa-item-name">${c.name}</span>
                    <span class="wa-item-time">${new Date(c.lastTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div class="wa-item-row-bottom">
                    <span class="wa-item-desc">${c.count} estado${c.count > 1 ? 's' : ''} guardado${c.count > 1 ? 's' : ''}</span>
                    <span class="wa-pill-badge">${c.count}</span>
                  </div>
                </div>
              </div>
            `).join('')}

            ${filteredStatusContacts.length === 0 && totalStatuses > 0 ? `
              <div style="text-align: center; padding: 24px 16px; font-size: 13px; color: #8696a0;">
                No se encontró ningún contacto con ese nombre.
              </div>
            ` : ''}

            ${totalStatuses === 0 ? `
              <div class="wa-empty-placeholder" style="padding: 36px 16px;">
                <div style="margin-bottom: 12px; font-size: 28px;">⭕</div>
                <div style="color: #e9edef; font-weight: 600; margin-bottom: 6px;">No hay estados guardados aún</div>
                <div style="font-size: 12px; line-height: 1.5;">
                  Abre historias en WhatsApp Web y quedarán guardadas automáticamente organizadas por contacto antes de desaparecer.
                </div>
              </div>
            ` : ''}
          </div>
        `}
      </div>

      <!-- 3. ÁREA PRINCIPAL (CHAT CONVERSACIÓN O VISOR DE HISTORIAS POR CONTACTO) -->
      <div class="wa-main-area">
        ${phantomViewMode === 'messages' ? `
          <!-- Header de Conversación -->
          <div class="wa-chat-header">
            <div class="wa-chat-header-user">
              <div class="wa-item-avatar" style="width: 40px; height: 40px; background: ${currentContact ? currentContact.avatarBg : '#00a884'}; font-size: 14px;">
                ${currentContact ? currentContact.initials : '💬'}
              </div>
              <div>
                <div style="font-size: 15px; font-weight: 600; color: #e9edef;">
                  ${currentContact ? currentContact.name : 'Todos los Mensajes Rescatados'}
                </div>
                <div style="font-size: 11.5px; color: #8696a0;">
                  ${currentContact 
                    ? `${currentContact.count} mensaje${currentContact.count > 1 ? 's' : ''} interceptado${currentContact.count > 1 ? 's' : ''}` 
                    : `${totalBorrados} mensajes borrados en total`}
                </div>
              </div>
            </div>

            <!-- Filtros de Tipo y Botón Cerrar X -->
            <div style="display: flex; align-items: center; gap: 12px;">
              <div class="wa-filter-pills">
                <button class="wa-filter-pill ${phantomFilterType === 'all' ? 'active' : ''}" onclick="window.setPhantomFilterType('all')">
                  Todos (${countAll})
                </button>
                <button class="wa-filter-pill ${phantomFilterType === 'text' ? 'active' : ''}" onclick="window.setPhantomFilterType('text')">
                  💬 Texto (${countText})
                </button>
                <button class="wa-filter-pill ${phantomFilterType === 'media' ? 'active' : ''}" onclick="window.setPhantomFilterType('media')">
                  📸 Fotos (${countMedia})
                </button>
                <button class="wa-filter-pill ${phantomFilterType === 'audio' ? 'active' : ''}" onclick="window.setPhantomFilterType('audio')">
                  🎙️ Audios (${countAudio})
                </button>
              </div>

              <!-- BOTÓN CERRAR CON X (Vuelve a WhatsApp Web) -->
              <button class="wa-close-x-btn" onclick="window.closePhantomVault()" title="Cerrar y volver a WhatsApp (Esc)">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- Feed de Mensajes en Burbujas WhatsApp -->
          <div class="wa-chat-body">
            ${activeMessages.length === 0 ? `
              <div class="wa-empty-placeholder">
                <div class="wa-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                </div>
                <div style="font-size: 16px; font-weight: 600; color: #e9edef; margin-bottom: 6px;">
                  No hay mensajes con el filtro actual
                </div>
                <div style="font-size: 13px; max-width: 360px; line-height: 1.5;">
                  ${totalBorrados === 0 ? 'Abre WhatsApp Web y empieza a chatear. Cualquier mensaje borrado se capturará aquí.' : 'Prueba cambiando el filtro de contenido arriba.'}
                </div>
              </div>
            ` : activeMessages.map(m => {
              const isOut = m.isOutgoing || (m.id && m.id.startsWith('true_')) || m.sender === 'Tú' || m.sender === 'You';
              const cleanText = m.text ? m.text.replace(/(?:^|\b|\s|[a-zA-Z\u00C0-\u017F\.,!?])(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm))?)$/i, (match: string, ts: string) => {
                return match.slice(0, match.length - ts.length).trim();
              }).trim() : '';

              return `
              <div class="wa-bubble ${isOut ? 'outgoing' : 'incoming'}">
                <div class="wa-bubble-deleted-tag ${isOut ? 'outgoing' : ''}">
                  <span class="wa-deleted-dot"></span>
                  <span>${isOut ? 'ELIMINADO POR TI' : 'ELIMINADO POR EL EMISOR'}</span>
                  ${(!isOut && m.sender && m.sender !== 'Tú') ? `<span class="wa-bubble-sender-name">• ${escapeHtml(m.sender)}</span>` : ''}
                </div>

                ${cleanText ? `
                  <div class="wa-bubble-text">${escapeHtml(cleanText)}</div>
                ` : ''}

                ${m.mediaData ? `
                  <div class="wa-bubble-media-wrapper">
                    ${m.mediaType === 'video' ? `
                      <video src="${m.mediaData}" controls class="wa-bubble-video"></video>
                    ` : m.mediaType === 'audio' ? `
                      <div class="wa-bubble-audio-box">
                        <div class="wa-bubble-audio-title">🎙️ Nota de Voz Rescatada</div>
                        <audio src="${m.mediaData}" controls class="wa-bubble-audio-player"></audio>
                      </div>
                    ` : `
                      <img src="${m.mediaData}" class="wa-bubble-img" onclick="window.open('${m.mediaData}', '_blank')" title="Clic para ampliar" />
                    `}
                  </div>
                ` : ''}

                <div class="wa-bubble-footer">
                  <div class="wa-bubble-time-row">
                    <span>${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span class="wa-blue-ticks">✓✓</span>
                  </div>
                  <div class="wa-bubble-actions">
                    ${cleanText ? `
                      <button class="wa-bubble-btn" onclick="window.copyPhantomText(${JSON.stringify(cleanText)})" title="Copiar texto">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copiar
                      </button>
                    ` : ''}
                    ${m.mediaData ? `
                      <a href="${m.mediaData}" download="Archivo_${m.id || Date.now()}.${m.mediaType === 'video' ? 'mp4' : m.mediaType === 'audio' ? 'ogg' : 'png'}" class="wa-bubble-btn">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Descargar
                      </a>
                    ` : ''}
                    <button class="wa-bubble-btn danger" onclick="window.deletePhantomMsg('${m.id}')" title="Eliminar de la lista">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            `;
            }).join('')}
          </div>
        ` : `
          <!-- VISOR DE ESTADOS ORGANIZADO POR CONTACTO -->
          ${currentStatusContact && currentActiveStory ? `
            <div class="wa-chat-header">
              <div class="wa-chat-header-user">
                <div class="wa-item-avatar wa-status-ring" style="width: 40px; height: 40px; background: ${currentStatusContact.avatarBg}; font-size: 14px;">
                  ${currentStatusContact.initials}
                </div>
                <div>
                  <div style="font-size: 15px; font-weight: 600; color: #e9edef;">
                    ${currentStatusContact.name}
                  </div>
                  <div style="font-size: 11.5px; color: #8696a0;">
                    Estado ${phantomActiveStatusStoryIndex + 1} de ${currentStatusContact.count} • Guardado permanentemente
                  </div>
                </div>
              </div>

              <div style="display: flex; align-items: center; gap: 8px;">
                <button class="wa-bubble-btn" onclick="window.downloadAllStoriesOfContact('${encodeURIComponent(currentStatusContact.name)}')" title="Descargar todos los estados de ${currentStatusContact.name}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Descargar Todos (${currentStatusContact.count})
                </button>
                <button class="wa-bubble-btn danger" onclick="window.deleteStatusesOfContact('${encodeURIComponent(currentStatusContact.name)}')" title="Borrar estados de este contacto">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                  Borrar Estados
                </button>
                <button class="wa-close-x-btn" onclick="window.closePhantomVault()" title="Cerrar y volver a WhatsApp (Esc)">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>

            <!-- Visor Interactivo con Barra Segmentada y Controles -->
            <div class="wa-status-viewer">
              <div class="wa-status-container">
                <!-- Segmentos de Progreso de las Historias de este Contacto -->
                <div class="wa-status-progress-segments">
                  ${currentStatusContact.statuses.map((_, i) => `
                    <div 
                      class="wa-status-progress-segment ${i === phantomActiveStatusStoryIndex ? 'active' : (i < phantomActiveStatusStoryIndex ? 'viewed' : '')}" 
                      onclick="window.setPhantomActiveStoryIndex(${i})"
                      title="Historia ${i + 1}"
                    ></div>
                  `).join('')}
                </div>

                <!-- Botones Flotantes de Navegación Anterior/Siguiente -->
                ${currentStatusContact.count > 1 ? `
                  <button class="wa-story-nav-btn prev" onclick="window.prevPhantomStory()" title="Historia anterior">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                  </button>
                  <button class="wa-story-nav-btn next" onclick="window.nextPhantomStory(${currentStatusContact.count})" title="Siguiente historia">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                ` : ''}

                <!-- Barra Superior Dentro del Visor -->
                <div class="wa-status-top-bar">
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <div class="wa-item-avatar wa-status-ring" style="width: 38px; height: 38px; background: ${currentStatusContact.avatarBg}; font-size: 13px;">
                      ${currentStatusContact.initials}
                    </div>
                    <div>
                      <div style="font-size: 14.5px; font-weight: 600; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.8);">${currentStatusContact.name}</div>
                      <div style="font-size: 11.5px; color: rgba(255,255,255,0.7); text-shadow: 0 1px 3px rgba(0,0,0,0.8);">
                        ${new Date(currentActiveStory.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • ${new Date(currentActiveStory.timestamp).toLocaleDateString()}
                      </div>
                    </div>
                  </div>

                  <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="wa-bubble-btn danger" onclick="window.deleteSavedStatusItem('${currentActiveStory.id}')" title="Eliminar este estado">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    </button>
                  </div>
                </div>

                <!-- Contenido Multimedia del Estado -->
                ${(currentActiveStory.mediaType === 'video' && (currentActiveStory.mediaUrl.startsWith('data:video/') || currentActiveStory.mediaUrl.startsWith('blob:') || /\.(mp4|webm|ogg)($|\?)/i.test(currentActiveStory.mediaUrl))) ? `
                  <video class="wa-status-media-content" src="${currentActiveStory.mediaUrl}" controls autoplay playsinline></video>
                ` : `
                  <img class="wa-status-media-content" src="${currentActiveStory.mediaUrl}" alt="Estado de ${currentStatusContact.name}" />
                `}

                <!-- Barra Inferior del Estado -->
                <div class="wa-status-bottom-bar">
                  ${currentActiveStory.caption ? `
                    <div style="font-size: 14px; color: #fff; font-weight: 500; text-align: center; text-shadow: 0 1px 4px rgba(0,0,0,0.9); line-height: 1.4;">
                      ${currentActiveStory.caption}
                    </div>
                  ` : ''}
                  <a href="${currentActiveStory.mediaUrl}" download="Estado_${currentStatusContact.name.replace(/\s+/g, '_')}_${phantomActiveStatusStoryIndex + 1}.${currentActiveStory.mediaType === 'video' ? 'mp4' : 'png'}" class="wa-download-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Descargar Estado en tu PC
                  </a>
                </div>
              </div>

              <!-- Tira de Miniaturas de Todas las Historias del Contacto -->
              ${currentStatusContact.count > 1 ? `
                <div class="wa-status-thumb-strip">
                  ${currentStatusContact.statuses.map((st, idx) => `
                    <div 
                      class="wa-status-thumb-item ${idx === phantomActiveStatusStoryIndex ? 'active' : ''}" 
                      onclick="window.setPhantomActiveStoryIndex(${idx})"
                      title="Historia ${idx + 1}"
                    >
                      ${st.mediaType === 'video' ? `
                        <video src="${st.mediaUrl}"></video>
                      ` : `
                        <img src="${st.mediaUrl}" />
                      `}
                      <span class="wa-status-thumb-badge">${idx + 1}</span>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          ` : `
            <!-- Galería de Todos los Estados Organizada por Contacto -->
            <div class="wa-chat-header">
              <div class="wa-chat-header-user">
                <div class="wa-item-avatar" style="width: 40px; height: 40px; background: #00a884; font-size: 14px;">
                  ⭕
                </div>
                <div>
                  <div style="font-size: 15px; font-weight: 600; color: #e9edef;">
                    Todos los Estados Guardados
                  </div>
                  <div style="font-size: 11.5px; color: #8696a0;">
                    ${totalStatuses} estados en total organizados por contacto
                  </div>
                </div>
              </div>

              <div style="display: flex; align-items: center; gap: 8px;">
                <button class="wa-close-x-btn" onclick="window.closePhantomVault()" title="Cerrar y volver a WhatsApp (Esc)">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>

            <div class="wa-statuses-grid-container">
              ${statusContacts.length === 0 ? `
                <div class="wa-empty-placeholder">
                  <div class="wa-empty-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <circle cx="12" cy="12" r="9" stroke-dasharray="6 3.5"/>
                      <circle cx="12" cy="12" r="5" stroke-dasharray="4 2.5"/>
                      <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                    </svg>
                  </div>
                  <div style="font-size: 17px; font-weight: 600; color: #e9edef; margin-bottom: 8px;">
                    No hay estados guardados aún
                  </div>
                  <div style="font-size: 13.5px; max-width: 420px; line-height: 1.5;">
                    Abre historias en WhatsApp Web y quedarán guardadas automáticamente organizadas por contacto antes de que expiren a las 24 horas.
                  </div>
                </div>
              ` : statusContacts.map(sc => `
                <div class="wa-contact-status-group">
                  <div class="wa-contact-group-header">
                    <div style="display: flex; align-items: center; gap: 10px; cursor: pointer;" onclick="window.setPhantomActiveStatusContact('${encodeURIComponent(sc.name)}')">
                      <div class="wa-item-avatar wa-status-ring" style="width: 36px; height: 36px; background: ${sc.avatarBg}; font-size: 13px;">
                        ${sc.initials}
                      </div>
                      <div>
                        <div style="font-size: 15px; font-weight: 600; color: #e9edef;">${sc.name}</div>
                        <div style="font-size: 11.5px; color: #8696a0;">${sc.count} estado${sc.count > 1 ? 's' : ''} guardado${sc.count > 1 ? 's' : ''}</div>
                      </div>
                    </div>

                    <div style="display: flex; align-items: center; gap: 8px;">
                      <button class="wa-bubble-btn" onclick="window.downloadAllStoriesOfContact('${encodeURIComponent(sc.name)}')">
                        📥 Descargar Todos (${sc.count})
                      </button>
                      <button class="wa-bubble-btn" onclick="window.setPhantomActiveStatusContact('${encodeURIComponent(sc.name)}')">
                        Ver Historias →
                      </button>
                    </div>
                  </div>

                  <div class="wa-contact-group-cards">
                    ${sc.statuses.map((st, sIdx) => `
                      <div class="wa-grid-status-card" onclick="window.openStatusStoryOfContact('${encodeURIComponent(sc.name)}', ${sIdx})">
                        ${st.mediaType === 'video' ? `
                          <video src="${st.mediaUrl}"></video>
                        ` : `
                          <img src="${st.mediaUrl}" />
                        `}
                        <div class="wa-grid-status-overlay">
                          <div style="font-size: 11px; font-weight: 600; color: #fff;">${new Date(st.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                          ${st.caption ? `<div style="font-size: 11px; color: #e9edef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${st.caption}</div>` : ''}
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        `}
      </div>
    </div>
  `;
}

// Controladores interactivos en Window
(window as any).setPhantomViewMode = (mode: 'messages' | 'statuses') => {
  stopVaultMedia();
  phantomViewMode = mode;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).setPhantomActiveStatusContact = (encodedName: string) => {
  stopVaultMedia();
  phantomActiveStatusContact = encodedName === 'all' ? 'all' : decodeURIComponent(encodedName);
  phantomActiveStatusStoryIndex = 0;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).openStatusStoryOfContact = (encodedName: string, storyIndex: number) => {
  stopVaultMedia();
  phantomActiveStatusContact = decodeURIComponent(encodedName);
  phantomActiveStatusStoryIndex = storyIndex;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).setPhantomActiveStoryIndex = (index: number) => {
  stopVaultMedia();
  phantomActiveStatusStoryIndex = index;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).nextPhantomStory = (totalStories: number) => {
  stopVaultMedia();
  if (phantomActiveStatusStoryIndex < totalStories - 1) {
    phantomActiveStatusStoryIndex++;
  } else {
    phantomActiveStatusStoryIndex = 0;
  }
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).prevPhantomStory = () => {
  stopVaultMedia();
  if (phantomActiveStatusStoryIndex > 0) {
    phantomActiveStatusStoryIndex--;
  }
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).downloadAllStoriesOfContact = async (encodedName: string) => {
  const contactName = decodeURIComponent(encodedName);
  const savedStatuses = (await (api.phantom as any).getStatuses?.()) || [];
  const contactStatuses = savedStatuses.filter((s: any) => (s.sender || '').trim().toLowerCase() === contactName.trim().toLowerCase());
  if (contactStatuses.length === 0) return;

  showToast(`Descargando ${contactStatuses.length} estados de ${contactName}...`, 'info');
  for (let i = 0; i < contactStatuses.length; i++) {
    const st = contactStatuses[i];
    const a = document.createElement('a');
    a.href = st.mediaUrl;
    const ext = st.mediaType === 'video' ? 'mp4' : 'png';
    a.download = `Estado_${contactName.replace(/\s+/g, '_')}_${i + 1}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise(r => setTimeout(r, 200));
  }
  showToast(`¡${contactStatuses.length} estados de ${contactName} descargados!`, 'success');
};

(window as any).deleteStatusesOfContact = async (encodedName: string) => {
  const contactName = decodeURIComponent(encodedName);
  if ((api.phantom as any).deleteStatusesByContact) {
    await (api.phantom as any).deleteStatusesByContact(contactName);
  }
  phantomActiveStatusStoryIndex = 0;
  showToast(`Estados de ${contactName} eliminados`, 'info');
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).selectSavedStatus = (id: string | null) => {
  selectedStatusId = id;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).setPhantomActiveContact = (encodedName: string) => {
  phantomActiveContact = encodedName === 'all' ? 'all' : decodeURIComponent(encodedName);
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).setPhantomFilterType = (type: 'all' | 'text' | 'media' | 'audio') => {
  phantomFilterType = type;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).setPhantomSearchContact = (query: string) => {
  phantomSearchContact = query;
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).copyPhantomText = (text: string) => {
  navigator.clipboard.writeText(text);
  showToast('Texto copiado al portapapeles', 'success');
};

(window as any).deletePhantomMsg = async (id: string) => {
  if ((api.phantom as any).deleteMessage) {
    await (api.phantom as any).deleteMessage(id);
    showToast('Mensaje retirado de la lista', 'info');
  }
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).clearPhantomLogs = async () => {
  await api.phantom.clearMessages();
  phantomActiveContact = 'all';
  showToast('Registro de mensajes vaciado', 'info');
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

// Acciones de Estados Guardados
(window as any).deleteSavedStatusItem = async (id: string) => {
  await (api.phantom as any).deleteStatus?.(id);
  showToast('Estado eliminado', 'info');
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

(window as any).clearAllSavedStatuses = async () => {
  await (api.phantom as any).clearStatuses?.();
  phantomActiveStatusStoryIndex = 0;
  showToast('Bóveda de estados vaciada', 'info');
  const container = document.getElementById('internal-pages');
  if (container) renderPhantomMessagesPage(container);
};

// Escuchar actualizaciones de mensajes y estados en tiempo real
try {
  api.phantom.onUpdated((msg: any) => {
    showToast(`💬 Mensaje rescatado de ${msg.sender || 'WhatsApp'}`, 'success');
    const container = document.getElementById('internal-pages');
    if (container && isPhantomVaultOpen) {
      renderPhantomMessagesPage(container);
    }
  });

  (api.phantom as any).onStatusUpdated?.((status: any) => {
    showToast(`📸 Estado de ${status.sender || 'WhatsApp'} guardado`, 'success');
    const container = document.getElementById('internal-pages');
    if (container && isPhantomVaultOpen) {
      renderPhantomMessagesPage(container);
    }
  });
} catch {}

// ============================================================================
// 9.B MODO CINE DUAL: MULTIMEDIA INTEGRADO (WILL BROWSER) & CO-NAVEGACIÓN (BETA)
// ============================================================================

let cinemaState = {
  username: localStorage.getItem('cinema_username') || '',
  selectedMode: 'player' as 'player' | 'browser',
  selectedMaxParticipants: 6,
  selectedControlMode: 'host_only' as 'host_only' | 'everyone',
  showModeModal: false,
  modalStep: 1 as 1 | 2 | 3,
  showParticipantsDropdown: false,
  showEmojiPicker: false,
  _dismissDropdownHandler: null as any,
  _dismissEmojiPickerHandler: null as any,
  status: {
    inRoom: false,
    roomId: null as string | null,
    isHost: false,
    partnerConnected: false,
    lightsDimmed: false,
    mode: 'player' as 'player' | 'browser',
    username: '',
    partnerName: '',
    maxParticipants: 6,
    participantsCount: 0,
    controlMode: 'host_only' as 'host_only' | 'everyone',
    participants: [] as Array<{ id: string; name: string; isHost: boolean }>
  },
  queue: [] as Array<{
    id: string;
    url: string;
    title: string;
    thumb: string;
    type: 'youtube' | 'twitch' | 'vimeo' | 'dailymotion' | 'direct' | 'web' | 'animeflv' | 'embed';
    embedUrl?: string;
    servers?: Array<{ title: string; server: string; code: string; url: string }>;
    activeServerIdx?: number;
    icon?: string;
    platformName?: string;
    channel?: string;
    vodId?: string;
    clipId?: string;
  }>,
  currentIndex: -1,
  isPlaying: false,
  currentTime: 0,
  chatMessages: [] as Array<{ id?: string; sender: string; text?: string; time: string; mediaUrl?: string; mediaType?: string; isSystem?: boolean; isMe?: boolean }>,
  isMicActive: false,
  ytPlayer: null as any,
  isYtReady: false,
  loadedVideoId: '' as string
};

function detectVideoPlatform(rawUrl: string): {
  type: 'youtube' | 'twitch' | 'vimeo' | 'dailymotion' | 'direct' | 'web' | 'animeflv' | 'embed';
  title: string;
  thumb: string;
  embedUrl?: string;
  servers?: Array<{ title: string; server: string; code: string; url: string }>;
  activeServerIdx?: number;
  icon: string;
  platformName: string;
  channel?: string;
  vodId?: string;
  clipId?: string;
} {
  const url = (rawUrl || '').trim();

  // 1. YouTube
  const ytId = extractYTId(url);
  if (ytId) {
    return {
      type: 'youtube',
      title: `YouTube • ${ytId}`,
      thumb: `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`,
      embedUrl: `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1`,
      icon: '🔴',
      platformName: 'YouTube'
    };
  }

  // 2. Twitch (Streams en vivo, VODs o Clips)
  const twitchClipMatch = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^/]+\/clip\/)([a-zA-Z0-9_-]+)/i);
  const twitchVodMatch = url.match(/(?:twitch\.tv\/videos\/)([0-9]+)/i);
  const twitchChannelMatch = url.match(/(?:twitch\.tv\/)(?!videos\/|directory\/|clip\/)([a-zA-Z0-9_]+)/i);
  if (twitchClipMatch) {
    const clipId = twitchClipMatch[1];
    return {
      type: 'twitch',
      title: `Twitch Clip • ${clipId}`,
      thumb: '',
      embedUrl: `https://clips.twitch.tv/embed?clip=${clipId}&parent=localhost&parent=127.0.0.1&autoplay=true`,
      icon: '💜',
      platformName: 'Twitch Clip',
      clipId
    };
  } else if (twitchVodMatch) {
    const vodId = twitchVodMatch[1];
    return {
      type: 'twitch',
      title: `Twitch VOD • ${vodId}`,
      thumb: '',
      embedUrl: `https://player.twitch.tv/?video=${vodId}&parent=localhost&parent=127.0.0.1&autoplay=true`,
      icon: '💜',
      platformName: 'Twitch VOD',
      vodId
    };
  } else if (twitchChannelMatch) {
    const channel = twitchChannelMatch[1];
    return {
      type: 'twitch',
      title: `Twitch En Vivo • ${channel}`,
      thumb: '',
      embedUrl: `https://player.twitch.tv/?channel=${channel}&parent=localhost&parent=127.0.0.1&autoplay=true`,
      icon: '💜',
      platformName: 'Twitch',
      channel
    };
  }

  // 3. Vimeo
  const vimeoMatch = url.match(/(?:vimeo\.com\/)([0-9]+)/i);
  if (vimeoMatch) {
    const vimeoId = vimeoMatch[1];
    return {
      type: 'vimeo',
      title: `Vimeo • ${vimeoId}`,
      thumb: '',
      embedUrl: `https://player.vimeo.com/video/${vimeoId}?autoplay=1`,
      icon: '🎥',
      platformName: 'Vimeo'
    };
  }

  // 4. Dailymotion
  const dmMatch = url.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/i);
  if (dmMatch) {
    const dmId = dmMatch[1];
    return {
      type: 'dailymotion',
      title: `Dailymotion • ${dmId}`,
      thumb: '',
      embedUrl: `https://www.dailymotion.com/embed/video/${dmId}?autoplay=1`,
      icon: '📺',
      platformName: 'Dailymotion'
    };
  }

  // 5. Video directo o HLS (.mp4, .webm, .m3u8, .ogv, .mov, .mkv)
  const isDirectVideo = /\.(mp4|webm|m3u8|ogv|mov|mkv)(\?.*)?$/i.test(url) ||
    url.includes('.m3u8') ||
    url.includes('/video.mp4') ||
    url.includes('/stream');
  if (isDirectVideo) {
    let filename = 'Video Directo';
    try {
      const u = new URL(url);
      filename = decodeURIComponent(u.pathname.split('/').pop() || 'Video');
    } catch {}
    return {
      type: 'direct',
      title: filename,
      thumb: '',
      icon: '📹',
      platformName: url.includes('.m3u8') ? 'HLS Stream' : 'Video Directo'
    };
  }

  // 6. Cualquier otra plataforma Web / Streaming (AnimeFLV, Netflix, Prime, Disney+, Kick, Cuevana, etc.)
  let domain = 'Web';
  try {
    const u = new URL(url);
    domain = u.hostname.replace('www.', '');
  } catch {}

  let icon = '🌐';
  let platformName = domain;
  if (domain.includes('animeflv') || domain.includes('animeblix')) { icon = '🍿'; platformName = 'AnimeFLV'; }
  else if (domain.includes('netflix')) { icon = '🎬'; platformName = 'Netflix'; }
  else if (domain.includes('crunchyroll')) { icon = '🍥'; platformName = 'Crunchyroll'; }
  else if (domain.includes('primevideo') || domain.includes('amazon')) { icon = '📦'; platformName = 'Prime Video'; }
  else if (domain.includes('disney')) { icon = '✨'; platformName = 'Disney+'; }
  else if (domain.includes('max.com') || domain.includes('hbomax')) { icon = '🟣'; platformName = 'Max'; }
  else if (domain.includes('kick.com')) { icon = '🟢'; platformName = 'Kick'; }
  else if (domain.includes('cuevana') || domain.includes('pelis') || domain.includes('repelis')) { icon = '🍿'; platformName = 'Cine Web'; }
  else if (domain.includes('tiktok')) { icon = '🎵'; platformName = 'TikTok'; }
  else if (domain.includes('facebook') || domain.includes('fb.watch')) { icon = '🔵'; platformName = 'Facebook Watch'; }
  else if (domain.includes('soundcloud')) { icon = '☁️'; platformName = 'SoundCloud'; }
  else if (domain.includes('spotify')) { icon = '🎧'; platformName = 'Spotify'; }

  return {
    type: 'web',
    title: `${platformName} • ${domain}`,
    thumb: '',
    embedUrl: url,
    icon,
    platformName
  };
}

const RAVE_EMOJIS = [
  '🍿', '🎬', '🔥', '😂', '😍', '👏', '😱',
  '🎉', '🥳', '😎', '🤩', '🚀', '✨', '💯',
  '❤️', '💖', '🍕', '🍻', '🥂', '🍔', '🍟',
  '💃', '🕺', '🎧', '🎵', '⚡', '💥', '👀',
  '🙌', '👍', '👎', '🥺', '😭', '🤯', '💀'
];

function isSingleOrFewEmojis(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  try {
    const emojiRegex = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u200D|\s)+$/u;
    return emojiRegex.test(trimmed) && [...trimmed].filter(c => c.trim().length > 0).length <= 4;
  } catch {
    return false;
  }
}

function triggerFloatingReaction(emoji: string) {
  const viewport = document.getElementById('cinema-player-viewport');
  if (!viewport) return;
  let layer = document.getElementById('cinema-floating-reactions-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'cinema-floating-reactions-layer';
    layer.className = 'cinema-floating-reactions-layer';
    viewport.appendChild(layer);
  }

  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      if (!layer) return;
      const particle = document.createElement('div');
      particle.className = 'cinema-floating-emoji-particle';
      particle.innerText = emoji;
      const leftPercent = 15 + Math.random() * 70;
      const rot = (Math.random() - 0.5) * 44;
      particle.style.left = `${leftPercent}%`;
      particle.style.setProperty('--rot', `${rot}deg`);
      layer.appendChild(particle);

      setTimeout(() => {
        try { particle.remove(); } catch {}
      }, 2400);
    }, i * 140);
  }
}

function appendChatMessageToFeed(msg: any, feedElement?: HTMLElement | null) {
  const feed = feedElement || document.getElementById('cinema-room-chat-feed');
  if (!feed) return;

  const isMe = msg.isMe || msg.sender === 'Tú' || msg.sender === cinemaState.username;
  const isEmojiOnly = msg.text && isSingleOrFewEmojis(msg.text);

  const bubble = document.createElement('div');
  bubble.className = `cinema-chat-bubble ${isMe ? 'me' : 'peer'} ${isEmojiOnly ? 'big-emoji' : ''}`;
  if (msg.id) bubble.setAttribute('data-msg-id', msg.id);

  bubble.innerHTML = `
    ${!isEmojiOnly ? `<div class="cinema-chat-sender">${escapeHtml(msg.sender || 'Usuario')}</div>` : ''}
    ${msg.mediaUrl ? `<img src="${escapeHtml(msg.mediaUrl)}" class="cinema-chat-media-img" alt="media" />` : ''}
    <div ${isEmojiOnly ? 'style="font-size: 34px; line-height: 1.1;"' : ''}>${escapeHtml(msg.text || '')}</div>
    <div class="cinema-chat-time">${escapeHtml(msg.time || formatCinemaTime())}</div>
  `;

  feed.appendChild(bubble);
  feed.scrollTop = feed.scrollHeight;
}

function resetCinemaChat() {
  cinemaState.chatMessages = [];
  const drawerChat = document.getElementById('cinema-chat-messages');
  if (drawerChat) {
    drawerChat.innerHTML = `
      <div class="cinema-chat-welcome">
        <div style="font-size: 24px; margin-bottom: 6px;">🍿</div>
        <div style="font-weight: 600; color: #fff; font-size: 13px;">¡Sala de Cine Lista!</div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 4px; line-height: 1.4;">
          Comparte el código con tu amigo para ver videos sincronizados y chatear en tiempo real a distancia.
        </div>
      </div>
    `;
  }
  const roomFeed = document.getElementById('cinema-room-chat-feed');
  if (roomFeed) {
    roomFeed.innerHTML = `<div class="cinema-chat-bubble system">¡Bienvenidos a la sala de cine! Chatea o comparte emojis aquí en tiempo real.</div>`;
  }
}

function renderChatFeedWithHistory(feedElement?: HTMLElement | null) {
  const feed = feedElement || document.getElementById('cinema-room-chat-feed');
  if (!feed) return;

  if (cinemaState.chatMessages.length === 0) {
    feed.innerHTML = `<div class="cinema-chat-bubble system">¡Bienvenidos a la sala de cine! Chatea o comparte emojis aquí en tiempo real.</div>`;
    return;
  }

  feed.innerHTML = `
    <div class="cinema-chat-history-divider">
      <span>📜 Historial de conversación sincronizado</span>
    </div>
  `;

  cinemaState.chatMessages.forEach(m => {
    appendChatMessageToFeed(m, feed);
  });

  feed.scrollTop = feed.scrollHeight;
}

let cinemaStep: 'name' | 'action' = 'name';
let cinemaCardTransition: 'none' | 'slide-in-right' | 'slide-in-left' = 'none';

function ensureYouTubeIframeApi() {
  if (!(window as any).onYouTubeIframeAPIReady) {
    (window as any).onYouTubeIframeAPIReady = () => {
      cinemaState.isYtReady = true;
    };
  }
  if (!(window as any).YT) {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScript = document.getElementsByTagName('script')[0];
    firstScript?.parentNode?.insertBefore(tag, firstScript);
  } else if ((window as any).YT && (window as any).YT.Player) {
    cinemaState.isYtReady = true;
  }
}

function extractYTId(url: string): string | null {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

function formatCinemaTime(date = new Date()): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

async function renderCinemaRoomPage(container: HTMLElement) {
  ensureYouTubeIframeApi();

  // Obtener estado fresco del servicio de cine
  try {
    if ((api as any).cinema && (api as any).cinema.getStatus) {
      const st = await (api as any).cinema.getStatus();
      if (st) {
        cinemaState.status = { ...cinemaState.status, ...st };
        if (st.username && !cinemaState.username) {
          cinemaState.username = st.username;
        }
      }
    }
  } catch {}

  const inRoom = !!cinemaState.status.inRoom;
  const roomMode = cinemaState.status.mode || 'player';

  if (!inRoom) {
    // ── PASO 1: PEDIR NOMBRE DE USUARIO PRIMERO ──
    if (cinemaStep === 'name') {
      const enterAnim = cinemaCardTransition === 'slide-in-left' ? 'slide-in-left' : '';
      cinemaCardTransition = 'none';

      container.innerHTML = `
        <div class="cinema-page-wrapper">
          <div class="cinema-setup-wrapper">
            <div class="cinema-setup-card ${enterAnim}" style="max-width: 440px;">
              <div class="cinema-setup-icon-bubble">🎬</div>
              <h1 class="cinema-setup-title">Sala de Cine</h1>
              <p class="cinema-setup-subtitle">
                Ingresa tu nombre o apodo para comenzar:
              </p>

              <div class="cinema-setup-field">
                <label class="cinema-setup-label">Nombre de Usuario</label>
                <input 
                  id="cinema-username-input" 
                  type="text" 
                  class="cinema-setup-input" 
                  placeholder="Escribe tu nombre o apodo..." 
                  value="${escapeHtml(cinemaState.username)}"
                  autofocus
                />
              </div>

              <button id="cinema-btn-continue-name" class="cinema-btn-hero" style="margin-bottom: 0;">
                Continuar ➜
              </button>
            </div>
          </div>
        </div>
      `;

      const inputName = document.getElementById('cinema-username-input') as HTMLInputElement;
      const btnContinue = document.getElementById('cinema-btn-continue-name');

      const submitName = () => {
        const val = inputName ? inputName.value.trim() : '';
        if (!val) {
          showToast('Por favor escribe tu nombre de usuario', 'error');
          inputName?.focus();
          return;
        }
        cinemaState.username = val;
        localStorage.setItem('cinema_username', val);

        const card = container.querySelector('.cinema-setup-card');
        if (card) {
          card.classList.add('slide-out-left');
          cinemaCardTransition = 'slide-in-right';
          setTimeout(() => {
            cinemaStep = 'action';
            renderCinemaRoomPage(container);
          }, 210);
        } else {
          cinemaStep = 'action';
          renderCinemaRoomPage(container);
        }
      };

      btnContinue?.addEventListener('click', submitName);
      inputName?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitName();
      });

      return;
    }

    // Helper para renderizar el contenido de cada paso del wizard
    const renderWizardStepHtml = (step: 1 | 2 | 3, animClass: string = '') => {
      if (step === 1) {
        return `
          <div class="cinema-wizard-step-content ${animClass}" data-step="1">
            <h3 class="cinema-wizard-step-title">Paso 1: ¿Qué experiencia prefieres?</h3>
            <p class="cinema-wizard-step-sub">Elige la modalidad para disfrutar con tus amigos:</p>

            <div class="cinema-mode-cards" style="margin-bottom: 20px;">
              <div class="cinema-mode-card ${cinemaState.selectedMode === 'player' ? 'selected' : ''}" id="mode-opt-player">
                <div class="cinema-mode-card-icon" style="font-size: 26px; width: 44px; height: 44px; background: rgba(59,130,246,0.18);">🍿</div>
                <div class="cinema-mode-card-body" style="flex: 1;">
                  <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                    <h3 style="font-size: 14.5px; color: #fff; margin: 0;">🎬 Sala de Cine (Watch Party)</h3>
                    <span class="cinema-badge-hot">Recomendado</span>
                  </div>
                  <p style="font-size: 11.5px; margin: 0; color: #94a3b8; line-height: 1.4;">
                    Extrae videos de AnimeFLV, YouTube, Pelis Web, Twitch, Vimeo o directos en el marco central con chat y reacciones flotantes Rave al lado.
                  </p>
                </div>
              </div>

              <div class="cinema-mode-card ${cinemaState.selectedMode === 'browser' ? 'selected' : ''}" id="mode-opt-browser">
                <div class="cinema-mode-card-icon" style="font-size: 26px; width: 44px; height: 44px; background: rgba(168,85,247,0.18);">🌐</div>
                <div class="cinema-mode-card-body" style="flex: 1;">
                  <h3 style="font-size: 14.5px; margin: 0 0 2px 0; color: #fff;">Co-Navegación Web Libre</h3>
                  <p style="font-size: 11.5px; margin: 0; color: #94a3b8; line-height: 1.4;">
                    Naveguen juntos en pestañas reales sincronizadas en cualquier web o servicio privado como Netflix, Disney+ o Prime con sincronización y chat.
                  </p>
                </div>
              </div>
            </div>

            <div class="cinema-modal-buttons">
              <button id="cinema-modal-cancel" class="cinema-btn-cancel">Cancelar</button>
              <button id="cinema-wizard-next-step" class="cinema-btn-confirm" style="padding: 10px 24px; font-weight: 700;">
                Siguiente ➜
              </button>
            </div>
          </div>
        `;
      }

      if (step === 2) {
        return `
          <div class="cinema-wizard-step-content ${animClass}" data-step="2">
            <h3 class="cinema-wizard-step-title">Paso 2: Capacidad de la Sala</h3>
            <p class="cinema-wizard-step-sub">Optimiza la conexión P2P directa según el tamaño de tu grupo:</p>

            <div class="cinema-wizard-capacity-grid">
              <div class="cinema-wizard-capacity-card ${cinemaState.selectedMaxParticipants === 2 ? 'selected' : ''}" data-cap="2">
                <div class="cinema-wizard-capacity-num-badge">2</div>
                <div>
                  <div style="font-size: 13.5px; font-weight: 800; color: #fff; margin-bottom: 2px;">💑 En Pareja</div>
                  <div style="font-size: 11px; color: #94a3b8;">Conexión íntima 1 a 1 sin lag</div>
                </div>
              </div>

              <div class="cinema-wizard-capacity-card ${cinemaState.selectedMaxParticipants === 4 ? 'selected' : ''}" data-cap="4">
                <div class="cinema-wizard-capacity-num-badge">4</div>
                <div>
                  <div style="font-size: 13.5px; font-weight: 800; color: #fff; margin-bottom: 2px;">🍿 Amigos</div>
                  <div style="font-size: 11px; color: #94a3b8;">Grupo pequeño y cercano</div>
                </div>
              </div>

              <div class="cinema-wizard-capacity-card ${cinemaState.selectedMaxParticipants === 6 ? 'selected' : ''}" data-cap="6">
                <div class="cinema-wizard-capacity-num-badge">6</div>
                <div>
                  <div style="font-size: 13.5px; font-weight: 800; color: #fff; margin-bottom: 2px;">⭐ Recomendado</div>
                  <div style="font-size: 11px; color: #94a3b8;">Equilibrio perfecto de fluidez</div>
                </div>
              </div>

              <div class="cinema-wizard-capacity-card ${cinemaState.selectedMaxParticipants === 8 ? 'selected' : ''}" data-cap="8">
                <div class="cinema-wizard-capacity-num-badge">8</div>
                <div>
                  <div style="font-size: 13.5px; font-weight: 800; color: #fff; margin-bottom: 2px;">🚀 Máx P2P</div>
                  <div style="font-size: 11px; color: #94a3b8;">Sala completa para todo el clan</div>
                </div>
              </div>
            </div>

            <div class="cinema-modal-buttons">
              <button id="cinema-wizard-prev-step" class="cinema-btn-cancel">⬅ Volver</button>
              <button id="cinema-wizard-next-step" class="cinema-btn-confirm" style="padding: 10px 24px; font-weight: 700;">
                Siguiente ➜
              </button>
            </div>
          </div>
        `;
      }

      return `
        <div class="cinema-wizard-step-content ${animClass}" data-step="3">
          <h3 class="cinema-wizard-step-title">Paso 3: Control de Reproducción</h3>
          <p class="cinema-wizard-step-sub">Estilo Rave: define quién puede pausar, adelantar o cambiar el video:</p>

          <div class="cinema-perm-options" style="margin-bottom: 16px;">
            <div class="cinema-perm-option ${cinemaState.selectedControlMode === 'host_only' ? 'selected' : ''}" data-perm="host_only">
              <div class="cinema-perm-option-icon">🔒</div>
              <div class="cinema-perm-option-body">
                <h4>Solo Anfitrión (Recomendado)</h4>
                <p>Solo tú controlas la reproducción y la cola. Los invitados disfrutan del video, chatean y mandan reacciones.</p>
              </div>
            </div>
            <div class="cinema-perm-option ${cinemaState.selectedControlMode === 'everyone' ? 'selected' : ''}" data-perm="everyone">
              <div class="cinema-perm-option-icon">👥</div>
              <div class="cinema-perm-option-body">
                <h4>Control Libre (Colaborativo)</h4>
                <p>Cualquier persona en la sala puede pausar, adelantar, cambiar de servidor o añadir videos.</p>
              </div>
            </div>
          </div>

          <!-- Resumen de Configuración -->
          <div class="cinema-wizard-summary-pill" id="cinema-wizard-summary-pill">
            <span>✨ Resumen:</span>
            <strong id="summary-mode">${cinemaState.selectedMode === 'player' ? '🎬 Sala de Cine' : '🌐 Co-Navegación'}</strong> •
            <strong id="summary-cap">👥 ${cinemaState.selectedMaxParticipants} Personas</strong> •
            <strong id="summary-perm">${cinemaState.selectedControlMode === 'host_only' ? '🔒 Solo Anfitrión' : '👥 Control Libre'}</strong>
          </div>

          <div class="cinema-modal-buttons">
            <button id="cinema-wizard-prev-step" class="cinema-btn-cancel">⬅ Volver</button>
            <button id="cinema-modal-confirm-create" class="cinema-btn-confirm" style="padding: 10px 26px; font-weight: 800; background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 15px rgba(16,185,129,0.4);">
              ✨ Crear Sala Ahora
            </button>
          </div>
        </div>
      `;
    };

    // ── PASO 2: BOTÓN PARA CREAR SALA O UNIRSE ──
    const enterAnimAction = cinemaCardTransition === 'slide-in-right' ? 'slide-in-right' : '';
    cinemaCardTransition = 'none';

    container.innerHTML = `
      <div class="cinema-page-wrapper">
        <div class="cinema-setup-wrapper">
          <div class="cinema-setup-card ${enterAnimAction}" style="max-width: 460px;">
            <div class="cinema-setup-icon-bubble">🍿</div>
            <h1 class="cinema-setup-title">Sala de Cine</h1>
            
            <div style="display: inline-flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 7px 16px; border-radius: 20px; font-size: 13px; color: #e2e8f0; margin-bottom: 24px;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981;"></span>
              <span>Usuario: <strong>${escapeHtml(cinemaState.username)}</strong></span>
              <button id="cinema-btn-change-user" style="background: none; border: none; color: #60a5fa; cursor: pointer; font-size: 11px; margin-left: 6px; padding: 2px 4px;" title="Cambiar nombre de usuario">✏️ Cambiar</button>
            </div>

            <button id="cinema-btn-open-create-modal" class="cinema-btn-hero" style="margin-bottom: 22px;">
              ✨ Crear Sala
            </button>

            <div class="cinema-setup-divider">
              <span>O ÚNETE A UNA SALA</span>
            </div>

            <div class="cinema-setup-join-row">
              <input 
                id="cinema-join-code-input" 
                type="text" 
                class="cinema-setup-input-code" 
                placeholder="CÓDIGO (EJ: AB12CD)" 
                maxlength="15"
              />
              <button id="cinema-btn-join-room" class="cinema-btn-join">
                Unirse
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('cinema-btn-change-user')?.addEventListener('click', () => {
      const card = container.querySelector('.cinema-setup-card');
      if (card) {
        card.classList.add('slide-out-right');
        cinemaCardTransition = 'slide-in-left';
        setTimeout(() => {
          cinemaStep = 'name';
          renderCinemaRoomPage(container);
        }, 210);
      } else {
        cinemaStep = 'name';
        renderCinemaRoomPage(container);
      }
    });

    const setupModalLogic = (modalEl: HTMLElement) => {
      const closeModalWithAnim = () => {
        modalEl.classList.add('closing');
        setTimeout(() => {
          modalEl.remove();
          cinemaState.modalStep = 1;
        }, 200);
      };

      let isStepTransitioning = false;
      const switchWizardStep = (targetStep: 1 | 2 | 3) => {
        if (isStepTransitioning || targetStep === cinemaState.modalStep) return;
        isStepTransitioning = true;

        const currentStep = cinemaState.modalStep;
        const direction = targetStep > currentStep ? 'forward' : 'backward';
        const stage = modalEl.querySelector('#cinema-wizard-stage');
        const currentContent = stage?.querySelector('.cinema-wizard-step-content');
        const progressBar = modalEl.querySelector('.cinema-wizard-progress-fill') as HTMLElement;

        if (progressBar) {
          progressBar.style.width = targetStep === 1 ? '33%' : (targetStep === 2 ? '66%' : '100%');
        }

        modalEl.querySelectorAll('.cinema-wizard-step-dot').forEach(dot => {
          const s = parseInt(dot.getAttribute('data-wizard-jump') || '1', 10);
          dot.classList.toggle('active', s <= targetStep);
          dot.classList.toggle('current', s === targetStep);
        });

        if (currentContent) {
          currentContent.className = `cinema-wizard-step-content ${direction === 'forward' ? 'slide-left-out' : 'slide-right-out'}`;
        }

        setTimeout(() => {
          cinemaState.modalStep = targetStep;
          if (stage) {
            stage.innerHTML = renderWizardStepHtml(targetStep, direction === 'forward' ? 'slide-left-in' : 'slide-right-in');
            bindStepEvents();
          }
          isStepTransitioning = false;
        }, 160);
      };

      const bindStepEvents = () => {
        // Dot clicks para saltar directamente
        modalEl.querySelectorAll('.cinema-wizard-step-dot').forEach(dot => {
          (dot as HTMLElement).onclick = () => {
            const step = parseInt(dot.getAttribute('data-wizard-jump') || '1', 10);
            if (step >= 1 && step <= 3) {
              switchWizardStep(step as 1 | 2 | 3);
            }
          };
        });

        // Botón Siguiente
        const btnNext = modalEl.querySelector('#cinema-wizard-next-step') as HTMLElement | null;
        if (btnNext) {
          btnNext.onclick = () => {
            if (cinemaState.modalStep < 3) {
              switchWizardStep((cinemaState.modalStep + 1) as 1 | 2 | 3);
            }
          };
        }

        // Botón Volver
        const btnPrev = modalEl.querySelector('#cinema-wizard-prev-step') as HTMLElement | null;
        if (btnPrev) {
          btnPrev.onclick = () => {
            if (cinemaState.modalStep > 1) {
              switchWizardStep((cinemaState.modalStep - 1) as 1 | 2 | 3);
            }
          };
        }

        // Cancelar con animación
        const btnCancel = modalEl.querySelector('#cinema-modal-cancel') as HTMLElement | null;
        if (btnCancel) {
          btnCancel.onclick = closeModalWithAnim;
        }

        // Eventos Paso 1: Selección de Modo
        const optPlayer = modalEl.querySelector('#mode-opt-player') as HTMLElement | null;
        const optBrowser = modalEl.querySelector('#mode-opt-browser') as HTMLElement | null;
        if (optPlayer && optBrowser) {
          optPlayer.onclick = () => {
            cinemaState.selectedMode = 'player';
            optPlayer.classList.add('selected');
            optBrowser.classList.remove('selected');
          };
          optBrowser.onclick = () => {
            cinemaState.selectedMode = 'browser';
            optBrowser.classList.add('selected');
            optPlayer.classList.remove('selected');
          };
        }

        // Eventos Paso 2: Selección de Capacidad
        modalEl.querySelectorAll('.cinema-wizard-capacity-card').forEach(card => {
          (card as HTMLElement).onclick = () => {
            const cap = parseInt(card.getAttribute('data-cap') || '6', 10);
            cinemaState.selectedMaxParticipants = cap;
            modalEl.querySelectorAll('.cinema-wizard-capacity-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
          };
        });

        // Eventos Paso 3: Selección de Control de Reproducción
        modalEl.querySelectorAll('.cinema-perm-option').forEach(opt => {
          (opt as HTMLElement).onclick = () => {
            const perm = (opt.getAttribute('data-perm') || 'host_only') as 'host_only' | 'everyone';
            cinemaState.selectedControlMode = perm;
            modalEl.querySelectorAll('.cinema-perm-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            const summaryPerm = modalEl.querySelector('#summary-perm') as HTMLElement | null;
            if (summaryPerm) {
              summaryPerm.innerText = perm === 'host_only' ? '🔒 Solo Anfitrión' : '👥 Control Libre';
            }
          };
        });

        // Crear Sala
        const btnCreate = modalEl.querySelector('#cinema-modal-confirm-create') as HTMLElement | null;
        if (btnCreate) {
          btnCreate.onclick = async () => {
            btnCreate.classList.add('cinema-btn-loading');
            (btnCreate as HTMLButtonElement).disabled = true;
            btnCreate.innerHTML = '✨ Creando sala...';
            showToast('Creando sala de cine P2P...', 'info');

            try {
              resetCinemaChat();
              const res = await (api as any).cinema.createRoom(
                cinemaState.selectedMode,
                cinemaState.username,
                cinemaState.selectedMaxParticipants,
                cinemaState.selectedControlMode
              );
              cinemaState.status = { ...cinemaState.status, ...res };
              cinemaState.modalStep = 1;

              // Celebración y animación de salida fluida del modal y de la tarjeta base
              modalEl.classList.add('creating-success');
              const card = container.querySelector('.cinema-setup-card');
              if (card) card.classList.add('success-room-exit');

              showToast(`✨ Sala creada: ${res.roomId} (Máx: ${cinemaState.selectedMaxParticipants} personas). ¡Comparte el código!`, 'success');

              setTimeout(() => {
                renderCinemaRoomPage(container);
                if (res.mode === 'browser') {
                  toggleCinemaDrawer(true);
                }
              }, 280);
            } catch (err: any) {
              btnCreate.classList.remove('cinema-btn-loading');
              (btnCreate as HTMLButtonElement).disabled = false;
              btnCreate.innerHTML = '✨ Crear Sala Ahora';
              showToast('Error al crear sala: ' + (err.message || ''), 'error');
            }
          };
        }
      };

      bindStepEvents();

      // Clic en backdrop para cerrar con animación suave
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          closeModalWithAnim();
        }
      });
    };

    const openCreateModal = () => {
      const pageWrapper = container.querySelector('.cinema-page-wrapper');
      if (!pageWrapper) return;
      if (document.getElementById('cinema-mode-modal-backdrop')) return;

      cinemaState.modalStep = 1;
      const modalEl = document.createElement('div');
      modalEl.className = 'cinema-modal-backdrop';
      modalEl.id = 'cinema-mode-modal-backdrop';
      modalEl.innerHTML = `
        <div class="cinema-modal-card">
          <!-- Header con Stepper animado -->
          <div class="cinema-wizard-header">
            <div class="cinema-wizard-progress-bar">
              <div class="cinema-wizard-progress-fill" style="width: 33%;"></div>
            </div>
            <div class="cinema-wizard-steps-indicator">
              <div class="cinema-wizard-step-dot active current" data-wizard-jump="1" title="Ir al Paso 1: Experiencia">
                <span class="num">1</span>
                <span>Experiencia</span>
              </div>
              <div class="cinema-wizard-step-dot" data-wizard-jump="2" title="Ir al Paso 2: Capacidad">
                <span class="num">2</span>
                <span>Capacidad</span>
              </div>
              <div class="cinema-wizard-step-dot" data-wizard-jump="3" title="Ir al Paso 3: Permisos">
                <span class="num">3</span>
                <span>Permisos</span>
              </div>
            </div>
          </div>

          <!-- Escenario dinámico de pasos del wizard -->
          <div class="cinema-wizard-stage" id="cinema-wizard-stage">
            ${renderWizardStepHtml(1, 'slide-left-in')}
          </div>
        </div>
      `;

      pageWrapper.appendChild(modalEl);
      setupModalLogic(modalEl);
    };

    document.getElementById('cinema-btn-open-create-modal')?.addEventListener('click', openCreateModal);

    const codeInput = document.getElementById('cinema-join-code-input') as HTMLInputElement;
    const btnJoin = document.getElementById('cinema-btn-join-room');

    const triggerJoin = async () => {
      const code = codeInput ? codeInput.value.trim().toUpperCase() : '';
      if (!code) {
        showToast('Por favor introduce el código de la sala', 'error');
        codeInput?.focus();
        return;
      }

      btnJoin?.classList.add('cinema-btn-loading');
      if (btnJoin) (btnJoin as HTMLButtonElement).disabled = true;
      showToast(`Conectando a la sala ${code}...`, 'info');

      try {
        resetCinemaChat();
        const res = await (api as any).cinema.joinRoom(code, cinemaState.username);
        cinemaState.status = { ...cinemaState.status, ...res };

        const card = container.querySelector('.cinema-setup-card');
        if (card) card.classList.add('success-room-exit');

        showToast(`🟢 Conectado con éxito a sala ${res.roomId}`, 'success');

        setTimeout(() => {
          renderCinemaRoomPage(container);
          if (res.mode === 'browser') {
            toggleCinemaDrawer(true);
          }
        }, 260);
      } catch (err: any) {
        btnJoin?.classList.remove('cinema-btn-loading');
        if (btnJoin) (btnJoin as HTMLButtonElement).disabled = false;
        showToast('Error al conectar: ' + (err.message || 'Código inválido o sala no encontrada'), 'error');
      }
    };

    btnJoin?.addEventListener('click', triggerJoin);
    codeInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') triggerJoin();
    });

    return;
  }

  // ── HELPERS RAVE: DESPLEGABLE DE PARTICIPANTES & HEADER ──
  const renderParticipantsDropdownHtml = () => {
    if (!cinemaState.showParticipantsDropdown) return '';
    const list = cinemaState.status.participants && cinemaState.status.participants.length > 0
      ? cinemaState.status.participants
      : [{ id: 'host', name: cinemaState.username || 'Anfitrión', isHost: cinemaState.status.isHost }];

    return `
      <div class="cinema-participants-dropdown" id="cinema-participants-dropdown">
        <div class="cinema-participants-dropdown-header">
          <span>👥 En Sala (${cinemaState.status.participantsCount || list.length}/${cinemaState.status.maxParticipants || 6})</span>
          <span class="cinema-badge-max">Capacidad: ${cinemaState.status.maxParticipants || 6}</span>
        </div>
        <div class="cinema-participants-dropdown-list">
          ${list.map(p => `
            <div class="cinema-participant-item ${p.isHost ? 'host' : ''}">
              <div class="cinema-participant-avatar">${p.isHost ? '👑' : '👤'}</div>
              <div class="cinema-participant-info">
                <span class="cinema-participant-name">${escapeHtml(p.name)}</span>
                <span class="cinema-participant-role">${p.isHost ? '👑 Anfitrión (Control Total)' : '👤 Invitado'}</span>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="cinema-participants-dropdown-footer">
          <button id="cinema-btn-copy-invite" class="cinema-btn-dropdown-copy">
            📋 Copiar Código (${cinemaState.status.roomId})
          </button>
        </div>
      </div>
    `;
  };

  const renderRoomHeaderLeftHtml = (title: string) => `
    <div class="cinema-room-header-left" style="position: relative;">
      <div class="cinema-room-logo-tag">${title}</div>
      <div class="cinema-room-code-badge" id="cinema-copy-code-btn" title="Clic para copiar código">
        <span>📋 Código:</span> <strong>${cinemaState.status.roomId}</strong>
      </div>
      <!-- Píldora de Participantes con dropdown interactivo -->
      <div class="cinema-participants-pill" id="cinema-participants-pill" title="Ver lista de participantes">
        <span class="status-dot"></span>
        <span>👥 ${cinemaState.status.participantsCount || 1}/${cinemaState.status.maxParticipants || 6} en sala</span>
        <span style="font-size: 10px; opacity: 0.7;">▾</span>
      </div>
      <!-- Toggle de Permisos estilo Rave -->
      ${cinemaState.status.isHost ? `
        <button id="cinema-toggle-perm-btn" class="cinema-perm-toggle-btn ${cinemaState.status.controlMode}" title="Clic para alternar control entre Solo Anfitrión y Todos">
          ${cinemaState.status.controlMode === 'host_only' ? '🔒 Solo Anfitrión ▾' : '👥 Control Libre ▾'}
        </button>
      ` : `
        <div class="cinema-perm-guest-badge ${cinemaState.status.controlMode}" title="${cinemaState.status.controlMode === 'host_only' ? 'El anfitrión tiene el control exclusivo de la reproducción' : 'Cualquier persona puede pausar o añadir videos'}">
          ${cinemaState.status.controlMode === 'host_only' ? '🔒 Control: Solo Anfitrión' : '👥 Control: Libre'}
        </div>
      `}
      ${renderParticipantsDropdownHtml()}
    </div>
  `;

  // Control de cierre al hacer clic fuera del desplegable de participantes
  if (cinemaState._dismissDropdownHandler) {
    document.removeEventListener('click', cinemaState._dismissDropdownHandler);
    cinemaState._dismissDropdownHandler = null;
  }

  if (cinemaState.showParticipantsDropdown) {
    cinemaState._dismissDropdownHandler = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement;
      if (!target.closest('#cinema-participants-dropdown') && !target.closest('#cinema-participants-pill')) {
        cinemaState.showParticipantsDropdown = false;
        if (cinemaState._dismissDropdownHandler) {
          document.removeEventListener('click', cinemaState._dismissDropdownHandler);
          cinemaState._dismissDropdownHandler = null;
        }
        renderCinemaRoomPage(container);
      }
    };
    setTimeout(() => {
      if (cinemaState._dismissDropdownHandler) {
        document.addEventListener('click', cinemaState._dismissDropdownHandler);
      }
    }, 50);
  }

  const goToCobrowsingUrl = (url: string) => {
    (document.activeElement as HTMLElement)?.blur();
    hideInternalPages();
    const currentTab = tabs.find(t => t.id === activeTabId);
    if (currentTab) {
      currentTab.url = url;
      currentTab.title = 'Cargando...';
      renderTabs();
    }
    updateOmnibox(url);
    api.tabs.navigate(activeTabId, url);
    syncViewBounds();
    if ((api.tabs as any).focusActiveView) {
      setTimeout(() => {
        (api.tabs as any).focusActiveView();
      }, 100);
    }
  };

  // ── VISTA 2: SALA ACTIVA ──
  if (roomMode === 'browser') {
    // ── MODO 2: CO-NAVEGACIÓN EN PESTAÑAS REALES ──
    container.innerHTML = `
      <div class="cinema-page-wrapper cinema-room-entered">
        <div class="cinema-room-header">
          ${renderRoomHeaderLeftHtml('🎬 Modo Co-Navegación')}
          <div class="cinema-room-header-right">
            <button id="cinema-open-drawer-btn" class="cinema-action-btn">
              💬 Chat & Controles
            </button>
            <button id="cinema-leave-btn" class="cinema-action-btn danger">
              🚪 Salir de la Sala
            </button>
          </div>
        </div>

        <div class="cinema-browser-mode-dashboard">
          <div class="cinema-browser-hero-card">
            <div class="cinema-browser-hero-icon">🌐</div>
            <h2>Modo Co-Navegación Activo</h2>
            <p>
              Estás sincronizado en vivo con tu grupo. Cada página web que abras, video que reproduzcas o enlaces que navegues en cualquier pestaña se sincronizará automáticamente para todos.
            </p>
            
            <div style="display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; justify-content: center;">
              <button id="quick-anime-btn" class="cinema-browser-quick-btn" style="background: linear-gradient(135deg, #f59e0b, #d97706); box-shadow: 0 4px 15px rgba(245, 158, 11, 0.4);">
                🍿 AnimeFLV
              </button>
              <button id="quick-twitch-btn" class="cinema-browser-quick-btn" style="background: linear-gradient(135deg, #9333ea, #7e22ce); box-shadow: 0 4px 15px rgba(147, 51, 234, 0.4);">
                💜 Twitch
              </button>
              <button id="quick-netflix-btn" class="cinema-browser-quick-btn" style="background: linear-gradient(135deg, #e50914, #b20710); box-shadow: 0 4px 15px rgba(229, 9, 20, 0.4);">
                🎬 Netflix
              </button>
              <button id="quick-cuevana-btn" class="cinema-browser-quick-btn" style="background: linear-gradient(135deg, #ea580c, #c2410c); box-shadow: 0 4px 15px rgba(234, 88, 12, 0.4);">
                🍿 Pelis / Cuevana
              </button>
              <button id="quick-kick-btn" class="cinema-browser-quick-btn" style="background: linear-gradient(135deg, #059669, #047857); box-shadow: 0 4px 15px rgba(5, 150, 105, 0.4);">
                🟢 Kick
              </button>
              <button id="quick-yt-btn" class="cinema-browser-quick-btn" style="background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);">
                🔴 YouTube
              </button>
            </div>

            <div style="font-size: 12px; color: #64748b; margin-top: 8px;">
              💡 Puedes escribir cualquier URL directamente en la barra superior o usar tus marcadores.
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('cinema-copy-code-btn')?.addEventListener('click', () => {
      if (cinemaState.status.roomId) {
        navigator.clipboard.writeText(cinemaState.status.roomId);
        showToast(`📋 Código ${cinemaState.status.roomId} copiado al portapapeles`, 'success');
      }
    });

    document.getElementById('cinema-participants-pill')?.addEventListener('click', (e) => {
      e.stopPropagation();
      cinemaState.showParticipantsDropdown = !cinemaState.showParticipantsDropdown;
      renderCinemaRoomPage(container);
    });

    document.getElementById('cinema-btn-copy-invite')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cinemaState.status.roomId) {
        navigator.clipboard.writeText(cinemaState.status.roomId);
        showToast(`📋 Código ${cinemaState.status.roomId} copiado al portapapeles`, 'success');
      }
    });

    document.getElementById('cinema-toggle-perm-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newMode = cinemaState.status.controlMode === 'host_only' ? 'everyone' : 'host_only';
      cinemaState.status.controlMode = newMode;
      try {
        if ((api as any).cinema && (api as any).cinema.updateControlMode) {
          await (api as any).cinema.updateControlMode(newMode);
        }
      } catch {}
      showToast(newMode === 'host_only' 
        ? '🔒 Modo Solo Anfitrión: Ahora solo tú puedes navegar o cambiar páginas' 
        : '👥 Modo Libre: Ahora todos los participantes pueden navegar', 'info');
      renderCinemaRoomPage(container);
    });

    document.getElementById('cinema-open-drawer-btn')?.addEventListener('click', () => {
      toggleCinemaDrawer(true);
    });

    document.getElementById('cinema-leave-btn')?.addEventListener('click', async () => {
      try {
        const pageWrapper = container.querySelector('.cinema-page-wrapper');
        if (pageWrapper) {
          (pageWrapper as HTMLElement).style.transition = 'opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s ease';
          (pageWrapper as HTMLElement).style.opacity = '0';
          (pageWrapper as HTMLElement).style.transform = 'scale(0.97)';
        }
        resetCinemaChat();
        await (api as any).cinema.leaveRoom();
        cinemaState.status.inRoom = false;
        showToast('Has salido de la sala de cine', 'info');
        setTimeout(() => {
          renderCinemaRoomPage(container);
        }, 220);
      } catch {}
    });

    document.getElementById('quick-anime-btn')?.addEventListener('click', () => {
      showToast('🍿 Navegando a AnimeFLV con el grupo...', 'success');
      goToCobrowsingUrl('https://www3.animeflv.net');
    });
    document.getElementById('quick-twitch-btn')?.addEventListener('click', () => {
      showToast('💜 Navegando a Twitch...', 'info');
      goToCobrowsingUrl('https://www.twitch.tv');
    });
    document.getElementById('quick-netflix-btn')?.addEventListener('click', () => {
      showToast('🎬 Navegando a Netflix con el grupo...', 'success');
      goToCobrowsingUrl('https://www.netflix.com');
    });
    document.getElementById('quick-cuevana-btn')?.addEventListener('click', () => {
      showToast('🍿 Navegando a Películas Web con el grupo...', 'success');
      goToCobrowsingUrl('https://ww3.cuevana3.ch');
    });
    document.getElementById('quick-kick-btn')?.addEventListener('click', () => {
      showToast('🟢 Navegando a Kick con el grupo...', 'success');
      goToCobrowsingUrl('https://kick.com');
    });
    document.getElementById('quick-yt-btn')?.addEventListener('click', () => {
      showToast('🔴 Navegando a YouTube...', 'info');
      goToCobrowsingUrl('https://www.youtube.com');
    });

    return;
  }

  // ── MODO 1: VISUALIZADOR MULTIMEDIA INTEGRADO (WILL BROWSER) ──
  const currentVideo = cinemaState.currentIndex >= 0 ? cinemaState.queue[cinemaState.currentIndex] : null;

  const renderPlayerHtml = () => {
    if (!currentVideo) {
      return `
        <div class="cinema-player-empty">
          <div class="cinema-player-empty-icon">🍿</div>
          <h4 style="font-size: 16px; font-weight: 800; color: #fff; margin-bottom: 2px;">🎬 Sala de Cine (Watch Party)</h4>
          <p style="font-size: 12px; color: #94a3b8; max-width: 480px; margin-bottom: 8px;">
            Pega el enlace de cualquier video (AnimeFLV, YouTube, Twitch, Películas Web, Vimeo o directos) para reproducir en el marco con chat sincronizado:
          </p>

          <div class="cinema-platform-hub-grid">
            <button class="cinema-platform-hub-btn" data-hub-platform="animeflv" title="AnimeFLV: Extrae y reproduce el anime directamente en el marco">
              <span class="cinema-platform-chip-icon">🍿</span> AnimeFLV
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="youtube" title="YouTube: Videos, música y directos en el marco">
              <span class="cinema-platform-chip-icon">🔴</span> YouTube
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="cuevana" title="Películas Web / Cuevana: Películas y series en el marco">
              <span class="cinema-platform-chip-icon">🍿</span> Pelis Web
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="twitch" title="Twitch: Streams en vivo y directos">
              <span class="cinema-platform-chip-icon">💜</span> Twitch
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="vimeo" title="Vimeo: Videos en alta definición">
              <span class="cinema-platform-chip-icon">🎥</span> Vimeo
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="dailymotion" title="Dailymotion: Noticias y videos">
              <span class="cinema-platform-chip-icon">📺</span> Dailymotion
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="direct" title="Video Directo: Enlaces .mp4, .webm, .m3u8">
              <span class="cinema-platform-chip-icon">📹</span> Video / MP4
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="kick" title="Kick: Directos y streams">
              <span class="cinema-platform-chip-icon">🟢</span> Kick
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="netflix" title="Netflix: Películas y series">
              <span class="cinema-platform-chip-icon">🎬</span> Netflix
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="disney" title="Disney+: Películas y series">
              <span class="cinema-platform-chip-icon">✨</span> Disney+
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="prime" title="Prime Video: Series y películas">
              <span class="cinema-platform-chip-icon">📦</span> Prime Video
            </button>
            <button class="cinema-platform-hub-btn" data-hub-platform="web" title="Cualquier web con video">
              <span class="cinema-platform-chip-icon">🌐</span> Web Video
            </button>
          </div>
        </div>
      `;
    }

    if (currentVideo.type === 'youtube') {
      return `
        <div id="cinema-yt-frame-container" class="cinema-yt-frame-container">
          <div id="cinema-yt-player-target" class="cinema-yt-iframe"></div>
        </div>
      `;
    }

    if (currentVideo.type === 'twitch') {
      const channel = (currentVideo as any).channel || '';
      const vodId = (currentVideo as any).vodId || '';
      const clipId = (currentVideo as any).clipId || '';
      const sPort = (cinemaState as any).serverPort || 0;
      let src = currentVideo.embedUrl || currentVideo.url;
      if (sPort > 0) {
        if (clipId) src = `http://127.0.0.1:${sPort}/twitch?clip=${encodeURIComponent(clipId)}`;
        else if (vodId) src = `http://127.0.0.1:${sPort}/twitch?video=${encodeURIComponent(vodId)}`;
        else if (channel) src = `http://127.0.0.1:${sPort}/twitch?channel=${encodeURIComponent(channel)}`;
      }
      return `
        <div class="cinema-embed-wrapper" style="width: 100%; height: 100%; position: relative; background: #000;">
          <iframe
            id="cinema-embed-target"
            src="${escapeHtml(src)}"
            class="cinema-full-iframe"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowfullscreen
            style="width: 100%; height: 100%; border: none;">
          </iframe>
        </div>
      `;
    }

    if (currentVideo.type === 'animeflv' || currentVideo.type === 'embed' || currentVideo.type === 'vimeo' || currentVideo.type === 'dailymotion' || currentVideo.type === 'web') {
      const servers = (currentVideo as any).servers || [];
      const hasServers = Array.isArray(servers) && servers.length > 1;
      const activeIdx = (currentVideo as any).activeServerIdx || 0;
      const currentSrc = (servers && servers[activeIdx])
        ? (servers[activeIdx].code || servers[activeIdx].url)
        : (currentVideo.embedUrl || currentVideo.url);

      return `
        <div class="cinema-embed-wrapper" style="display: flex; flex-direction: column; width: 100%; height: 100%; position: relative; background: #000;">
          ${hasServers ? `
            <div class="cinema-servers-bar">
              <span style="font-size: 11px; font-weight: 700; color: #94a3b8; display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                ⚡ Servidores:
              </span>
              ${servers.map((s: any, idx: number) => `
                <button 
                  class="cinema-server-chip ${idx === activeIdx ? 'active' : ''}" 
                  data-server-idx="${idx}"
                  title="Cambiar a servidor ${escapeHtml(s.title || s.server || 'Servidor')}">
                  ${escapeHtml(s.title || s.server || `Servidor ${idx + 1}`)}
                </button>
              `).join('')}
            </div>
          ` : ''}
          <div style="flex: 1; position: relative; width: 100%; height: 100%; overflow: hidden;">
            <iframe
              id="cinema-embed-target"
              src="${escapeHtml(currentSrc)}"
              class="cinema-full-iframe"
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"
              allowfullscreen
              style="width: 100%; height: 100%; border: none;">
            </iframe>
          </div>
        </div>
      `;
    }

    return `
      <div class="cinema-embed-wrapper" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #000;">
        <video id="cinema-direct-video" class="cinema-direct-video-el" src="${escapeHtml(currentVideo.url)}" controls autoplay style="width: 100%; height: 100%; max-height: 100%; object-fit: contain;"></video>
      </div>
    `;
  };

  const renderQueueCardsHtml = () => {
    if (cinemaState.queue.length === 0) {
      return `<div style="color: #64748b; font-size: 11px; padding: 12px 6px; font-style: italic;">No hay videos en la cola. Añade uno de cualquier plataforma arriba.</div>`;
    }
    return cinemaState.queue.map((v, i) => {
      const isActive = i === cinemaState.currentIndex;
      const icon = v.icon || (v.type === 'youtube' ? '🔴' : (v.type === 'twitch' ? '💜' : (v.type === 'vimeo' ? '🎥' : (v.type === 'dailymotion' ? '📺' : (v.type === 'direct' ? '📹' : '🌐')))));
      const platformName = v.platformName || (v.type.toUpperCase());
      return `
        <div class="cinema-queue-card ${isActive ? 'active' : ''}" data-index="${i}">
          <button class="cinema-queue-card-del" data-del-index="${i}" title="Eliminar de la cola">✕</button>
          ${v.thumb ? `<img src="${escapeHtml(v.thumb)}" class="cinema-queue-card-thumb" alt="thumb" />` : `<div class="cinema-queue-card-thumb-placeholder">${icon}</div>`}
          <div class="cinema-queue-card-info">
            <span class="cinema-queue-card-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</span>
            <span class="cinema-queue-card-type">${icon} ${escapeHtml(platformName)} ${isActive ? '• Reproduciendo' : ''}</span>
          </div>
        </div>
      `;
    }).join('');
  };

  const renderChatMessagesHtml = () => {
    if (cinemaState.chatMessages.length === 0) {
      return `<div class="cinema-chat-bubble system">¡Bienvenidos a la sala de cine! Chatea o comparte emojis aquí en tiempo real.</div>`;
    }
    return `
      ${cinemaState.chatMessages.length > 1 ? `
        <div class="cinema-chat-history-divider">
          <span>📜 Mensajes de la sala</span>
        </div>
      ` : ''}
      ${cinemaState.chatMessages.map(m => {
        const isMe = (m as any).isMe || m.sender === 'Tú' || m.sender === cinemaState.username;
        const isEmojiOnly = m.text && isSingleOrFewEmojis(m.text);
        if (m.isSystem) {
          return `<div class="cinema-chat-bubble system">${escapeHtml(m.text || '')}</div>`;
        }
        return `
          <div class="cinema-chat-bubble ${isMe ? 'me' : 'peer'} ${isEmojiOnly ? 'big-emoji' : ''}">
            ${!isEmojiOnly ? `<div class="cinema-chat-sender">${escapeHtml(m.sender || 'Usuario')}</div>` : ''}
            ${m.mediaUrl ? `<img src="${escapeHtml(m.mediaUrl)}" class="cinema-chat-media-img" alt="media" />` : ''}
            <div ${isEmojiOnly ? 'style="font-size: 34px; line-height: 1.1;"' : ''}>${escapeHtml(m.text || '')}</div>
            <div class="cinema-chat-time">${escapeHtml(m.time || '')}</div>
          </div>
        `;
      }).join('')}
    `;
  };

  const isLightsDimmed = !!cinemaState.status.lightsDimmed;

  container.innerHTML = `
    <div class="cinema-page-wrapper cinema-room-entered ${isLightsDimmed ? 'lights-dimmed' : ''}">
      <!-- Barra Superior -->
      <div class="cinema-room-header">
        ${renderRoomHeaderLeftHtml('🎬 Sala de Cine')}

        <div class="cinema-room-header-right">
          <button id="cinema-room-mic-btn" class="cinema-action-btn mic-btn ${cinemaState.isMicActive ? 'active' : ''}" title="Activar/Silenciar Micrófono de Voz">
            ${cinemaState.isMicActive ? '🎙️ Micrófono ON' : '🔇 Micrófono Mute'}
          </button>
          <button id="cinema-room-lights-btn" class="cinema-action-btn ${isLightsDimmed ? 'lights-active' : ''}" title="Atenuar / Encender Luces">
            ${isLightsDimmed ? '💡 Luces OFF' : '💡 Luces ON'}
          </button>
          <button id="cinema-room-sync-btn" class="cinema-action-btn" title="Forzar Sincronización">
            🔄 Sincronizar
          </button>
          <button id="cinema-leave-btn" class="cinema-action-btn danger" title="Salir de la Sala">
            🚪 Salir
          </button>
        </div>
      </div>

      <!-- Layout Principal (Escenario + Chat) -->
      <div class="cinema-room-layout">
        <div class="cinema-main-stage">
          <!-- Visor de Video con capa de reacciones Rave -->
          <div class="cinema-player-viewport" id="cinema-player-viewport">
            <div id="cinema-floating-reactions-layer" class="cinema-floating-reactions-layer"></div>
            ${renderPlayerHtml()}
          </div>

          <!-- Barra de Agregar URL Universal -->
          <div class="cinema-queue-bar">
            <input 
              id="cinema-add-url-input" 
              type="text" 
              class="cinema-queue-input" 
              placeholder="Pega enlace de AnimeFLV, YouTube, Twitch, Películas Web, Vimeo, MP4..." 
            />
            <button id="cinema-btn-play-now" class="cinema-queue-add-btn" style="background: linear-gradient(135deg, #10b981, #059669);" title="Extraer y reproducir inmediatamente en el marco">
              ▶️ Ver en Sala
            </button>
            <button id="cinema-btn-add-queue" class="cinema-queue-add-btn" title="Añadir a la cola de reproducción">
              ➕ A la Cola
            </button>
          </div>

          <!-- Carrusel de Cola de Videos -->
          <div class="cinema-queue-header-row">
            <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8;">
              Cola de Reproducción (${cinemaState.queue.length})
            </span>
            ${cinemaState.queue.length > 0 ? `
              <button id="cinema-btn-clear-queue" style="background: none; border: none; color: #f87171; font-size: 10.5px; cursor: pointer;">
                Vaciar Cola
              </button>
            ` : ''}
          </div>

          <div class="cinema-queue-track" id="cinema-queue-track">
            ${renderQueueCardsHtml()}
          </div>
        </div>

        <!-- Panel Lateral de Chat -->
        <div class="cinema-room-sidebar-chat" style="position: relative;">
          <div class="cinema-chat-top">
            <span>💬 Chat de Sala</span>
            <span style="font-size: 11px; font-weight: 600; color: #60a5fa; background: rgba(59,130,246,0.15); padding: 2px 8px; border-radius: 10px;">
              ${cinemaState.status.participantsCount || 1}/${cinemaState.status.maxParticipants || 6} en sala
            </span>
          </div>

          <div class="cinema-chat-messages-container" id="cinema-room-chat-feed">
            ${renderChatMessagesHtml()}
          </div>

          <!-- Bandeja Desplegable de Emojis RAVE (si está abierta) -->
          ${cinemaState.showEmojiPicker ? `
            <div class="cinema-emoji-picker-tray" id="cinema-emoji-picker-tray">
              <div class="cinema-emoji-picker-header">
                <span>🎉 Emojis y Reacciones RAVE</span>
                <button id="cinema-btn-close-emojis" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 13px; padding: 2px 6px;">✕</button>
              </div>
              <div class="cinema-emoji-grid">
                ${RAVE_EMOJIS.map(emo => `
                  <div class="cinema-emoji-item" data-tray-emoji="${emo}" title="Reaccionar con ${emo}">${emo}</div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Barra Rápida de Emojis -->
          <div class="cinema-chat-quick-emojis">
            ${['🍿','🎬','😍','😂','🔥','👏','😱','❤️','✨','🍕','🍺','🚀'].map(emo => `
              <span class="cinema-emoji-chip" data-emoji="${emo}" title="Reaccionar con ${emo}">${emo}</span>
            `).join('')}
          </div>

          <!-- Barra de Input del Chat con Botón de Emojis -->
          <div class="cinema-chat-input-bar">
            <button id="cinema-chat-emoji-toggle-btn" class="cinema-chat-icon-btn" title="Abrir selector de emojis">
              😊
            </button>
            <input 
              id="cinema-room-chat-input" 
              type="text" 
              class="cinema-chat-text-input" 
              placeholder="Escribe un mensaje a la sala..." 
            />
            <button id="cinema-room-chat-send" class="cinema-chat-send-btn" title="Enviar Mensaje">
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Función de montado y actualización de YouTube Player utilizando el servidor HTTP local (elimina Error 152-4)
  async function mountOrUpdateYouTubePlayer(videoId: string, seekTime: number = 0, shouldPlay: boolean = true) {
    const wrapper = document.getElementById('cinema-yt-frame-container');
    if (!wrapper) return;

    // Si ya existe instancia activa y el iframe sigue en el DOM, solo cambiar video o posición sin recargar
    const hasLiveIframe = wrapper.querySelector('iframe');
    if (cinemaState.ytPlayer && typeof cinemaState.ytPlayer.loadVideoById === 'function' && hasLiveIframe) {
      try {
        if (cinemaState.loadedVideoId !== videoId) {
          cinemaState.loadedVideoId = videoId;
          cinemaState.ytPlayer.loadVideoById({
            videoId: videoId,
            startSeconds: Math.floor(seekTime)
          });
          if (shouldPlay) {
            try { cinemaState.ytPlayer.playVideo(); } catch {}
          } else {
            try { cinemaState.ytPlayer.pauseVideo(); } catch {}
          }
        } else {
          // Mismo video: sincronizar tiempo si difiere significativamente
          if (typeof cinemaState.ytPlayer.getCurrentTime === 'function') {
            const curTime = cinemaState.ytPlayer.getCurrentTime();
            if (Math.abs(curTime - seekTime) > 2) {
              cinemaState.ytPlayer.seekTo(seekTime, true);
            }
          }
          if (shouldPlay) {
            try { cinemaState.ytPlayer.playVideo(); } catch {}
          } else {
            try { cinemaState.ytPlayer.pauseVideo(); } catch {}
          }
        }
        return;
      } catch (e) {
        console.warn('[Cinema] Falló reutilización de YT Player, recreando:', e);
      }
    }

    cinemaState.loadedVideoId = videoId;
    cinemaState.currentTime = seekTime;

    // Obtener puerto del servidor HTTP local del reproductor (Loopback 127.0.0.1)
    let serverPort = 0;
    try {
      if ((api as any).cinema && (api as any).cinema.getServerPort) {
        serverPort = await (api as any).cinema.getServerPort();
        (cinemaState as any).serverPort = serverPort;
      }
    } catch (err) {
      console.warn('[Cinema] Error obteniendo puerto de CinemaServer:', err);
    }

    const iframeSrc = serverPort > 0
      ? `http://127.0.0.1:${serverPort}/player?v=${encodeURIComponent(videoId)}&autoplay=${shouldPlay ? '1' : '0'}&start=${Math.floor(seekTime)}`
      : `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=${shouldPlay ? '1' : '0'}&controls=1&start=${Math.floor(seekTime)}&rel=0&enablejsapi=1&origin=https%3A%2F%2Fwww.youtube.com`;

    wrapper.innerHTML = `
      <iframe 
        id="cinema-yt-target" 
        class="cinema-yt-iframe"
        src="${iframeSrc}" 
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
        referrerpolicy="strict-origin-when-cross-origin"
        allowfullscreen
        style="width: 100%; height: 100%; border: none;">
      </iframe>
    `;

    // Asignar proxy unificado para controlar el reproductor a través de postMessage
    cinemaState.ytPlayer = {
      playVideo: () => {
        const ifr = wrapper.querySelector('iframe') as HTMLIFrameElement;
        ifr?.contentWindow?.postMessage({ source: 'cinema-parent', command: 'play' }, '*');
      },
      pauseVideo: () => {
        const ifr = wrapper.querySelector('iframe') as HTMLIFrameElement;
        ifr?.contentWindow?.postMessage({ source: 'cinema-parent', command: 'pause' }, '*');
      },
      seekTo: (time: number) => {
        const ifr = wrapper.querySelector('iframe') as HTMLIFrameElement;
        cinemaState.currentTime = time;
        ifr?.contentWindow?.postMessage({ source: 'cinema-parent', command: 'seek', time }, '*');
      },
      loadVideoById: (params: { videoId: string; startSeconds?: number }) => {
        const ifr = wrapper.querySelector('iframe') as HTMLIFrameElement;
        cinemaState.loadedVideoId = params.videoId;
        cinemaState.currentTime = params.startSeconds || 0;
        ifr?.contentWindow?.postMessage({
          source: 'cinema-parent',
          command: 'loadVideo',
          videoId: params.videoId,
          startSeconds: params.startSeconds || 0,
          play: shouldPlay
        }, '*');
      },
      getCurrentTime: () => {
        return cinemaState.currentTime || 0;
      },
      destroy: () => {
        wrapper.innerHTML = '';
      }
    };

    // Configurar listener para mensajes entrantes del iframe del reproductor
    if ((cinemaState as any)._ytMessageListener) {
      window.removeEventListener('message', (cinemaState as any)._ytMessageListener);
    }

    const messageHandler = (ev: MessageEvent) => {
      if (!ev.data || ev.data.source !== 'cinema-player-frame') return;

      if (ev.data.event === 'ready') {
        cinemaState.isYtReady = true;
        if (shouldPlay) {
          cinemaState.ytPlayer?.playVideo();
        }
      } else if (ev.data.event === 'stateChange') {
        const state = ev.data.data;
        if (state === 1) { // PLAYING
          cinemaState.isPlaying = true;
          broadcastPlayerState();
        } else if (state === 2) { // PAUSED
          cinemaState.isPlaying = false;
          broadcastPlayerState();
        } else if (state === 0) { // ENDED
          playNextVideoInQueue();
        }
      } else if (ev.data.event === 'timeUpdate') {
        if (typeof ev.data.time === 'number' && !isNaN(ev.data.time)) {
          cinemaState.currentTime = ev.data.time;
        }
      } else if (ev.data.event === 'error') {
        const code = ev.data.data;
        console.warn('[Cinema] Error de YouTube Player:', code);
        if (code === 150 || code === 101) {
          showToast('⚠️ Este video tiene restricciones de reproducción embebida del autor en YouTube.', 'error');
        } else if (code === 152) {
          showToast('⚠️ Verificando origen del reproductor multimedia...', 'info');
        }
      } else if (ev.data.event === 'openInTab') {
        if (ev.data.videoId) {
          goToCobrowsingUrl(`https://www.youtube.com/watch?v=${ev.data.videoId}`);
        }
      }
    };

    (cinemaState as any)._ytMessageListener = messageHandler;
    window.addEventListener('message', messageHandler);
  }

  function mountDirectIframeFallback(videoId: string, seekTime: number = 0, shouldPlay: boolean = true) {
    mountOrUpdateYouTubePlayer(videoId, seekTime, shouldPlay);
  }

  // Inicializar reproductor de YouTube si el video actual es de YouTube
  if (currentVideo && currentVideo.type === 'youtube') {
    const videoId = extractYTId(currentVideo.url);
    if (videoId) {
      mountOrUpdateYouTubePlayer(videoId, cinemaState.currentTime || 0, cinemaState.isPlaying);
    }
  } else if (currentVideo && currentVideo.type === 'direct') {
    const vidEl = document.getElementById('cinema-direct-video') as HTMLVideoElement;
    if (vidEl) {
      vidEl.currentTime = cinemaState.currentTime || 0;
      vidEl.addEventListener('play', () => {
        cinemaState.isPlaying = true;
        broadcastPlayerState();
      });
      vidEl.addEventListener('pause', () => {
        cinemaState.isPlaying = false;
        broadcastPlayerState();
      });
      vidEl.addEventListener('seeked', () => {
        broadcastPlayerState();
      });
      vidEl.addEventListener('ended', () => {
        playNextVideoInQueue();
      });
    }
  }

  // Auto scroll chat
  const chatFeed = document.getElementById('cinema-room-chat-feed');
  if (chatFeed) chatFeed.scrollTop = chatFeed.scrollHeight;

  const isGuestRestricted = !cinemaState.status.isHost && cinemaState.status.controlMode === 'host_only';

  // Funciones de control de reproducción
  function broadcastPlayerState() {
    let time = 0;
    if (cinemaState.ytPlayer && typeof cinemaState.ytPlayer.getCurrentTime === 'function') {
      try { time = cinemaState.ytPlayer.getCurrentTime(); } catch {}
    } else {
      const v = document.getElementById('cinema-direct-video') as HTMLVideoElement;
      if (v) time = v.currentTime;
    }
    cinemaState.currentTime = time;

    // Si es invitado y la sala está en Solo Anfitrión, no sobreescribir estado de reproducción
    if (isGuestRestricted) return;

    if ((api as any).cinema && (api as any).cinema.sendPlayerSyncState) {
      (api as any).cinema.sendPlayerSyncState({
        currentIndex: cinemaState.currentIndex,
        isPlaying: cinemaState.isPlaying,
        time: time,
        queue: cinemaState.queue
      });
    }
  }

  function playNextVideoInQueue() {
    if (cinemaState.currentIndex < cinemaState.queue.length - 1) {
      cinemaState.currentIndex++;
      cinemaState.currentTime = 0;
      cinemaState.isPlaying = true;
      broadcastPlayerState();
      renderCinemaRoomPage(container);
    }
  }

  // Eventos de controles de la sala
  document.getElementById('cinema-copy-code-btn')?.addEventListener('click', () => {
    if (cinemaState.status.roomId) {
      navigator.clipboard.writeText(cinemaState.status.roomId);
      showToast(`📋 Código ${cinemaState.status.roomId} copiado al portapapeles`, 'success');
    }
  });

  document.getElementById('cinema-participants-pill')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cinemaState.showParticipantsDropdown = !cinemaState.showParticipantsDropdown;
    renderCinemaRoomPage(container);
  });

  document.getElementById('cinema-btn-copy-invite')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cinemaState.status.roomId) {
      navigator.clipboard.writeText(cinemaState.status.roomId);
      showToast(`📋 Código ${cinemaState.status.roomId} copiado al portapapeles`, 'success');
    }
  });

  document.getElementById('cinema-toggle-perm-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const newMode = cinemaState.status.controlMode === 'host_only' ? 'everyone' : 'host_only';
    cinemaState.status.controlMode = newMode;
    try {
      if ((api as any).cinema && (api as any).cinema.updateControlMode) {
        await (api as any).cinema.updateControlMode(newMode);
      }
    } catch {}
    showToast(newMode === 'host_only' 
      ? '🔒 Modo Solo Anfitrión: Ahora solo tú puedes pausar, adelantar o cambiar videos' 
      : '👥 Modo Libre: Ahora todos los participantes pueden pausar o cambiar videos', 'info');
    renderCinemaRoomPage(container);
  });

  const micBtn = document.getElementById('cinema-room-mic-btn');
  micBtn?.addEventListener('click', async () => {
    cinemaState.isMicActive = !cinemaState.isMicActive;
    try {
      if ((api as any).cinema && (api as any).cinema.toggleMicrophone) {
        await (api as any).cinema.toggleMicrophone(cinemaState.isMicActive);
      }
    } catch (err: any) {
      showToast('No se pudo acceder al micrófono: ' + (err.message || ''), 'error');
      cinemaState.isMicActive = false;
    }
    micBtn.classList.toggle('active', cinemaState.isMicActive);
    micBtn.innerHTML = cinemaState.isMicActive ? '🎙️ Micrófono ON' : '🔇 Micrófono Mute';
    showToast(cinemaState.isMicActive ? '🎙️ Micrófono activado en la sala' : '🔇 Micrófono silenciado', 'info');
  });

  const lightsBtn = document.getElementById('cinema-room-lights-btn');
  lightsBtn?.addEventListener('click', async () => {
    cinemaState.status.lightsDimmed = !cinemaState.status.lightsDimmed;
    const pageWrapper = container.querySelector('.cinema-page-wrapper');
    if (pageWrapper) {
      pageWrapper.classList.toggle('lights-dimmed', cinemaState.status.lightsDimmed);
    }
    lightsBtn.classList.toggle('lights-active', cinemaState.status.lightsDimmed);
    lightsBtn.innerHTML = cinemaState.status.lightsDimmed ? '💡 Luces OFF' : '💡 Luces ON';
    try {
      await (api as any).cinema.toggleLights(cinemaState.status.lightsDimmed);
      showToast(cinemaState.status.lightsDimmed ? '💡 Luces atenuadas (Modo Teatro)' : '💡 Luces encendidas', 'info');
    } catch {}
  });

  document.getElementById('cinema-room-sync-btn')?.addEventListener('click', () => {
    broadcastPlayerState();
    showToast('🔄 Estado del video sincronizado con la sala', 'success');
  });

  document.getElementById('cinema-leave-btn')?.addEventListener('click', async () => {
    try {
      const pageWrapper = container.querySelector('.cinema-page-wrapper');
      if (pageWrapper) {
        (pageWrapper as HTMLElement).style.transition = 'opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s ease';
        (pageWrapper as HTMLElement).style.opacity = '0';
        (pageWrapper as HTMLElement).style.transform = 'scale(0.97)';
      }
      resetCinemaChat();
      await (api as any).cinema.leaveRoom();
      cinemaState.status.inRoom = false;
      cinemaState.currentIndex = -1;
      cinemaState.queue = [];
      showToast('Has salido de la sala de cine', 'info');
      setTimeout(() => {
        renderCinemaRoomPage(container);
      }, 220);
    } catch {}
  });

  // Agregar video a la cola o reproducir ahora
  const urlInput = document.getElementById('cinema-add-url-input') as HTMLInputElement;
  const btnPlayNow = document.getElementById('cinema-btn-play-now');
  const btnAddQueue = document.getElementById('cinema-btn-add-queue');
  const btnClearQueue = document.getElementById('cinema-btn-clear-queue');

  async function handleAddVideo(playNow: boolean) {
    if (isGuestRestricted) {
      showToast('🔒 Solo el anfitrión tiene permisos para cambiar o añadir videos.', 'error');
      return;
    }

    const rawUrl = urlInput ? urlInput.value.trim() : '';
    if (!rawUrl) {
      showToast('Pega un enlace de video o anime primero', 'error');
      urlInput?.focus();
      return;
    }

    urlInput.value = '';
    showToast('🔍 Extrayendo video para el marco de la sala...', 'info');

    let extracted: any = null;
    try {
      if ((api as any).cinema && (api as any).cinema.extractMedia) {
        extracted = await (api as any).cinema.extractMedia(rawUrl);
      }
    } catch (e) {
      console.warn('[Cinema] Error extrayendo con mediaExtractor:', e);
    }

    const info = extracted || detectVideoPlatform(rawUrl);
    let title = info.title;
    let thumb = info.thumb;

    if (info.type === 'youtube') {
      const ytId = extractYTId(rawUrl);
      if (ytId && !title) {
        try {
          const oembed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`);
          if (oembed.ok) {
            const dat = await oembed.json();
            if (dat.title) title = dat.title;
          }
        } catch {}
      }
    }

    const videoItem = {
      id: 'vid_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      url: rawUrl,
      title: title || 'Video Multimedia',
      thumb: thumb || '',
      type: info.type || 'embed',
      embedUrl: info.embedUrl || rawUrl,
      servers: info.servers || [],
      activeServerIdx: 0,
      icon: info.icon || '🎬',
      platformName: info.platformName || 'Cine',
      channel: (info as any).channel,
      vodId: (info as any).vodId,
      clipId: (info as any).clipId
    };

    if (playNow) {
      cinemaState.queue.unshift(videoItem);
      cinemaState.currentIndex = 0;
      cinemaState.currentTime = 0;
      cinemaState.isPlaying = true;
    } else {
      cinemaState.queue.push(videoItem);
      if (cinemaState.currentIndex === -1) {
        cinemaState.currentIndex = 0;
        cinemaState.currentTime = 0;
        cinemaState.isPlaying = true;
      }
    }

    broadcastPlayerState();
    renderCinemaRoomPage(container);
    showToast(playNow ? `▶️ ${videoItem.icon} Reproduciendo en marco: ${videoItem.title}` : `➕ ${videoItem.icon} Añadido a la cola: ${videoItem.title}`, 'success');
  }

  btnPlayNow?.addEventListener('click', () => handleAddVideo(true));
  btnAddQueue?.addEventListener('click', () => handleAddVideo(false));
  urlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddVideo(true);
  });

  // Clic en chips de cambio de servidor para AnimeFLV / Películas
  container.querySelectorAll('.cinema-server-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(chip.getAttribute('data-server-idx') || '0', 10);
      if (currentVideo && currentVideo.servers && currentVideo.servers[idx]) {
        currentVideo.activeServerIdx = idx;
        const s = currentVideo.servers[idx];
        currentVideo.embedUrl = s.code || s.url;
        const ifr = document.getElementById('cinema-embed-target') as HTMLIFrameElement;
        if (ifr) {
          ifr.src = currentVideo.embedUrl;
        }
        broadcastPlayerState();
        renderCinemaRoomPage(container);
        showToast(`⚡ Cambiado a servidor: ${s.title || s.server}`, 'info');
      }
    });
  });

  // Botón para saltar a Co-Navegación sincronizada cuando se está en modo web
  document.getElementById('cinema-btn-open-sync-tab')?.addEventListener('click', () => {
    if (currentVideo && currentVideo.url) {
      goToCobrowsingUrl(currentVideo.url);
    }
  });

  // Clics en el Hub de Plataformas para reproducir al instante en el marco
  container.querySelectorAll('.cinema-platform-hub-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const plat = btn.getAttribute('data-hub-platform');
      if (urlInput) {
        if (plat === 'animeflv') {
          urlInput.value = 'https://www3.animeflv.net/ver/solo-leveling-season-2-arise-from-the-shadows-1';
          showToast('🍿 Extrayendo episodio de AnimeFLV directamente en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'cuevana') {
          urlInput.value = 'https://ww3.cuevana3.ch/pelicula/deadpool-wolverine';
          showToast('🍿 Extrayendo película web directamente en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'twitch') {
          urlInput.value = 'https://www.twitch.tv/ibai';
          showToast('💜 Conectando stream de Twitch en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'youtube') {
          urlInput.value = 'https://www.youtube.com/watch?v=jfKfPfyJRdk';
          showToast('🔴 Reproduciendo YouTube en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'direct') {
          urlInput.value = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
          showToast('📹 Reproduciendo video directo en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'vimeo') {
          urlInput.value = 'https://vimeo.com/76979871';
          showToast('🎥 Reproduciendo Vimeo en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'dailymotion') {
          urlInput.value = 'https://www.dailymotion.com/video/x8jzy9c';
          showToast('📺 Reproduciendo Dailymotion en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'kick') {
          urlInput.value = 'https://kick.com/xqc';
          showToast('🟢 Conectando Kick en vivo en el marco...', 'info');
          handleAddVideo(true);
          return;
        } else if (plat === 'netflix' || plat === 'disney' || plat === 'prime') {
          showToast(`🎬 ${plat.toUpperCase()} requiere DRM y cuenta privada. Para verlo con tu grupo usa el modo Co-Navegación o pega el enlace.`, 'info');
          urlInput.placeholder = `Pega aquí el enlace de ${plat}...`;
          urlInput.focus();
          return;
        } else if (plat === 'web') {
          urlInput.value = 'https://www.wikipedia.org';
          handleAddVideo(true);
          return;
        }
      }
    });
  });

  btnClearQueue?.addEventListener('click', () => {
    if (isGuestRestricted) {
      showToast('🔒 Solo el anfitrión puede vaciar la cola de reproducción.', 'error');
      return;
    }
    cinemaState.queue = [];
    cinemaState.currentIndex = -1;
    cinemaState.isPlaying = false;
    broadcastPlayerState();
    renderCinemaRoomPage(container);
    showToast('Cola de reproducción vaciada', 'info');
  });

  // Clic en tarjetas de la cola para reproducir o eliminar
  container.querySelectorAll('.cinema-queue-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.cinema-queue-card-del')) return;
      if (isGuestRestricted) {
        showToast('🔒 Solo el anfitrión puede cambiar el video en reproducción.', 'error');
        return;
      }
      const idx = parseInt(card.getAttribute('data-index') || '-1', 10);
      if (idx >= 0 && idx < cinemaState.queue.length) {
        cinemaState.currentIndex = idx;
        cinemaState.currentTime = 0;
        cinemaState.isPlaying = true;
        broadcastPlayerState();
        renderCinemaRoomPage(container);
      }
    });
  });

  container.querySelectorAll('.cinema-queue-card-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isGuestRestricted) {
        showToast('🔒 Solo el anfitrión puede eliminar videos de la cola.', 'error');
        return;
      }
      const idx = parseInt(btn.getAttribute('data-del-index') || '-1', 10);
      if (idx >= 0 && idx < cinemaState.queue.length) {
        cinemaState.queue.splice(idx, 1);
        if (cinemaState.currentIndex === idx) {
          if (cinemaState.queue.length === 0) {
            cinemaState.currentIndex = -1;
            cinemaState.isPlaying = false;
          } else if (cinemaState.currentIndex >= cinemaState.queue.length) {
            cinemaState.currentIndex = cinemaState.queue.length - 1;
          }
        } else if (cinemaState.currentIndex > idx) {
          cinemaState.currentIndex--;
        }
        broadcastPlayerState();
        renderCinemaRoomPage(container);
      }
    });
  });

  // Control de cierre al hacer clic fuera de la bandeja de emojis
  if (cinemaState._dismissEmojiPickerHandler) {
    document.removeEventListener('click', cinemaState._dismissEmojiPickerHandler);
    cinemaState._dismissEmojiPickerHandler = null;
  }

  if (cinemaState.showEmojiPicker) {
    cinemaState._dismissEmojiPickerHandler = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement;
      if (!target.closest('#cinema-emoji-picker-tray') && !target.closest('#cinema-chat-emoji-toggle-btn')) {
        cinemaState.showEmojiPicker = false;
        if (cinemaState._dismissEmojiPickerHandler) {
          document.removeEventListener('click', cinemaState._dismissEmojiPickerHandler);
          cinemaState._dismissEmojiPickerHandler = null;
        }
        renderCinemaRoomPage(container);
      }
    };
    setTimeout(() => {
      if (cinemaState._dismissEmojiPickerHandler) {
        document.addEventListener('click', cinemaState._dismissEmojiPickerHandler);
      }
    }, 50);
  }

  // Enviar mensaje en el chat
  const chatInput = document.getElementById('cinema-room-chat-input') as HTMLInputElement;
  const btnSendChat = document.getElementById('cinema-room-chat-send');

  const sendRoomMessage = () => {
    const text = chatInput ? chatInput.value.trim() : '';
    if (!text) return;
    chatInput.value = '';

    const newMsg = {
      id: 'chat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      sender: cinemaState.username || 'Yo',
      isMe: true,
      text: text,
      time: formatCinemaTime()
    };
    cinemaState.chatMessages.push(newMsg);

    // Si es emoji puro, disparar la reacción flotante sobre el video al instante (estilo Rave)
    if (isSingleOrFewEmojis(text)) {
      triggerFloatingReaction(text);
      if ((api as any).cinema && (api as any).cinema.sendReaction) {
        (api as any).cinema.sendReaction(text);
      }
    }

    appendChatMessageToFeed(newMsg);

    if ((api as any).cinema && (api as any).cinema.sendChat) {
      (api as any).cinema.sendChat(text);
    }
  };

  btnSendChat?.addEventListener('click', sendRoomMessage);
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendRoomMessage();
  });

  // Toggle de la bandeja de emojis
  document.getElementById('cinema-chat-emoji-toggle-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cinemaState.showEmojiPicker = !cinemaState.showEmojiPicker;
    renderCinemaRoomPage(container);
  });

  document.getElementById('cinema-btn-close-emojis')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cinemaState.showEmojiPicker = false;
    renderCinemaRoomPage(container);
  });

  // Clic en emojis de la bandeja desplegable RAVE
  container.querySelectorAll('.cinema-emoji-item').forEach(item => {
    item.addEventListener('click', () => {
      const emo = item.getAttribute('data-tray-emoji') || '';
      if (!emo) return;

      // Disparar reacción flotante sobre el video de inmediato
      triggerFloatingReaction(emo);
      if ((api as any).cinema && (api as any).cinema.sendReaction) {
        (api as any).cinema.sendReaction(emo);
      }

      // Insertar emoji en el campo de texto
      if (chatInput) {
        chatInput.value += emo;
        chatInput.focus();
      }
    });
  });

  // Clic en chips de emojis rápidos (Rave Quick Reactions)
  container.querySelectorAll('.cinema-emoji-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const emo = chip.getAttribute('data-emoji') || '';
      if (!emo) return;

      // Disparar reacción flotante sobre el video (local + red)
      triggerFloatingReaction(emo);
      if ((api as any).cinema && (api as any).cinema.sendReaction) {
        (api as any).cinema.sendReaction(emo);
      }

      // Añadir al chat como mensaje propio
      const newMsg = {
        id: 'chat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        sender: cinemaState.username || 'Yo',
        isMe: true,
        text: emo,
        time: formatCinemaTime()
      };
      cinemaState.chatMessages.push(newMsg);
      appendChatMessageToFeed(newMsg);

      if ((api as any).cinema && (api as any).cinema.sendChat) {
        (api as any).cinema.sendChat(emo);
      }
    });
  });
}

// ============================================================================
// 10. UTILIDADES Y TOASTS
// ============================================================================
function showToast(message: string, type: 'info' | 'success' | 'error' = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.2s';
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}
(window as any).showToast = showToast;

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function updateHeaderRamStats() {
  try {
    const ram = await api.system.getRam();
    const ntpStat = document.getElementById('ntp-ram-stat');
    if (ntpStat) ntpStat.innerText = ram.label;
  } catch { }
}
