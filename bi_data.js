/* ════════════════════════════════════════════════════════════════
   bi_data.js — carregador único do JSON do BI Einstein
   ────────────────────────────────────────────────────────────────
   • Fonte única: Web App do Apps Script (proxies públicos removidos)
   • Timeout de 45 s + 1 nova tentativa
   • Cache local (IndexedDB) de 10 min: navegar entre páginas não
     rebaixa o JSON; se o Apps Script falhar, exibe o último JSON bom
   • BIData.meta(): lê só "geradoEm" (polling leve)
   ════════════════════════════════════════════════════════════════ */
(function () {
  const AS_EXEC  = 'https://script.google.com/macros/s/AKfycbxb6AWl5weYzZjR9uveLtUG8HhLYIIw3GasBSZZpGbcUnv6vKK792GD4nDBDqk3yF43/exec';
  const TIMEOUT  = 45000;           // ms por tentativa
  const RETRY_MS = 3000;            // espera antes da 2ª tentativa
  const TTL      = 10 * 60 * 1000;  // validade do cache
  const DB = 'bi_einstein', STORE = 'json', KEY = 'payload';

  // ── IndexedDB (sem limite prático de tamanho, ao contrário do localStorage)
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }
  async function cacheGet() {
    try {
      const db = await idb();
      return await new Promise(res => {
        const q = db.transaction(STORE).objectStore(STORE).get(KEY);
        q.onsuccess = () => res(q.result || null);
        q.onerror   = () => res(null);
      });
    } catch (_) { return null; }
  }
  async function cacheSet(data) {
    try {
      const db = await idb();
      db.transaction(STORE, 'readwrite').objectStore(STORE).put({ salvoEm: Date.now(), data }, KEY);
    } catch (_) {}
  }
  async function cacheClear() {
    try {
      const db = await idb();
      await new Promise(res => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(KEY);
        t.oncomplete = res; t.onerror = res;
      });
    } catch (_) {}
  }

  // ── fetch com timeout cobrindo resposta + leitura do corpo
  async function getJSON(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Timeout (' + ms / 1000 + ' s)' : e.message);
    } finally { clearTimeout(t); }
  }

  async function fetchRemoto() {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        const d = await getJSON(AS_EXEC + '?action=json&_=' + Date.now(), TIMEOUT);
        if (d && d.mesesDisponiveis) return d;
        throw new Error(d && d.erro ? d.erro : 'JSON sem mesesDisponiveis');
      } catch (e) {
        ultimoErro = e;
        console.warn('[BIData] tentativa ' + tentativa + ' falhou: ' + e.message);
        if (tentativa === 1) await new Promise(r => setTimeout(r, RETRY_MS));
      }
    }
    throw ultimoErro;
  }

  function avisoCache(geradoEm, motivo) {
    const div = document.createElement('div');
    const dt  = geradoEm ? new Date(geradoEm).toLocaleString('pt-BR') : 'data desconhecida';
    div.textContent = '⚠ Exibindo cópia local dos dados (gerados em ' + dt + '). Servidor indisponível: ' + motivo;
    div.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 16px;' +
      'background:#3a2a08;color:#f5c26b;font:12px/1.4 system-ui,sans-serif;border-top:1px solid #6b4e12';
    (document.body || document.documentElement).appendChild(div);
  }

  let emVoo = null; // evita buscas duplicadas na mesma página

  async function load(opts) {
    const force = opts && opts.force;
    if (emVoo && !force) return emVoo;
    emVoo = (async () => {
      const cache = await cacheGet();
      if (!force && cache && Date.now() - cache.salvoEm < TTL) return cache.data;
      try {
        const d = await fetchRemoto();
        await cacheSet(d);
        return d;
      } catch (e) {
        if (cache) { avisoCache(cache.data.geradoEm, e.message); return cache.data; }
        throw new Error('Apps Script indisponível (' + e.message + ') e sem cópia local');
      }
    })();
    try { return await emVoo; } finally { emVoo = null; }
  }

  // Só o carimbo "geradoEm" — backend novo responde com payload mínimo;
  // backend antigo ignora "meta=1" e devolve o JSON completo (também funciona).
  async function meta() {
    const d = await getJSON(AS_EXEC + '?action=json&meta=1&_=' + Date.now(), TIMEOUT);
    return (d && d.geradoEm) || null;
  }

  window.BIData = { load, meta, clear: cacheClear, AS_EXEC };
})();
