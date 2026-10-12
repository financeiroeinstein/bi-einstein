/* ════════════════════════════════════════════════════════════════
   bi_data.js — carregador único do JSON do BI Einstein
   ────────────────────────────────────────────────────────────────
   • Fonte única: Web App do Apps Script (proxies públicos removidos)
   • Timeout de 45 s + 1 nova tentativa
   • Cache local (IndexedDB): a página abre NA HORA com a cópia local
     e, em segundo plano, confere o "geradoEm" no servidor (meta=1).
     Se o JSON mudou, baixa a versão nova e mostra a barra
     "Dados novos disponíveis → Recarregar" (sem esperar TTL).
   • ?fresh=1 na URL → ignora o cache e baixa direto do servidor
   • Se o Apps Script falhar, exibe o último JSON bom
   • BIData.meta(): lê só "geradoEm" (polling leve)
   • BIData.regenerar(): disparo + acompanhamento do reprocessamento
     (lê status do servidor: agendado / rodando / ok / erro)
   ════════════════════════════════════════════════════════════════ */
(function () {
  const AS_EXEC  = 'https://script.google.com/macros/s/AKfycbxb6AWl5weYzZjR9uveLtUG8HhLYIIw3GasBSZZpGbcUnv6vKK792GD4nDBDqk3yF43/exec';
  const TIMEOUT  = 45000;           // ms por tentativa
  const RETRY_MS = 3000;            // espera antes da 2ª tentativa
  const META_MS  = 10000;           // timeout da conferência leve (geradoEm)
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

  // Barra fixa avisando que há dados novos (a página atual continua com os antigos)
  function avisoNovos(geradoEm) {
    if (document.getElementById('biNovosDados')) return;
    const div = document.createElement('div');
    div.id = 'biNovosDados';
    const dt = geradoEm ? new Date(geradoEm).toLocaleString('pt-BR') : '';
    div.innerHTML = '↻ Dados novos disponíveis' + (dt ? ' (gerados em ' + dt + ')' : '') +
      ' <button type="button" style="margin-left:10px;background:#00e5a0;color:#0a0c10;border:0;' +
      'border-radius:5px;padding:4px 12px;font:600 12px system-ui,sans-serif;cursor:pointer">Recarregar</button>';
    div.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 16px;' +
      'background:#0b2a20;color:#00e5a0;font:12px/1.4 system-ui,sans-serif;border-top:1px solid #00e5a0;' +
      'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px';
    div.querySelector('button').onclick = () => location.reload();
    (document.body || document.documentElement).appendChild(div);
  }

  // Confere em segundo plano se o servidor tem JSON mais novo que o cache
  let revalidando = false;
  async function revalidar(geradoEmCache) {
    if (revalidando) return;
    revalidando = true;
    try {
      const g = await meta(META_MS);
      if (!g || g === geradoEmCache) return;           // nada mudou
      const d = await fetchRemoto();                     // baixa a versão nova
      await cacheSet(d);
      if (d.geradoEm !== geradoEmCache) avisoNovos(d.geradoEm);
    } catch (e) {
      console.warn('[BIData] revalidação em segundo plano falhou: ' + e.message);
    } finally { revalidando = false; }
  }

  const FRESH_URL = /[?&]fresh=1\b/.test(location.search);
  let emVoo = null; // evita buscas duplicadas na mesma página

  async function load(opts) {
    const force = (opts && opts.force) || FRESH_URL;
    if (emVoo && !force) return emVoo;
    emVoo = (async () => {
      const cache = await cacheGet();
      if (!force && cache) {
        // Abre na hora com a cópia local e confere o servidor em segundo plano
        revalidar(cache.data.geradoEm);
        return cache.data;
      }
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
  async function metaStatus(ms) {
    const d = await getJSON(AS_EXEC + '?action=json&meta=1&_=' + Date.now(), ms || TIMEOUT);
    return { geradoEm: (d && d.geradoEm) || null, status: (d && d.status) || '', info: (d && d.info) || '' };
  }
  async function meta(ms) { return (await metaStatus(ms)).geradoEm; }

  // ── Reprocessamento completo (botão "Atualizar dados" e fallback do Ajustes)
  //   onProgresso({ segundos, status }) é chamado a cada consulta.
  //   Resolve com { geradoEm } ou lança Error com a mensagem do servidor.
  const esperar = ms => new Promise(r => setTimeout(r, ms));
  async function regenerar(onProgresso) {
    let antes = null;
    try { antes = await meta(10000); } catch (_) {}

    // Disparo com CORS (o Web App já responde CORS — é assim que load() funciona)
    const disparo = await getJSON(AS_EXEC + '?_=' + Date.now(), 30000);
    if (disparo && disparo.ok === false) throw new Error(disparo.erro || 'Falha ao disparar o processamento');

    const inicio = Date.now(), LIMITE = 8 * 60 * 1000, PASSO = 10000;
    while (Date.now() - inicio < LIMITE) {
      await esperar(PASSO);
      let m = null;
      try { m = await metaStatus(10000); } catch (_) { continue; }      // erro de rede pontual: tenta de novo
      if (onProgresso) onProgresso({ segundos: Math.round((Date.now() - inicio) / 1000), status: m.status });
      if (m.status === 'erro') throw new Error(m.info || 'Erro no processamento');
      if (m.geradoEm && m.geradoEm !== antes && m.status !== 'rodando' && m.status !== 'agendado') {
        await cacheClear();
        return { geradoEm: m.geradoEm };
      }
    }
    throw new Error('Tempo esgotado (8 min) — verifique as execuções do Apps Script');
  }

  window.BIData = { load, meta, metaStatus, regenerar, clear: cacheClear, AS_EXEC };
})();
