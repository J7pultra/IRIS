(function() {
  'use strict';
  if (window.__OJO_DE_HALCON_INJECTED__) return;
  window.__OJO_DE_HALCON_INJECTED__ = true;

  console.log('[Ojo de Halcón] Módulo inyectado en página web activo ✓');

  const isWhatsApp = window.location.hostname.includes('whatsapp.com') || window.location.href.includes('whatsapp.com');
  const isInstagram = window.location.hostname.includes('instagram.com') || window.location.href.includes('instagram.com');
  if (!isWhatsApp && !isInstagram) return;

  const RESCUED_STORE_KEY = '__OJO_DE_HALCON_RESCUED_STORE_V4__';
  const rescuedStore = new Map();
  const liveCache = new Map();
  let lastRemovedMessage = null;
  let lastRemovedTime = 0;
  const capturedStatusHashes = new Set();

  const lastOutgoingMessages = [];
  const lastOutgoingByChat = new Map();
  let pendingComposerText = '';
  let pendingComposerTime = 0;
  let pendingComposerChat = '';

  function loadRescuedStore() {
    try {
      // Purgar versiones antiguas acumuladas para empezar 100% limpio
      const oldKeys = [
        '__OJO_DE_HALCON_RESCUED_STORE_V1__',
        '__OJO_DE_HALCON_RESCUED_STORE_V2__',
        '__OJO_DE_HALCON_RESCUED_STORE_V3__',
        'phantom_rescued_v1',
        'phantom_rescued_v2',
        'phantom_rescued_v3'
      ];
      oldKeys.forEach(k => {
        try { localStorage.removeItem(k); } catch (e) {}
      });

      const raw = localStorage.getItem(RESCUED_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach(item => {
            if (item && (item.id || item.coreId)) {
              const sid = extractStanzaId(item.id || item.coreId);
              const ns = normalizeStanza(sid);
              if (sid) rescuedStore.set(sid, item);
              if (ns) rescuedStore.set(ns, item);
              if (item.cleanId) rescuedStore.set(item.cleanId, item);
              if (item.id) rescuedStore.set(item.id, item);
              if (item.coreId) rescuedStore.set(item.coreId, item);
            }
          });
        }
      }
    } catch (e) {}
  }

  function saveToRescuedStore(msg) {
    if (!msg) return;
    try {
      const sid = extractStanzaId(msg.id || msg.coreId);
      const ns = normalizeStanza(sid);
      if (sid) rescuedStore.set(sid, msg);
      if (ns) rescuedStore.set(ns, msg);
      if (msg.cleanId) rescuedStore.set(msg.cleanId, msg);
      if (msg.id) rescuedStore.set(msg.id, msg);
      if (msg.coreId) rescuedStore.set(msg.coreId, msg);

      const unique = [];
      const seen = new Set();
      for (const item of rescuedStore.values()) {
        const key = item.coreId || item.id || item.cleanId;
        if (key && !seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      }
      const trimmed = unique.slice(-300);
      localStorage.setItem(RESCUED_STORE_KEY, JSON.stringify(trimmed));
    } catch (e) {}
  }

  // Interceptar texto enviado por el propio usuario en el compositor
  document.addEventListener('keydown', (e) => {
    try {
      if (e.key === 'Enter' && !e.shiftKey) {
        const composer = document.querySelector(
          '#main footer div[contenteditable="true"], footer div[contenteditable="true"], [data-testid="conversation-compose-box-input"], div[data-tab="10"]'
        );
        if (composer && composer.textContent) {
          const t = cleanWaText(composer.textContent);
          if (t.length > 0 && !isGarbageMessageText(t)) {
            pendingComposerText = t;
            pendingComposerTime = Date.now();
            pendingComposerChat = updateActiveChat();
          }
        }
      }
    } catch (err) {}
  }, true);

  document.addEventListener('click', (e) => {
    try {
      const target = e.target;
      if (!target) return;
      const sendBtn = target.closest(
        'button[aria-label*="Enviar"], button[data-testid="compose-btn-send"], span[data-icon="send"], button span[data-icon="send"]'
      );
      if (sendBtn) {
        const composer = document.querySelector(
          '#main footer div[contenteditable="true"], footer div[contenteditable="true"], [data-testid="conversation-compose-box-input"], div[data-tab="10"]'
        );
        if (composer && composer.textContent) {
          const t = cleanWaText(composer.textContent);
          if (t.length > 0 && !isGarbageMessageText(t)) {
            pendingComposerText = t;
            pendingComposerTime = Date.now();
            pendingComposerChat = updateActiveChat();
          }
        }
      }

      // Al hacer clic en un chat lateral, programar barrido inmediato de restauración
      const chatItem = target.closest(
        '#pane-side div[role="listitem"], #pane-side div[role="row"], #pane-side div[tabindex]'
      );
      if (chatItem) {
        setTimeout(() => {
          updateActiveChat();
          loadRescuedStore();
          document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(el => {
            const c = getMessageContainer(el);
            if (c) checkForDeletion(c);
          });
        }, 100);
        setTimeout(() => {
          updateActiveChat();
          document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(el => {
            const c = getMessageContainer(el);
            if (c) checkForDeletion(c);
          });
        }, 300);
        setTimeout(() => {
          updateActiveChat();
          document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(el => {
            const c = getMessageContainer(el);
            if (c) checkForDeletion(c);
          });
        }, 750);
      }
    } catch (err) {}
  }, true);

  let lastClickedStatusContact = null;
  let lastClickedStatusTime = 0;

  // Seguimiento del contacto clickeado en la lista lateral de estados
  document.addEventListener('click', (e) => {
    try {
      const target = e.target;
      if (!target) return;
      const item = target.closest('div[role="listitem"], div[role="button"], div._ak8l, div._ak8m, div[tabindex]');
      if (item) {
        const titleEl = item.querySelector('span[title], span[dir="auto"], span._ao3e, div[title]');
        const title = cleanWaText(titleEl?.getAttribute('title') || titleEl?.textContent);
        if (title && !isInvalidSenderName(title)) {
          lastClickedStatusContact = title;
          lastClickedStatusTime = Date.now();
        }
      }
    } catch (err) {}
  }, true);

  let activeChatName = '';
  function getActiveChatName() {
    const chatHeader = document.querySelector(
      '#main header span[dir="auto"], header span[dir="auto"], [data-testid="conversation-info-header"] span[dir="auto"], #main header h2'
    );
    return chatHeader ? cleanWaText(chatHeader.textContent) : 'WhatsApp Web';
  }

  function updateActiveChat() {
    const current = getActiveChatName();
    if (current && current !== activeChatName && current !== 'WhatsApp Web') {
      activeChatName = current;
      // Al cambiar de conversación, invalidar lastRemovedMessage para no contaminar
      lastRemovedMessage = null;
      lastRemovedTime = 0;
    }
    return activeChatName || current;
  }

  function normalizeStanza(s) {
    if (!s) return '';
    return String(s)
      .replace(/^temp[-_]?/i, '')
      .replace(/_(recalled|revoked|deleted)$/i, '')
      .trim();
  }

  function extractStanzaId(rawId) {
    if (!rawId) return null;
    let clean = rawId.replace(/_(recalled|revoked|deleted)$/i, '');
    clean = clean.replace(/_TEMP[-_]/i, '_');
    const parts = clean.split('_');
    const stanza = parts.find(p => p.length >= 8 && !p.includes('@') && p !== 'true' && p !== 'false' && p !== 'owner');
    if (stanza) return normalizeStanza(stanza);
    return normalizeStanza(parts.length > 1 ? parts[parts.length - 1] : clean);
  }

  function getCoreId(rawId) {
    return extractStanzaId(rawId);
  }

  function getMessageContainer(node) {
    if (!node) return null;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
      if (!node) return null;
    }
    const bubble = node.closest ? node.closest('.message-in, .message-out') : null;
    if (bubble) return bubble;
    const row = node.closest ? node.closest('[data-id]') : null;
    if (row) return row;
    if (node.matches && node.matches('.message-in, .message-out, [data-id]')) return node;
    return null;
  }

  function getMessageFullId(el, container) {
    const list = [container, el];
    for (const c of list) {
      if (!c) continue;
      if (c.getAttribute && c.getAttribute('data-id')) {
        return c.getAttribute('data-id');
      }
      if (c.closest) {
        const row = c.closest('[data-id]');
        if (row && row.getAttribute && row.getAttribute('data-id')) {
          return row.getAttribute('data-id');
        }
      }
      if (c.querySelector) {
        const child = c.querySelector('[data-id]');
        if (child && child.getAttribute && child.getAttribute('data-id')) {
          return child.getAttribute('data-id');
        }
      }
    }
    return null;
  }

  function isMsgOutgoing(container, rawId) {
    if (!container) return false;
    if (container.classList && container.classList.contains('message-out')) return true;
    if (container.classList && container.classList.contains('message-in')) return false;
    const effId = rawId || getMessageFullId(container);
    if (effId && (effId.startsWith('true_') || effId.includes('_true_'))) return true;
    if (effId && (effId.startsWith('false_') || effId.includes('_false_'))) return false;
    if (container.querySelector && (container.querySelector('[data-icon="tail-out"], .tail-out') || container.querySelector('[data-testid="tail-out"]'))) return true;
    if (container.querySelector && (container.querySelector('[data-icon="tail-in"], .tail-in') || container.querySelector('[data-testid="tail-in"]'))) return false;
    const textContent = (container.textContent || '').toLowerCase();
    if (textContent.includes('eliminaste este mensaje') || textContent.includes('you deleted this message') || textContent.includes('você apagou esta mensagem')) {
      return true;
    }
    return false;
  }

  function extractSenderName(msgNode) {
    const rawId = getMessageFullId(msgNode);
    if (isMsgOutgoing(msgNode, rawId)) {
      return 'Tú';
    }
    const prePlain = msgNode.querySelector ? msgNode.querySelector('div[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') : null;
    if (prePlain) {
      const match = prePlain.match(/\]\s*([^:]+):/);
      if (match && match[1]) return cleanWaText(match[1]);
    }
    const authorSpan = msgNode.querySelector ? msgNode.querySelector('span[dir="auto"]._ah-q, span._ah-q, [data-testid="author"], .copyable-text [dir="auto"]') : null;
    if (authorSpan && authorSpan.textContent && authorSpan.textContent.trim().length > 0) {
      return cleanWaText(authorSpan.textContent);
    }
    return updateActiveChat();
  }

  async function captureMedia(mediaEl) {
    const src = mediaEl.currentSrc || mediaEl.src;

    if (mediaEl.tagName === 'IMG') {
      const img = mediaEl;
      if (img.complete && (img.naturalWidth > 0 || img.clientWidth > 0)) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.clientWidth;
          canvas.height = img.naturalHeight || img.clientHeight;
          const ctx = canvas.getContext('2d');
          if (ctx && canvas.width > 20 && canvas.height > 20) {
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            if (dataUrl && dataUrl.length > 200) return { type: 'image', dataUrl };
          }
        } catch (e) {}
      }
    }

    if (mediaEl.tagName === 'VIDEO') {
      const vid = mediaEl;
      // 1. Intentar descargar el stream real
      if (src && !src.includes('mediasource')) {
        try {
          const response = await fetch(src);
          if (response.ok) {
            const blob = await response.blob();
            if (blob.size > 2000 && blob.type.startsWith('video/')) {
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => reject(null);
                reader.readAsDataURL(blob);
              });
              if (dataUrl && dataUrl.startsWith('data:video/')) return { type: 'video', dataUrl };
            }
          }
        } catch (e) {}
      }

      // 2. Si no es accesible el video completo, capturar fotograma nítido
      if (vid.readyState >= 1 && (vid.videoWidth > 60 || vid.clientWidth > 60)) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = vid.videoWidth || vid.clientWidth || 720;
          canvas.height = vid.videoHeight || vid.clientHeight || 1280;
          const ctx = canvas.getContext('2d');
          if (ctx && canvas.width > 50 && canvas.height > 50) {
            ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            if (dataUrl && dataUrl.length > 500) return { type: 'image', dataUrl };
          }
        } catch (e) {}
      }
    }

    if (src && !src.includes('mediasource')) {
      try {
        const response = await fetch(src);
        if (response.ok) {
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(null);
            reader.readAsDataURL(blob);
          });

          let type = 'image';
          if (mediaEl.tagName === 'VIDEO' || blob.type.startsWith('video/')) type = 'video';
          else if (mediaEl.tagName === 'AUDIO' || blob.type.startsWith('audio/')) type = 'audio';

          return { type, dataUrl };
        }
      } catch (e) {}
    }

    return null;
  }

  function renderTextStatusCard(text, bgColor) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';

      ctx.fillStyle = bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' ? bgColor : '#128c7e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.15)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const fontSize = text.length > 100 ? 36 : text.length > 50 ? 44 : 52;
      ctx.font = `600 ${fontSize}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

      const words = text.split(/\s+/);
      const lines = [];
      let currentLine = '';
      const maxWidth = 580;

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) lines.push(currentLine);

      const lineHeight = fontSize * 1.35;
      const totalTextHeight = lines.length * lineHeight;
      const startY = (canvas.height - totalTextHeight) / 2 + (lineHeight / 2);

      lines.forEach((line, i) => {
        ctx.fillText(line, canvas.width / 2, startY + (i * lineHeight));
      });

      return canvas.toDataURL('image/jpeg', 0.92);
    } catch (e) {
      return '';
    }
  }

  function stripTrailingTimestamp(str) {
    if (!str) return '';
    let s = str.trim();
    // Remover timestamp pegado al final e.g. "Hola12:07 a.m." -> "Hola" o "Hola 12:07 a.m." -> "Hola"
    s = s.replace(/(?:^|\b|\s|[a-zA-Z\u00C0-\u017F\.,!?])(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm))?)$/i, (match, ts) => {
      return match.slice(0, match.length - ts.length).trim();
    });
    // Si toda la cadena es solamente una hora, retornar vacío
    if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm))?$/i.test(s)) {
      return '';
    }
    return s.trim();
  }

  function isGarbageMessageText(text) {
    if (!text) return true;
    const t = text.trim();
    if (t.length < 1) return true;
    if (/ic-search|ic-more-vert|ic-attach|ic-mic|Escribe un mensaje|wds-ic-sticker/i.test(t)) return true;
    if (/tail-in|tail-out|recalled/i.test(t)) return true;
    if (/Usa WhatsApp en tu teléfono para ver mensajes anteriores/i.test(t)) return true;
    if (/^(?:este\s+mensaje\s+fue\s+eliminado|se\s+elimin[oó]\s+este\s+mensaje|this\s+message\s+was\s+deleted|you\s+deleted\s+this\s+message)\.?$/i.test(t)) return true;
    return false;
  }

  function extractCleanMessageText(container) {
    if (!container) return null;

    const candidates = container.querySelectorAll('span.selectable-text, span._ao3e, .copyable-text span[dir]');
    let bestText = '';

    for (const el of Array.from(candidates)) {
      // Ignorar contenido citado de otro mensaje
      if (el.closest('[data-testid="quoted-message"], .quoted-mention, [data-icon="quote"]')) continue;

      const clone = el.cloneNode(true);
      clone.querySelectorAll('[data-testid="msg-meta"], [data-icon], time, span.x1rg5ohu').forEach(meta => {
        if (/^\s*\d{1,2}:\d{2}/.test(meta.textContent || '') || meta.closest('[data-testid="msg-meta"]')) {
          meta.remove();
        }
      });

      let raw = cleanWaText(clone.textContent);
      raw = stripTrailingTimestamp(raw);

      if (raw.length > 0 && !isDeletionText(raw) && !isGarbageMessageText(raw)) {
        if (raw.length > bestText.length) {
          bestText = raw;
        }
      }
    }

    if (!bestText) {
      const textEl = container.querySelector('.selectable-text, span._ao3e, div[dir="ltr"], div[dir="rtl"]');
      if (textEl && !textEl.closest('[data-testid="quoted-message"]')) {
        const clone = textEl.cloneNode(true);
        clone.querySelectorAll('[data-testid="msg-meta"], [data-icon], time, span.x1rg5ohu').forEach(m => m.remove());
        let raw = cleanWaText(clone.textContent);
        raw = stripTrailingTimestamp(raw);
        if (raw.length > 0 && !isDeletionText(raw) && !isGarbageMessageText(raw)) {
          bestText = raw;
        }
      }
    }

    return bestText || null;
  }

  async function cacheMessageNode(node) {
    const mainChat = node.closest ? node.closest('#main, [data-testid="conversation-panel-wrapper"], [data-testid="conversation-panel-messages"]') : null;
    if (!mainChat) return;

    const container = getMessageContainer(node);
    if (!container) return;

    if (container.getAttribute('data-phantom-restored') === 'true') return;

    // Si ya es un mensaje eliminado, NO cachearlo como mensaje vivo ni asociarle texto del compositor
    const textContent = (container.textContent || '').trim();
    const hasRecallIcon = container.querySelector(
      'span[data-icon="recalled"], span[data-icon="block"], span[data-icon="msg-deleted"], [data-testid="recalled"], [data-testid="msg-recalled"], span[data-icon*="recalled"], span[data-icon*="delete"]'
    );
    if (hasRecallIcon || isDeletionText(textContent)) {
      return;
    }

    const rawId = getMessageFullId(node, container);
    const stanzaId = extractStanzaId(rawId);
    const normStanza = normalizeStanza(stanzaId);
    const cleanId = rawId ? rawId.replace(/_(recalled|revoked|deleted)$/i, '') : null;
    const normClean = normalizeStanza(cleanId);
    if (!stanzaId && !cleanId && !rawId) return;

    const isOut = isMsgOutgoing(container, rawId);
    const currentChat = updateActiveChat();

    let entry = (stanzaId && liveCache.get(stanzaId)) ||
      (normStanza && liveCache.get(normStanza)) ||
      (cleanId && liveCache.get(cleanId)) ||
      (normClean && liveCache.get(normClean)) ||
      (stanzaId && rescuedStore.get(stanzaId)) ||
      (normStanza && rescuedStore.get(normStanza)) ||
      {
        id: rawId || stanzaId || cleanId || ('wa_' + Date.now()),
        coreId: stanzaId || cleanId || ('wa_' + Date.now()),
        cleanId: cleanId || undefined,
        text: null,
        media: null,
        sender: isOut ? 'Tú' : extractSenderName(container),
        chatName: currentChat,
        isOutgoing: isOut,
        timestamp: Date.now()
      };

    if (!entry.text) {
      const extracted = extractCleanMessageText(container);
      if (extracted) {
        entry.text = extracted;
      } else if (isOut && pendingComposerText && (Date.now() - pendingComposerTime < 5000)) {
        entry.text = pendingComposerText;
        pendingComposerText = ''; // Evitar que se reutilice en otros mensajes
      }
    }

    if (!entry.media) {
      const img = container.querySelector('img[src], img[src^="blob:"], img[src*="whatsapp.net"]');
      const vid = container.querySelector('video');
      const aud = container.querySelector('audio');

      const validImg = img && !img.closest('[data-icon]') && !img.classList.contains('emoji') && (img.naturalWidth > 60 || img.clientWidth > 60 || (img.getAttribute('src') || '').includes('blob:')) ? img : null;
      const mediaTarget = validImg || vid || aud;
      if (mediaTarget) {
        const captured = await captureMedia(mediaTarget);
        if (captured) {
          entry.media = captured;
        }
      }
    }

    if (entry.text || entry.media) {
      if (stanzaId) liveCache.set(stanzaId, entry);
      if (normStanza) liveCache.set(normStanza, entry);
      if (cleanId) liveCache.set(cleanId, entry);
      if (normClean) liveCache.set(normClean, entry);
      if (entry.id) liveCache.set(entry.id, entry);

      saveToRescuedStore(entry);

      if (isOut) {
        lastOutgoingMessages.unshift(entry);
        if (lastOutgoingMessages.length > 30) lastOutgoingMessages.pop();

        const chatOut = lastOutgoingByChat.get(currentChat) || [];
        if (!chatOut.some(m => m.id === entry.id || m.coreId === entry.coreId || (m.text && m.text === entry.text && Math.abs(m.timestamp - entry.timestamp) < 3000))) {
          chatOut.unshift(entry);
          if (chatOut.length > 20) chatOut.pop();
          lastOutgoingByChat.set(currentChat, chatOut);
        }
      }
    }
  }

  function isDeletionText(text) {
    if (!text) return false;
    return /(?:este\s+mensaje\s+fue\s+eliminado|se\s+elimin[oó]\s+este\s+mensaje|eliminaste\s+este\s+mensaje|se\s+ha\s+eliminado\s+este\s+mensaje|this\s+message\s+was\s+deleted|you\s+deleted\s+this\s+message|mensagem\s+apagada|foi\s+apagada|apagou\s+esta\s+mensagem|você\s+apagou\s+esta\s+mensagem|anul[oó]\s+el\s+env[ií]o|cancel[oó]\s+el\s+env[ií]o|unsent\s+a\s+message|mensaje\s+eliminado)/i.test(text);
  }

  function restoreMessageInDom(container, data) {
    if (!container) return;
    if (container.getAttribute('data-phantom-restored') === 'true') return;
    container.setAttribute('data-phantom-restored', 'true');

    // Guardar en rescuedStore para que NUNCA desaparezca al cambiar de chat
    saveToRescuedStore(data);

    const fullId = getMessageFullId(container);
    const isOutgoing = (data && data.isOutgoing !== undefined)
      ? data.isOutgoing
      : isMsgOutgoing(container, fullId);

    const cleanText = stripTrailingTimestamp(data.text);
    const timeStr = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const card = document.createElement('div');
    card.className = `phantom-rescued-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
    card.style.cssText = `
      box-sizing: border-box !important;
      display: inline-flex !important;
      flex-direction: column !important;
      max-width: 95% !important;
      min-width: 160px !important;
      width: fit-content !important;
      margin: 2px 0 !important;
      padding: 8px 12px !important;
      background: ${isOutgoing ? '#005c4b' : '#202c33'} !important;
      border: 1px solid ${isOutgoing ? 'rgba(37, 211, 102, 0.45)' : 'rgba(0, 168, 132, 0.45)'} !important;
      border-${isOutgoing ? 'right' : 'left'}: 3.5px solid ${isOutgoing ? '#25d366' : '#00a884'} !important;
      border-radius: 9px !important;
      border-bottom-${isOutgoing ? 'right' : 'left'}-radius: 2px !important;
      color: #e9edef !important;
      font-family: inherit !important;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35) !important;
      ${isOutgoing ? 'margin-left: auto !important; margin-right: 0 !important;' : 'margin-right: auto !important; margin-left: 0 !important;'}
    `;

    let html = `
      <div style="font-size: 10px; font-weight: 700; color: ${isOutgoing ? '#25d366' : '#00a884'}; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 3px; letter-spacing: 0.3px;">
        <span style="display: flex; align-items: center; gap: 4px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          MENSAJE RESCATADO ${!isOutgoing && data.sender && data.sender !== 'Tú' ? `• ${escapeHtml(data.sender)}` : ''}
        </span>
        <span style="font-size: 8.5px; padding: 1px 5px; background: ${isOutgoing ? 'rgba(37, 211, 102, 0.22)' : 'rgba(0, 168, 132, 0.18)'}; border-radius: 3px; color: ${isOutgoing ? '#25d366' : '#00a884'}; font-weight: 800;">
          ${isOutgoing ? 'ELIMINADO POR TI' : 'PRESERVADO'}
        </span>
      </div>
    `;

    if (cleanText) {
      html += `<div style="font-size: 14.5px; line-height: 19px; color: #e9edef; word-break: break-word; user-select: text; margin: 3px 0 2px 0;">${escapeHtml(cleanText)}</div>`;
    }

    if (data.media && data.media.dataUrl) {
      if (data.media.type === 'video') {
        html += `<video src="${data.media.dataUrl}" controls style="width: 100%; max-width: 320px; border-radius: 6px; margin: 6px 0; display: block;"></video>`;
      } else if (data.media.type === 'audio') {
        html += `<audio src="${data.media.dataUrl}" controls style="width: 100%; max-width: 300px; margin: 6px 0; display: block;"></audio>`;
      } else {
        html += `<img src="${data.media.dataUrl}" style="max-width: 300px; max-height: 300px; border-radius: 6px; margin: 6px 0; display: block; object-fit: contain; cursor: pointer;" onclick="window.open('${data.media.dataUrl}', '_blank')"/>`;
      }

      const ext = data.media.type === 'video' ? 'mp4' : (data.media.type === 'audio' ? 'ogg' : 'png');
      html += `
        <div style="display: flex; justify-content: flex-end; margin-top: 4px;">
          <a href="${data.media.dataUrl}" download="OjoDeHalcon_${Date.now()}.${ext}" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: #00a884; color: #fff; font-size: 11px; font-weight: 600; text-decoration: none; border-radius: 4px; cursor: pointer;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Guardar Archivo
          </a>
        </div>
      `;
    }

    html += `
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; font-size: 11px; color: #8696a0; margin-top: 2px;">
        <span>${timeStr}</span>
        <span style="color: #53bdeb; font-size: 12px; line-height: 1;">✓✓</span>
      </div>
    `;

    card.innerHTML = html;

    try {
      if (isOutgoing) {
        container.classList.add('message-out');
        container.classList.remove('message-in');
        container.style.justifyContent = 'flex-end';
      } else {
        container.classList.add('message-in');
        container.classList.remove('message-out');
        container.style.justifyContent = 'flex-start';
      }
    } catch (e) {}

    // Encontrar el contenedor visual de la burbuja (div._amk4, etc.)
    let bubble = container.querySelector('div[class*="_amk"], div[class*="_akb"], div[tabindex="-1"]');
    if (!bubble) {
      bubble = container.firstElementChild || container;
    }

    // Ocultar todos los elementos y textos antiguos dentro de la burbuja y el contenedor
    container.querySelectorAll('span, [data-icon], time, .copyable-text, [data-testid="msg-meta"]').forEach(el => {
      if (!el.closest('.phantom-rescued-bubble')) {
        el.style.display = 'none';
      }
    });

    Array.from(bubble.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = '';
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('phantom-rescued-bubble')) {
        node.style.display = 'none';
      }
    });

    try {
      bubble.style.background = 'transparent';
      bubble.style.boxShadow = 'none';
      bubble.style.border = 'none';
      bubble.style.padding = '0';
      bubble.style.display = 'flex';
      bubble.style.flexDirection = 'column';
      bubble.style.alignItems = isOutgoing ? 'flex-end' : 'flex-start';
      bubble.style.width = '100%';
    } catch (e) {}

    const existingCard = bubble.querySelector('.phantom-rescued-bubble');
    if (existingCard) {
      existingCard.replaceWith(card);
    } else {
      bubble.appendChild(card);
    }

    if (cleanText || data.media) {
      try {
        window.postMessage({
          type: 'PHANTOM_MESSAGE_CAPTURED',
          data: {
            id: data.coreId || data.cleanId || ('wa_' + Date.now()),
            platform: isWhatsApp ? 'whatsapp' : 'instagram',
            sender: data.sender || (isOutgoing ? 'Tú' : 'Remitente'),
            chatName: data.chatName || updateActiveChat(),
            text: cleanText || '(Multimedia)',
            mediaType: data.media ? data.media.type : undefined,
            mediaData: data.media ? data.media.dataUrl : undefined,
            timestamp: data.timestamp || Date.now(),
            isDeleted: true,
            isOutgoing: !!isOutgoing,
            deletedAt: Date.now()
          }
        }, '*');
      } catch (e) {}
    }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function checkForDeletion(node) {
    if (!node) return;
    if (node.getAttribute && node.getAttribute('data-phantom-restored') === 'true') return;

    // Solo procesar dentro de la conversación actual (#main)
    const mainChat = node.closest ? node.closest('#main, [data-testid="conversation-panel-wrapper"], [data-testid="conversation-panel-messages"]') : null;
    if (!mainChat) return;

    const container = getMessageContainer(node);
    if (!container) return;
    if (container.getAttribute && container.getAttribute('data-phantom-restored') === 'true') return;

    const fullId = getMessageFullId(node, container);
    const stanzaId = extractStanzaId(fullId);
    const normStanza = normalizeStanza(stanzaId);
    const cleanId = fullId ? fullId.replace(/_(recalled|revoked|deleted)$/i, '') : null;
    const normClean = normalizeStanza(cleanId);
    const currentChat = updateActiveChat();
    const isOut = isMsgOutgoing(container, fullId);

    const hasIcon = container.querySelector(
      'span[data-icon="recalled"], span[data-icon="block"], span[data-icon="msg-deleted"], [data-testid="recalled"], [data-testid="msg-recalled"], span[data-icon*="recalled"], span[data-icon*="delete"]'
    );
    const textContent = (container.textContent || '').trim();
    const hasText = isDeletionText(textContent);

    if (hasIcon || hasText) {
      let dataToRender = null;
      const checkKeys = [stanzaId, normStanza, cleanId, normClean, fullId].filter(Boolean);

      // 1. Búsqueda en el almacén persistente (rescuedStore)
      for (const k of checkKeys) {
        if (rescuedStore.has(k)) {
          dataToRender = rescuedStore.get(k);
          break;
        }
      }

      // 2. Búsqueda en liveCache de la sesión
      if (!dataToRender) {
        for (const k of checkKeys) {
          if (liveCache.has(k)) {
            dataToRender = liveCache.get(k);
            break;
          }
        }
      }

      // 3. Si no se encontró por ID exacto, buscar si fue un mensaje removido recientemente en este chat
      if (!dataToRender && lastRemovedMessage && (Date.now() - lastRemovedTime < 8000)) {
        if (lastRemovedMessage.chatName === currentChat || currentChat === 'WhatsApp Web') {
          dataToRender = lastRemovedMessage;
        }
      }

      // ¡IMPORTANTE! NUNCA asignar recentOut[0] a ciegas. Si un mensaje no está en el almacén de rescatados,
      // NO debemos tomar un mensaje vivo que no ha sido borrado para reemplazarlo.

      // 4. Si encontramos los datos, restaurar inmediatamente
      if (dataToRender && (dataToRender.text || dataToRender.media)) {
        if (isGarbageMessageText(dataToRender.text)) {
          dataToRender.text = null;
        }
        if (dataToRender.text || dataToRender.media) {
          if (isOut) dataToRender.isOutgoing = true;
          restoreMessageInDom(container, dataToRender);
          return;
        }
      }

      // 5. Si aún no tenemos los datos:
      // Reintentar hasta 8 veces para dar tiempo a sincronizar mutaciones
      const retries = parseInt(container.getAttribute('data-phantom-check-retries') || '0', 10);
      if (retries < 8) {
        container.setAttribute('data-phantom-check-retries', (retries + 1).toString());
      } else {
        container.setAttribute('data-phantom-restored', 'true');
      }
    }
  }

  function cleanWaText(str) {
    if (!str) return '';
    return String(str)
      .replace(/[\u2000-\u206F\uFEFF\u00A0\u180E\u200B-\u200D\u2060]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isInvalidSenderName(name) {
    if (!name) return true;
    const clean = cleanWaText(name);
    if (clean.length < 2) return true;
    const lower = clean.toLowerCase();

    const forbidden = [
      'estado', 'estados', 'status', 'reciente', 'recientes', 'visto', 'vistos',
      'silenciado', 'silenciados', 'muted', 'recent', 'viewed', 'whatsapp', 'whatsapp web',
      'contacto', 'contactos', 'chat', 'chats', 'hoy', 'ayer', 'today', 'yesterday',
      'hace', 'ahora', 'justo ahora', 'en línea', 'online', 'escribiendo', 'typing',
      'mensajes', 'llamadas', 'comunidades', 'canales', 'canales recomendados',
      'nuevo chat', 'nueva comunidad', 'perfil', 'configuración', 'ajustes', 'settings',
      'cerrar', 'close', 'pausar', 'pause', 'reproducir', 'play'
    ];

    if (forbidden.some(word => lower === word || lower.startsWith(word + ' ') || lower.endsWith(' ' + word))) {
      return true;
    }

    if (/^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(lower)) return true;
    if (/^\d+$/.test(lower)) return true;
    if (/^(hace\s+\d+|ayer\s+a\s+las|hoy\s+a\s+las)/i.test(lower)) return true;

    return false;
  }

  // Identificador ultra-resiliente del visor de estados moderno de WhatsApp Web
  function getStatusViewerContainer() {
    // 1. Botón de cerrar de la historia
    const closeBtn = document.querySelector(
      '[data-icon="x-viewer"], [data-testid="x-viewer"], [data-testid="status-v3-close"], [data-icon="status-close"], [data-testid="status-viewer-close"]'
    );
    if (closeBtn) {
      const viewer = closeBtn.closest('div[role="dialog"], div[tabindex="-1"], div._aigv, div[data-animate-status-v3="true"]');
      if (viewer && viewer !== document.body && !viewer.querySelector('#main, [data-id]')) return viewer;
      const parent = closeBtn.parentElement?.closest('div');
      if (parent && parent !== document.body && !parent.querySelector('#main, [data-id]')) return parent;
    }

    // 2. Diálogo modal abierto que contenga media o tarjetas de estado y no sea el chat
    const dialogs = document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]');
    for (const d of Array.from(dialogs)) {
      if (d === document.body) continue;
      if (!d.querySelector('#main, [data-id]') && d.querySelector('video, img, [data-testid*="status"]')) {
        return d;
      }
    }

    // 3. Detección por media en pantalla completa/overlay fuera del flujo de mensajes
    const allVideos = document.querySelectorAll('video');
    for (const v of Array.from(allVideos)) {
      if (v.closest('#main, [data-id], .message-in, .message-out')) continue;
      const rect = v.getBoundingClientRect();
      if ((rect.width > 160 || v.videoWidth > 160) && rect.height > 160) {
        return v.closest('div[tabindex], div[role], div._aigv') || v.parentElement;
      }
    }

    const allImages = document.querySelectorAll('img');
    for (const img of Array.from(allImages)) {
      if (img.classList.contains('emoji') || img.closest('[data-icon]') || img.closest('header') || img.closest('#main, [data-id], .message-in, .message-out')) {
        continue;
      }
      const rect = img.getBoundingClientRect();
      if (rect.width > 180 && rect.height > 180 && img.naturalWidth > 100) {
        return img.closest('div[tabindex], div[role], div._aigv') || img.parentElement;
      }
    }

    return null;
  }

  function extractStatusSender(container) {
    if (!container || container === document.body) return null;

    // 1. En la barra superior del visor de historias (header o Y < 140px)
    const rect = container.getBoundingClientRect();
    const candidates = container.querySelectorAll(
      'header span[dir="auto"], header div[dir="auto"], header span[title], span[title], span[dir="auto"], div[dir="auto"]'
    );

    for (const el of Array.from(candidates)) {
      const elRect = el.getBoundingClientRect();
      if ((elRect.top - rect.top) >= 0 && (elRect.top - rect.top) < 140) {
        const title = cleanWaText(el.getAttribute('title'));
        if (title && !isInvalidSenderName(title) && title.length >= 2 && title.length <= 40) {
          return title;
        }
        const text = cleanWaText(el.textContent);
        if (text && !isInvalidSenderName(text) && text.length >= 2 && text.length <= 40) {
          return text;
        }
      }
    }

    // 2. Si el usuario dio clic recientemente en un contacto en la lista de historias (< 45s)
    if (lastClickedStatusContact && (Date.now() - lastClickedStatusTime < 45000)) {
      return lastClickedStatusContact;
    }

    // 3. En el listado lateral, buscar el item activo/seleccionado
    const activeItem = document.querySelector('div[role="listitem"][aria-selected="true"], div[role="listitem"]._ak8l, div[role="listitem"]._ak8m');
    if (activeItem) {
      const nameEl = activeItem.querySelector('span[title], span[dir="auto"]');
      const name = cleanWaText(nameEl?.getAttribute('title') || nameEl?.textContent);
      if (name && !isInvalidSenderName(name)) {
        return name;
      }
    }

    return null;
  }

  async function detectAndCaptureWhatsAppStatus() {
    const container = getStatusViewerContainer();
    if (!container || container === document.body) return;

    const sender = extractStatusSender(container);
    if (!sender || isInvalidSenderName(sender)) return;

    let media = null;
    let caption = undefined;

    // 1. Video en el visor
    const videos = Array.from(container.querySelectorAll('video'));
    const mainVideo = videos.find(v => {
      const rect = v.getBoundingClientRect();
      return (rect.width > 140 || v.videoWidth > 140) && v.readyState >= 1;
    });

    if (mainVideo) {
      const captured = await captureMedia(mainVideo);
      if (captured && captured.dataUrl) {
        media = { 
          type: captured.type === 'video' ? 'video' : 'image', 
          dataUrl: captured.dataUrl 
        };
      }
    }

    // 2. Imagen en el visor (excluyendo la foto de perfil en el header y emojis)
    if (!media) {
      const images = Array.from(container.querySelectorAll('img'));
      const mainImg = images.find(img => {
        if (img.classList.contains('emoji') || img.closest('[data-icon]')) return false;
        if (img.closest('header') || img.closest('[data-testid*="header"]')) return false;
        
        const src = (img.currentSrc || img.src || '').toLowerCase();
        if (src.includes('spinner') || src.includes('loading') || src.includes('circle') || src.startsWith('data:image/svg')) return false;

        const rect = img.getBoundingClientRect();
        const hasSize = (img.naturalWidth > 140 && img.naturalHeight > 140) || (rect.width > 140 && rect.height > 140);
        return hasSize && img.complete && img.naturalWidth > 0;
      });

      if (mainImg) {
        const captured = await captureMedia(mainImg);
        if (captured && captured.dataUrl) {
          media = { type: 'image', dataUrl: captured.dataUrl };
        }
      }
    }

    // 3. Leyenda (Caption)
    const captionEl = container.querySelector(
      'div[data-testid="status-caption"], div[class*="caption"] span, div[dir="ltr"].selectable-text'
    );
    if (captionEl && captionEl.textContent) {
      const cText = cleanWaText(captionEl.textContent);
      if (cText && cText !== sender && !isInvalidSenderName(cText)) {
        caption = cText;
      }
    }

    // 4. Estado de texto
    if (!media) {
      const textElem = container.querySelector(
        'span.selectable-text, div.selectable-text, div[dir="ltr"]._ao3e, div[dir="rtl"]._ao3e, div[class*="text-status"]'
      );
      if (textElem && textElem.textContent) {
        const statusText = cleanWaText(textElem.textContent);
        if (statusText && statusText !== sender && !isInvalidSenderName(statusText) && statusText.length >= 2) {
          let bgColor = '#128c7e';
          let cur = textElem.parentElement;
          while (cur && cur !== container) {
            const bg = window.getComputedStyle(cur).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              bgColor = bg;
              break;
            }
            cur = cur.parentElement;
          }
          const cardUrl = renderTextStatusCard(statusText, bgColor);
          if (cardUrl) {
            media = { type: 'image', dataUrl: cardUrl };
            caption = statusText;
          }
        }
      }
    }

    if (!media || !media.dataUrl || media.dataUrl.length < 250) return;

    const contentHash = sender + '_' + media.dataUrl.slice(50, 120) + (caption ? '_' + caption.slice(0, 20) : '');
    if (capturedStatusHashes.has(contentHash)) return;
    capturedStatusHashes.add(contentHash);

    const statusId = 'st_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    try {
      window.postMessage({
        type: 'PHANTOM_STATUS_CAPTURED',
        data: {
          id: statusId,
          sender: sender,
          timestamp: Date.now(),
          mediaType: media.type,
          mediaUrl: media.dataUrl,
          caption: caption,
          savedAt: Date.now()
        }
      }, '*');
    } catch (e) {}
  }

  const observer = new MutationObserver((mutations) => {
    let checkStatuses = false;

    for (const m of mutations) {
      if (m.type === 'childList' && m.removedNodes.length > 0) {
        if (m.removedNodes.length > 2) {
          lastRemovedMessage = null;
          lastRemovedTime = 0;
        } else {
          m.removedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              const fullId = getMessageFullId(el);
              const stanzaId = extractStanzaId(fullId);
              const normStanza = normalizeStanza(stanzaId);
              const cleanId = fullId ? fullId.replace(/_(recalled|revoked|deleted)$/i, '') : null;
              const normClean = normalizeStanza(cleanId);
              const checkKeys = [stanzaId, normStanza, cleanId, normClean].filter(Boolean);

              for (const k of checkKeys) {
                if (liveCache.has(k) || rescuedStore.has(k)) {
                  lastRemovedMessage = liveCache.get(k) || rescuedStore.get(k);
                  lastRemovedTime = Date.now();
                  break;
                }
              }
            }
          });
        }
      }

      if (m.type === 'childList' && m.addedNodes.length > 0) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            const msgEl = getMessageContainer(el);
            if (msgEl) {
              cacheMessageNode(msgEl);
              checkForDeletion(msgEl);
            }
            if (el.querySelectorAll) {
              el.querySelectorAll('.message-in, .message-out, [data-id]').forEach(sub => {
                const subMsg = getMessageContainer(sub);
                if (subMsg) {
                  cacheMessageNode(subMsg);
                  checkForDeletion(subMsg);
                }
              });
            }
            if (isDeletionText(el.textContent || '')) {
              const dMsg = getMessageContainer(el);
              if (dMsg) checkForDeletion(dMsg);
            }
            if (
              el.matches?.('[data-icon*="viewer"], [data-icon*="status"], video, img, div[role="dialog"]') ||
              el.querySelector?.('[data-icon*="viewer"], [data-icon*="status"], video, img, div[role="dialog"]')
            ) {
              checkStatuses = true;
            }
          }
        });
      }

      if (m.type === 'attributes' && m.attributeName === 'data-id') {
        const target = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        const msgEl = getMessageContainer(target);
        if (msgEl) {
          cacheMessageNode(msgEl);
          checkForDeletion(msgEl);
        }
      }

      if (m.type === 'characterData' || (m.type === 'attributes' && (m.attributeName === 'data-icon' || m.attributeName === 'class'))) {
        const target = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        const msgEl = getMessageContainer(target);
        if (msgEl) checkForDeletion(msgEl);
      }
    }

    if (checkStatuses) {
      detectAndCaptureWhatsAppStatus();
    }
  });

  function start() {
    loadRescuedStore();

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-icon', 'class', 'data-testid', 'src', 'data-id']
    });

    document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(msg => {
      const c = getMessageContainer(msg);
      if (c) {
        cacheMessageNode(c);
        checkForDeletion(c);
      }
    });

    setInterval(() => {
      loadRescuedStore();
      document.querySelectorAll('#main [data-id], #main .message-in, #main .message-out').forEach(msg => {
        const c = getMessageContainer(msg);
        if (c) {
          cacheMessageNode(c);
          checkForDeletion(c);
        }
      });
      detectAndCaptureWhatsAppStatus();
    }, 350);

    document.addEventListener('click', () => {
      setTimeout(detectAndCaptureWhatsAppStatus, 100);
      setTimeout(detectAndCaptureWhatsAppStatus, 350);
      setTimeout(detectAndCaptureWhatsAppStatus, 800);
    }, true);

    document.addEventListener('play', () => {
      setTimeout(detectAndCaptureWhatsAppStatus, 50);
      setTimeout(detectAndCaptureWhatsAppStatus, 250);
    }, true);

    document.addEventListener('loadeddata', () => {
      setTimeout(detectAndCaptureWhatsAppStatus, 50);
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
