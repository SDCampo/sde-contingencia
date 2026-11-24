'use strict';
/* SDE Contingência — registro offline de visitas quando o SDE Saúde no Campo está fora do ar.
   Os dados ficam só no aparelho (IndexedDB) e saem por exportação (ZIP com JSON, CSV e fotos). */
const VERSAO = '1.2.2';

/* ============ utilidades ============ */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(9)) if (f != null && f !== false) e.append(f.nodeType ? f : document.createTextNode(String(f)));
  return e;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
const pad = (n) => String(n).padStart(2, '0');
function dataHora(iso, seg) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}${seg ? ':' + pad(d.getSeconds()) : ''}`;
}
const horaAgora = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dataBR = (s) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s.split('-').reverse().join('/') : s || '');
function num(v) { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
function idade(nasc) {
  if (!nasc) return null;
  const n = new Date(nasc + 'T12:00:00'); if (isNaN(n)) return null;
  const h = new Date(); let i = h.getFullYear() - n.getFullYear();
  if (h.getMonth() < n.getMonth() || (h.getMonth() === n.getMonth() && h.getDate() < n.getDate())) i--;
  return i >= 0 && i < 130 ? i : null;
}
const vazio = (v) => v == null || v === '' || (Array.isArray(v) && !v.some((x) => x != null && String(x).trim() !== ''));
const seguro = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('ver'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('ver'), ms); }
function carregando(msg) { $('#cargaMsg').textContent = msg || 'Aguarde…'; $('#carga').hidden = false; }
function fimCarregando() { $('#carga').hidden = true; }
const ehIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalado = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ============ banco local (IndexedDB) ============ */
const DB = {
  db: null,
  abrir() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('sde-contingencia', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('visitas')) d.createObjectStore('visitas', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('fotos')) d.createObjectStore('fotos', { keyPath: 'id' }).createIndex('visitaId', 'visitaId');
        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config', { keyPath: 'k' });
      };
      r.onblocked = () => toast('Feche as outras janelas deste app para continuar.', 6000);
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => { d.close(); this.db = null; };
        d.onclose = () => { this.db = null; };
        this.db = d; res(d);
      };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, modo, fn) {
    const d = await this.abrir();
    return new Promise((res, rej) => {
      const t = d.transaction(store, modo);
      let out; const rq = fn(t.objectStore(store));
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Gravação cancelada pelo navegador'));
    });
  },
  get(s, k) { return this.tx(s, 'readonly', (st) => st.get(k)); },
  all(s) { return this.tx(s, 'readonly', (st) => st.getAll()); },
  put(s, v) { return this.tx(s, 'readwrite', (st) => st.put(v)); },
  del(s, k) { return this.tx(s, 'readwrite', (st) => st.delete(k)); },
  chavesFotos(visitaId) { return this.tx('fotos', 'readonly', (st) => st.index('visitaId').getAllKeys(visitaId)); },
};

let cfg = { tecnico: '', uf: '' };
async function carregarCfg() { const r = await DB.get('config', 'cfg').catch(() => null); if (r) cfg = { ...cfg, ...r.v }; }
async function salvarCfg() { await DB.put('config', { k: 'cfg', v: cfg }); }

let persistPedido = false;
async function pedirPersistencia() {
  if (persistPedido) return; persistPedido = true;
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { /* sem suporte */ }
}

/* ============ opções dos campos ============ */
const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' ');
const AGUA = ['Rede pública', 'Poço artesiano', 'Poço raso / cacimba', 'Nascente / mina', 'Rio, córrego ou açude', 'Cisterna (água de chuva)', 'Carro-pipa', 'Outra'];
const LIXO = ['Coleta pública', 'Levado pelo morador até a coleta', 'Queimado na propriedade', 'Enterrado', 'Jogado a céu aberto', 'Reciclagem / compostagem', 'Outro'];
const RISCOS = ['Agrotóxicos', 'Máquinas e implementos', 'Animais (coices, mordidas)', 'Animais peçonhentos', 'Exposição ao sol', 'Esforço físico / carregar peso', 'Ruído', 'Poeira', 'Ferramentas cortantes', 'Trabalho em altura', 'Outros'];
const SIM_NAO_NS = ['Sim', 'Não', 'Não sabe'];
const idadeDe = (o) => idade(o.cab_DataNascimento);
/* Perfil de Saúde e Acompanhamento: campos, opções, condições e fórmulas vêm do SDE (sde_forms.js, gerado da configuração real). */
const GATE_PERFIL = { k: 'cab_DesejaPreencherPerfil', l: 'Deseja preencher o perfil de saúde?', t: 'rad', o: ['Sim', 'Não'], linha: true, req: true };
const PERFIL = [GATE_PERFIL, ...SDE_FORMS.perfil.map((f) => (f.t === 'calc' ? f : { ...f, se: (c) => c.cab_DesejaPreencherPerfil === 'Sim' && (!f.se || f.se(c)) }))];
/* Sem "Acionamento de Teleconsulta" (não se aplica offline); o Breve Resumo do atendimento fica sempre visível. */
const ACOMP = (() => {
  const i = SDE_FORMS.acomp.findIndex((f) => f.t === 'titulo' && /Teleconsulta/.test(f.l));
  if (i < 0) return SDE_FORMS.acomp;
  const resumo = SDE_FORMS.acomp.slice(i).find((f) => f.k === 'ate_BreveResumo');
  return [...SDE_FORMS.acomp.slice(0, i), ...(resumo ? [{ t: 'titulo', l: 'Breve Resumo' }, { ...resumo, se: null }] : [])];
})();

/* Campos. "k" usa o nome do campo no SDE (cab_…) quando existe, para facilitar o lançamento depois. */
const F = {
  propriedade: [
    { t: 'titulo', l: 'Identificação da propriedade' },
    { k: 'cab_IdATeG', l: 'ID da propriedade (ATeG)', t: 'text', req: true, modo: 'numeric' },
    { k: 'cab_NomePropriedade', l: 'Nome da propriedade', t: 'text', req: true },
    { k: 'cab_Municipio', l: 'Município', t: 'text' },
    { k: 'cab_Estado', l: 'UF', t: 'sel', o: UFS },
    { k: 'cab_NomeProdutor', l: 'Nome do produtor', t: 'text' },
  ],
  visita: [
    { t: 'titulo', l: 'Encerramento' },
    { k: 'cab_BreveResumoVisita', l: 'Breve resumo da visita', t: 'area' },
    { k: 'cab_PrevisaoProximaVisitaData', l: 'Previsão da próxima visita', t: 'date' },
    { k: 'cab_PrevisaoProximaVisitaHoraInicio', l: 'Horário previsto', t: 'time' },
  ],
  domicilio: [
    { k: 'cab_NomeDomicilio', l: 'Identificação do domicílio', t: 'text', req: true, ph: 'Ex.: Casa sede, Casa do caseiro' },
    { k: 'cab_NomeResponsavel', l: 'Responsável pelo domicílio', t: 'text' },
    { k: 'cab_IdATeG', l: 'ID ATeG / Saúde no Campo', t: 'text', modo: 'numeric' },
    { k: 'cab_NomeProdutor', l: 'Nome do produtor', t: 'text' },
  ],
  cadastro: [
    { k: 'cab_NomeCompleto', l: 'Nome completo', t: 'text', req: true },
    { k: 'cab_NomeSocial', l: 'Nome social', t: 'text' },
    { k: 'cab_DataNascimento', l: 'Data de nascimento', t: 'date', req: true },
    { k: '_idade', l: 'Idade', t: 'calc', calc: (o) => { const i = idadeDe(o); return i == null ? '' : i + (i === 1 ? ' ano' : ' anos'); } },
    { k: 'cab_Sexo', l: 'Sexo', t: 'sel', o: ['Feminino', 'Masculino'], req: true },
    { k: 'cab_CPF', l: 'CPF', t: 'text', modo: 'numeric' },
    { k: 'cns', l: 'Cartão Nacional de Saúde (CNS)', t: 'text', modo: 'numeric' },
    { k: 'cab_TelefonePessoal', l: 'Telefone', t: 'tel' },
    { k: 'cab_IdDomicilio', l: 'Domicílio', t: 'sel', req: true, o: (vis) => ((vis || V || {}).domicilios || []).map((d) => ({ v: d.id, l: d.cab_NomeDomicilio || '(domicílio sem nome)' })) },
    { k: 'vinculo', l: 'Vínculo com a propriedade', t: 'sel', o: ['Produtor responsável', 'Familiar', 'Funcionário', 'Familiar de funcionário', 'Outro'] },
    { k: 'cab_SabeLerEscrever', l: 'Sabe ler e escrever?', t: 'sn', se: (o) => { const i = idadeDe(o); return i == null || i >= 6; } },
    { k: 'cab_FrequentaEscolaCreche', l: 'Frequenta escola ou creche?', t: 'sn', se: (o) => { const i = idadeDe(o); return i != null && i < 18; } },
    { k: 'cab_AceitePrograma', l: 'Aceitou participar do programa?', t: 'sn', req: true },
    { k: 'termo', l: 'Foto do termo de aceite (opcional)', t: 'foto', se: (o) => o.cab_AceitePrograma === 'Sim' },
  ],
  perfil: PERFIL,
  acomp: ACOMP,
};

/* ============ estado e gravação ============ */
let V = null; // visita aberta
let sujo = false, timerSalvar = null;
function statusSalvo(txt, erro) { const s = $('#salvo'); s.textContent = txt || ''; s.classList.toggle('erro', !!erro); }
function mudou() {
  if (!V) return;
  sujo = true; V.atualizadoEm = new Date().toISOString();
  statusSalvo('Salvando…');
  clearTimeout(timerSalvar); timerSalvar = setTimeout(salvarAgora, 350);
}
async function salvarAgora() {
  clearTimeout(timerSalvar);
  if (!sujo || !V) return true;
  sujo = false;
  try {
    await DB.put('visitas', V);
    statusSalvo('Salvo ' + horaAgora());
    pedirPersistencia();
    return true;
  } catch (e) {
    sujo = true;
    statusSalvo('NÃO SALVO', true);
    alert('Não foi possível salvar no aparelho: ' + (e && e.message ? e.message : e) +
      '\n\nNão feche o app. Libere espaço no celular e toque em qualquer campo para tentar de novo.');
    return false;
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') salvarAgora(); });
window.addEventListener('pagehide', () => { salvarAgora(); });

const pendenteExport = (v) => v.status === 'finalizada' && (!v.exportadoEm || v.atualizadoEm > v.exportadoEm);
const bloqueada = () => V && V.status === 'finalizada';

/* ============ fotos e localização ============ */
const urlsFotos = new Map();
async function urlFoto(id) {
  if (urlsFotos.has(id)) return urlsFotos.get(id);
  const f = await DB.get('fotos', id);
  if (!f) return '';
  const u = URL.createObjectURL(new Blob([f.buf], { type: f.type || 'image/jpeg' }));
  urlsFotos.set(id, u); return u;
}
function imgFoto(id) {
  const i = el('img', { alt: 'Foto', onclick: () => verFoto(id) });
  urlFoto(id).then((u) => { if (u) i.src = u; else i.alt = 'Foto não encontrada'; });
  return i;
}
async function verFoto(id) {
  const u = await urlFoto(id); if (!u) return;
  const v = el('div', { class: 'visor', onclick: () => v.remove() }, el('img', { src: u, alt: 'Foto ampliada' }), el('button', { 'aria-label': 'Fechar' }, '✕'));
  document.body.append(v);
}
function escolherFoto() {
  return new Promise((res) => {
    const inp = $('#camera'); inp.value = '';
    inp.onchange = () => res(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.oncancel = () => res(null);
    inp.click();
  });
}
async function geoPermitida() {
  try { return navigator.permissions ? (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted' : false; } catch (e) { return false; }
}
function obterGeo() {
  return new Promise((res) => {
    if (!('geolocation' in navigator)) return res({ geoErro: 'Localização indisponível neste aparelho' });
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, precisao: Math.round(p.coords.accuracy), geoEm: new Date(p.timestamp || Date.now()).toISOString() }),
      (e) => res({ geoErro: ({ 1: 'Permissão de localização negada', 2: 'Sinal de GPS indisponível', 3: 'Tempo esgotado ao buscar o GPS' })[e.code] || String(e.message || e) }),
      { enableHighAccuracy: true, timeout: 60000, maximumAge: 0 });
  });
}
function abrirImagem(file) {
  const viaImg = () => new Promise((res, rej) => {
    const u = URL.createObjectURL(file); const i = new Image();
    i.onload = () => { res(i); setTimeout(() => URL.revokeObjectURL(u), 2000); };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Não foi possível abrir a foto (formato não suportado)')); };
    i.src = u;
  });
  if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(viaImg);
  return viaImg();
}
async function processarFoto(file, legenda) {
  const img = await abrirImagem(file);
  const max = 1600; const r = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * r), h = Math.round(img.height * r);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
  if (img.close) img.close();
  if (legenda && legenda.length) {
    const fs = Math.max(14, Math.round(Math.min(w, h) / 34)); const lh = Math.round(fs * 1.35); const bh = lh * legenda.length + Math.round(fs * 0.8);
    g.fillStyle = 'rgba(0,0,0,.62)'; g.fillRect(0, h - bh, w, bh);
    g.fillStyle = '#fff'; g.font = `600 ${fs}px system-ui, -apple-system, Roboto, Arial, sans-serif`; g.textBaseline = 'top';
    legenda.forEach((t, i) => g.fillText(t, Math.round(fs * 0.6), h - bh + Math.round(fs * 0.4) + i * lh, w - fs));
  }
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao gerar a foto'))), 'image/jpeg', 0.8));
  c.width = c.height = 0;
  return blob;
}
async function guardarFoto(visitaId, tipo, blob) {
  const id = uid();
  await DB.put('fotos', { id, visitaId, tipo, buf: await blob.arrayBuffer(), type: 'image/jpeg', criadoEm: new Date().toISOString() });
  return id;
}
async function apagarFoto(id) { if (!id) return; await DB.del('fotos', id).catch(() => {}); const u = urlsFotos.get(id); if (u) { URL.revokeObjectURL(u); urlsFotos.delete(id); } }

const NOME_PONTO = { checkin: 'Check-in', checkout: 'Check-out' };
function registrarPonto(tipo) {
  if (V[tipo] && !confirm(`Refazer o ${NOME_PONTO[tipo]}? A foto e a localização atuais serão substituídas.`)) return;
  const fotoP = escolherFoto(); // precisa ser chamado direto no toque
  let geoP = null;
  geoPermitida().then((ok) => { if (ok && !geoP) geoP = obterGeo(); });
  fotoP.then(async (arq) => {
    if (!arq) return;
    const visita = V; const quando = new Date();
    try {
      carregando('Buscando localização (GPS)…\nFique em local aberto.');
      if (!geoP) geoP = obterGeo();
      const geo = await geoP;
      carregando('Gravando foto…');
      const p = visita.propriedade;
      const leg = [`${NOME_PONTO[tipo].toUpperCase()}  ${dataHora(quando.toISOString(), true)}`,
        `ATeG ${p.cab_IdATeG || '-'} · ${(p.cab_NomePropriedade || '').slice(0, 50)}`,
        geo.geoErro ? `Sem localização: ${geo.geoErro}` : `Lat ${geo.lat.toFixed(6)}  Lon ${geo.lng.toFixed(6)}  ±${geo.precisao} m`];
      const blob = await processarFoto(arq, leg);
      const fotoId = await guardarFoto(visita.id, tipo, blob);
      const antigo = visita[tipo] && visita[tipo].fotoId;
      visita[tipo] = { fotoId, em: quando.toISOString(), ...geo };
      if (tipo === 'checkin' && !geo.geoErro && !p.cab_LatitudeSedePropriedade) { p.cab_LatitudeSedePropriedade = geo.lat.toFixed(6); p.cab_LongitudeSedePropriedade = geo.lng.toFixed(6); }
      if (V === visita) mudou(); else { visita.atualizadoEm = new Date().toISOString(); await DB.put('visitas', visita); }
      if (await salvarAgora()) await apagarFoto(antigo);
      toast(`${NOME_PONTO[tipo]} registrado`);
    } catch (e) {
      alert(`Não foi possível registrar o ${NOME_PONTO[tipo]}: ${e.message || e}`);
    } finally { fimCarregando(); render(); }
  });
}
async function refazerGeo(tipo) {
  carregando('Buscando localização (GPS)…');
  const geo = await obterGeo(); fimCarregando();
  if (geo.geoErro) return alert('Ainda sem localização: ' + geo.geoErro + '.\nVá para um local aberto e tente de novo.');
  Object.assign(V[tipo], geo, { geoErro: undefined, geoDepoisDaFoto: true });
  delete V[tipo].geoErro;
  mudou(); await salvarAgora(); toast('Localização registrada'); render();
}

/* ============ formulários ============ */
function opcoes(f, vis) { const o = typeof f.o === 'function' ? f.o(vis) : f.o || []; return o.map((x) => (typeof x === 'string' ? { v: x, l: x } : x)); }
function campo(f, d, aoMudar, visitaId) {
  const id = 'c_' + f.k + '_' + Math.random().toString(36).slice(2, 7);
  const box = el('div', { class: 'campo' }, el('label', { class: 'rot', for: id }, f.l, f.req ? el('span', { class: 'req' }, ' *') : null));
  const set = (v) => { if (vazio(v)) delete d[f.k]; else d[f.k] = v; box.classList.remove('faltando'); aoMudar(); };
  if (['text', 'tel', 'date', 'time', 'num'].includes(f.t)) {
    const i = el('input', { id, type: f.t === 'num' ? 'text' : f.t, inputmode: f.t === 'num' ? (f.dec ? 'decimal' : 'numeric') : f.t === 'tel' ? 'tel' : f.modo || null,
      placeholder: f.ph || null, autocomplete: 'off', autocapitalize: f.t === 'text' && !f.modo ? 'words' : 'off' });
    i.value = d[f.k] == null ? '' : d[f.k];
    i.addEventListener('input', () => set(i.value.trim()));
    box.append(i);
  } else if (f.t === 'area') {
    const i = el('textarea', { id, rows: 3, autocapitalize: 'sentences' }); i.value = d[f.k] || '';
    i.addEventListener('input', () => set(i.value.trim() ? i.value : ''));
    box.append(i);
  } else if (f.t === 'sel') {
    const s = el('select', { id }, el('option', { value: '' }, '— selecione —'));
    const ops = opcoes(f);
    for (const o of ops) s.append(el('option', { value: o.v }, o.l));
    if (!vazio(d[f.k]) && !ops.some((o) => o.v === d[f.k])) s.append(el('option', { value: d[f.k] }, d[f.k] + ' (opção antiga)'));
    s.value = d[f.k] || '';
    s.addEventListener('change', () => set(s.value));
    box.append(s);
  } else if (f.t === 'sn') {
    const g = el('div', { class: 'seg', role: 'group', id });
    for (const v of ['Sim', 'Não']) {
      const b = el('button', { type: 'button', 'aria-pressed': String(d[f.k] === v) }, v);
      b.addEventListener('click', () => { const novo = d[f.k] === v ? '' : v; g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.textContent === novo))); set(novo); });
      g.append(b);
    }
    box.append(g);
  } else if (f.t === 'multi') {
    const sel = new Set(Array.isArray(d[f.k]) ? d[f.k] : []);
    const lista = el('div', { class: 'multi', id });
    const linhas = opcoes(f).map((o) => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = sel.has(o.v);
      cb.addEventListener('change', () => { cb.checked ? sel.add(o.v) : sel.delete(o.v); set(opcoes(f).map((x) => x.v).filter((v) => sel.has(v))); });
      const lb = el('label', {}, cb, o.l); lb.dataset.t = o.l.toLowerCase(); return lb;
    });
    lista.append(...linhas);
    if (f.busca) {
      const b = el('input', { type: 'text', class: 'busca', placeholder: 'Filtrar a lista…', autocomplete: 'off' });
      const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      b.addEventListener('input', () => { const q = norm(b.value); linhas.forEach((l) => { l.hidden = q && !norm(l.dataset.t).includes(q) && !l.querySelector('input').checked; }); });
      box.append(el('div', { class: 'campo', style: 'margin:0' }, b));
    }
    box.append(lista);
  } else if (f.t === 'rad') {
    const g = el('div', { class: 'radios' + (f.linha ? ' linha' : ''), id, role: 'radiogroup' });
    for (const o of opcoes(f)) {
      const r = el('input', { type: 'radio', name: id, value: o.v }); r.checked = d[f.k] === o.v;
      r.addEventListener('click', () => { if (d[f.k] === o.v) { r.checked = false; set(''); } else set(o.v); });
      g.append(el('label', {}, r, o.l));
    }
    if (!vazio(d[f.k]) && !opcoes(f).some((o) => o.v === d[f.k])) g.append(el('div', { class: 'dica' }, `Resposta anterior: ${d[f.k]}`));
    box.append(g);
  } else if (f.t === 'chk') {
    const cb = el('input', { type: 'checkbox', id }); cb.checked = d[f.k] === f.v;
    cb.addEventListener('change', () => set(cb.checked ? f.v : ''));
    box.append(el('div', { class: 'multi' }, el('label', {}, cb, f.v)));
  } else if (f.t === 'lista') {
    const area = el('div', { id, class: 'lista' });
    const arr = () => (Array.isArray(d[f.k]) ? d[f.k].slice() : []);
    const gravar = (b) => { if (b.some((x) => x.trim())) set(b); else { set(''); if (b.length > 1) d[f.k] = b; } };
    const desenhar = () => {
      area.textContent = ''; const a = arr(); if (!a.length) a.push('');
      a.forEach((v, i) => {
        const inp = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'words' }); inp.value = v;
        inp.addEventListener('input', () => { const b = arr(); while (b.length <= i) b.push(''); b[i] = inp.value; gravar(b); });
        const rm = el('button', { type: 'button', class: 'btn peq perigo', 'aria-label': 'Remover', onclick: () => { const b = arr(); b.splice(i, 1); gravar(b); desenhar(); } }, '×');
        area.append(el('div', { class: 'linhaLista' }, inp, rm));
      });
      area.append(el('button', { type: 'button', class: 'btn peq', onclick: () => { const b = arr(); if (!b.length) b.push(''); b.push(''); d[f.k] = b; desenhar(); } }, 'Acrescentar campo'));
    };
    desenhar(); box.append(area);
  } else if (f.t === 'info') {
    box.classList.add('aviso', 'info'); box.textContent = ''; box.append(el('span', { class: 'infoTxt' }));
  } else if (f.t === 'calc') {
    box.append(el('div', { class: 'calc', id }, '—'));
  } else if (f.t === 'foto') {
    const area = el('div', { id });
    const desenhar = () => {
      area.textContent = '';
      if (d[f.k]) area.append(el('div', { class: 'foto' }, imgFoto(d[f.k]), el('div', { class: 'info' },
        el('button', { type: 'button', class: 'btn peq', onclick: () => tirar() }, 'Trocar foto'), ' ',
        el('button', { type: 'button', class: 'btn peq perigo', onclick: async () => { if (!confirm('Remover esta foto?')) return; const a = d[f.k]; set(''); await salvarAgora(); await apagarFoto(a); desenhar(); } }, 'Remover'))));
      else area.append(el('button', { type: 'button', class: 'btn', onclick: () => tirar() }, '📷 Tirar foto'));
    };
    const tirar = () => {
      escolherFoto().then(async (arq) => {
        if (!arq) return;
        carregando('Gravando foto…');
        try {
          const blob = await processarFoto(arq, null); const novo = await guardarFoto(visitaId, f.k, blob);
          const antigo = d[f.k]; set(novo);
          if (await salvarAgora()) await apagarFoto(antigo);
          desenhar();
        } catch (e) { alert('Não foi possível gravar a foto: ' + (e.message || e)); } finally { fimCarregando(); }
      });
    };
    desenhar(); box.append(area);
  }
  return box;
}
/* Campos de um grupo repetido ("cada": um bloco por condição, medicamento, tema…), com cache para manter a identidade. */
function camposDe(f, x) {
  if (!f._memo) f._memo = new Map();
  if (!f._memo.has(x.id)) f._memo.set(x.id, f.campos(x));
  return f._memo.get(x.id);
}
/* Percorre o formulário na ordem: só entram no contexto as respostas de campos visíveis (resposta escondida não conta nem é exportada). */
/* Como no SDE, uma condição pode olhar campos que vêm depois: repete até a visibilidade estabilizar. */
function podar(schema, base, dados) {
  let ant = null, r = null;
  for (let volta = 0; volta < 5; volta++) {
    const c = { ...base, ...(ant ? ant.c : dados) }; const vis = new Set(); const itens = new Map(); const campos = [];
    const por = (k, v) => { if (vazio(v)) { if (!(k in base)) delete c[k]; } else c[k] = v; };
    const passo = (f) => {
      const ok = !f.se || f.se(c);
      if (f.t === 'cada') {
        const its = ok ? f.itens(c, dados) : []; itens.set(f, its);
        for (const x of its) for (const g of camposDe(f, x)) passo(g);
        return;
      }
      if (!ok) { if (f.k) por(f.k, ''); return; }
      vis.add(f);
      if (f.t === 'titulo') return;
      if (f.k) por(f.k, f.t === 'calc' ? f.calc(c) : !vazio(dados[f.k]) ? dados[f.k] : f.def ? f.def(c) : '');
      campos.push(f);
    };
    schema.forEach(passo);
    const igual = ant && ant.vis.size === vis.size && [...vis].every((f) => ant.vis.has(f)) && JSON.stringify(ant.c) === JSON.stringify(c);
    r = { c, vis, itens, campos }; if (igual) break; ant = r;
  }
  return r;
}
const fmtCalc = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')) : vazio(v) ? '' : String(v));
function formulario(schema, dados, base, aoMudar) {
  const wrap = el('div', { class: 'form' }); const itens = [];
  const nodeDe = (f) => {
    const n = f.t === 'titulo' ? el('h3', { class: 'sec' }, f.l) : f.t === 'cada' ? el('div', { class: 'cada' }) : campo(f, dados, () => { aoMudar(); atualizar(); }, V && V.id);
    if (f.k) n.dataset.k = f.k; return n;
  };
  const atualizar = () => {
    const r = podar(schema, base(), dados);
    const aplicar = (lista) => {
      for (const it of lista) {
        const { f, node } = it;
        if (f.t === 'cada') {
          const its = r.itens.get(f) || []; const sig = its.map((x) => x.id).join('\n');
          if (node.dataset.sig !== sig || !it.sub) {
            node.dataset.sig = sig; node.textContent = ''; it.sub = [];
            for (const x of its) {
              node.append(el('h3', { class: 'sec' }, f.titulo ? f.titulo(x) : x.l));
              for (const g of camposDe(f, x)) { const n = nodeDe(g); node.append(n); it.sub.push({ f: g, node: n }); }
            }
          }
          node.hidden = !its.length; aplicar(it.sub); continue;
        }
        node.hidden = !r.vis.has(f) || !!f.oculto;
        if (f.t === 'calc') node.querySelector('.calc').textContent = fmtCalc(f.k ? r.c[f.k] : f.calc(r.c)) || '—';
        if (f.t === 'info') { const v = r.vis.has(f) ? f.txt || f.calc(r.c) : ''; node.querySelector('.infoTxt').textContent = v ? (f.texto ? f.texto(v) : v) : ''; if (!v) node.hidden = true; }
        if (f.def && vazio(dados[f.k])) {
          const v = r.c[f.k]; const i = node.querySelector('input:not([type=radio]):not([type=checkbox])');
          if (i) i.placeholder = vazio(v) ? f.ph || '' : 'Automático: ' + fmtCalc(v);
          node.querySelectorAll('input[type=radio]').forEach((x) => { x.checked = x.value === String(v); });
        }
      }
    };
    aplicar(itens);
  };
  for (const f of schema) { const node = nodeDe(f); itens.push({ f, node }); wrap.append(node); }
  atualizar();
  return el('div', {}, bloqueada() ? el('div', { class: 'aviso info' }, 'Visita finalizada: somente leitura. Para corrigir, volte à visita e toque em "Reabrir para corrigir".') : null,
    el('fieldset', { disabled: bloqueada() || null }, wrap));
}
function faltando(schema, dados, base) {
  const r = podar(schema, base || {}, dados);
  return r.campos.filter((f) => f.req && vazio(r.c[f.k])).map((f) => f.l);
}
/* Nomes usados pelas regras do SDE: pacienteform_… = cadastro do assistido; antecedenteform_… = perfil de saúde. */
const prefixar = (o, p) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [p + k, v]));
const basePerfil = (a) => ({ ...a.cadastro, ...prefixar(a.cadastro, 'pacienteform_') });
const baseAcomp = (a) => ({ ...basePerfil(a), ...prefixar(podar(F.perfil, basePerfil(a), a.perfil).c, 'antecedenteform_') });

/* ============ telas ============ */
function cabecalho(titulo, sub, voltar) {
  $('#titulo').textContent = titulo; $('#subtitulo').textContent = sub || '';
  const b = $('#voltar'); b.hidden = !voltar; b.onclick = () => { location.hash = voltar; };
  document.title = titulo === 'SDE Contingência' ? titulo : titulo + ' · SDE Contingência';
}
const tela = () => $('#tela');
const ir = (h) => { location.hash = h; };
function card(titulo, passo, feito, ...conteudo) {
  return el('section', { class: 'card' }, el('h2', {}, passo != null ? el('span', { class: 'passo' + (feito ? ' feito' : '') }, feito ? '✓' : passo) : null, titulo), ...conteudo);
}
const nomeAssistido = (a) => a.cadastro.cab_NomeSocial || a.cadastro.cab_NomeCompleto || '(sem nome)';
function situacaoAssistido(a) {
  return {
    cad: faltando(F.cadastro, a.cadastro).length === 0,
    perfil: !vazio(a.perfil.cab_DesejaPreencherPerfil) && faltando(F.perfil, a.perfil, basePerfil(a)).length === 0,
    acomp: Object.keys(a.acomp).length > 0 && faltando(F.acomp, a.acomp, baseAcomp(a)).length === 0,
  };
}

let promptInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); promptInstalar = e; if (rotaAtual === '') render(); });
let swEsperando = null;

async function telaInicio() {
  V = null;
  cabecalho('SDE Contingência', cfg.tecnico ? 'Técnico: ' + cfg.tecnico : 'Modo contingência — sem conexão com o SDE');
  const visitas = (await DB.all('visitas')).sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  const t = tela(); t.textContent = '';
  if (swEsperando) t.append(el('div', { class: 'aviso info' }, el('strong', {}, 'Nova versão do app disponível'),
    'Seus dados não são afetados. ', el('button', { class: 'btn peq prim', onclick: aplicarAtualizacao }, 'Atualizar agora')));
  if (!instalado()) {
    if (ehIOS) t.append(el('div', { class: 'aviso' }, el('strong', {}, 'Instale o app na Tela de Início'),
      'No Safari, toque em Compartilhar (□↑) → "Adicionar à Tela de Início". Depois use SEMPRE pelo ícone: o que for lançado no Safari fica separado do ícone e pode ser apagado pelo iPhone.'));
    else t.append(el('div', { class: 'aviso' }, el('strong', {}, 'Instale o app no celular'),
      'Assim ele abre sem internet e protege os dados. ',
      promptInstalar ? el('button', { class: 'btn peq prim', onclick: async () => { promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; render(); } }, 'Instalar')
        : 'No Chrome: menu ⋮ → "Instalar app" ou "Adicionar à tela inicial".'));
  }
  if (!cfg.tecnico) t.append(el('div', { class: 'aviso info' }, el('strong', {}, 'Informe seu nome'), 'Ele vai nos arquivos exportados. ', el('a', { href: '#/ajustes' }, 'Abrir ajustes')));
  t.append(el('button', { class: 'btn prim grande', onclick: novaVisita }, '+ Nova visita'));

  const grupos = [
    ['Em andamento', visitas.filter((v) => v.status !== 'finalizada')],
    ['Finalizadas — exportar', visitas.filter(pendenteExport)],
    ['Exportadas', visitas.filter((v) => v.status === 'finalizada' && !pendenteExport(v))],
  ];
  for (const [nome, lista] of grupos) {
    if (!lista.length) continue;
    const corpo = lista.map(itemVisita);
    if (nome === 'Exportadas') t.append(el('details', { class: 'grupo card' }, el('summary', {}, `${nome} (${lista.length})`), corpo));
    else t.append(el('h3', { class: 'pequeno', style: 'margin:18px 0 8px;text-transform:uppercase' }, `${nome} (${lista.length})`), ...corpo);
  }
  if (!visitas.length) t.append(el('p', { class: 'vazio' }, 'Nenhuma visita registrada neste aparelho.'));
  const pend = grupos[1][1].length;
  t.append(el('div', { class: 'linhaBtns', style: 'margin-top:18px' },
    el('button', { class: 'btn' + (pend ? ' ok' : ''), onclick: () => ir('#/exportar') }, pend ? `Exportar (${pend})` : 'Exportar'),
    el('button', { class: 'btn', onclick: () => ir('#/ajustes') }, 'Ajustes e backup')));
  t.append(el('p', { class: 'pequeno', style: 'text-align:center;margin-top:16px' }, `Versão ${VERSAO} · os dados ficam somente neste aparelho até serem exportados`));
}
function itemVisita(v) {
  const p = v.propriedade || {};
  const chips = [
    v.checkin ? el('span', { class: 'chip ok' }, 'check-in') : el('span', { class: 'chip al' }, 'sem check-in'),
    v.checkout ? el('span', { class: 'chip ok' }, 'check-out') : v.status !== 'finalizada' ? el('span', { class: 'chip' }, 'sem check-out') : null,
    el('span', { class: 'chip' }, `${v.assistidos.length} assistido(s)`),
    v.status === 'finalizada' ? el('span', { class: 'chip ' + (pendenteExport(v) ? 'al' : 'ok') }, pendenteExport(v) ? 'exportar' : 'exportada ' + dataHora(v.exportadoEm)) : null,
  ];
  return el('button', { class: 'item', onclick: () => ir('#/v/' + v.id) },
    el('div', { class: 'txt' }, el('strong', {}, p.cab_NomePropriedade || 'Propriedade sem nome'),
      el('small', {}, `ATeG ${p.cab_IdATeG || '—'} · ${dataHora(v.criadoEm)}`), el('div', { class: 'chips' }, chips)),
    el('span', { class: 'seta' }, '›'));
}
async function novaVisita() {
  if (!cfg.tecnico) {
    const n = (prompt('Antes de começar, informe seu nome (técnico):') || '').trim();
    if (!n) return;
    cfg.tecnico = n; await salvarCfg();
  }
  const agora = new Date().toISOString();
  V = { id: uid(), app: 'sde-contingencia', versaoApp: VERSAO, criadoEm: agora, atualizadoEm: agora, status: 'andamento', tecnico: cfg.tecnico,
    propriedade: {}, visita: {}, checkin: null, checkout: null, domicilios: [], assistidos: [] };
  await DB.put('visitas', V);
  pedirPersistencia();
  ir('#/v/' + V.id + '/prop');
}

function telaVisita() {
  const p = V.propriedade;
  cabecalho(p.cab_NomePropriedade || 'Nova visita', `ATeG ${p.cab_IdATeG || '—'} · ${dataHora(V.criadoEm)}`, '#/');
  const t = tela(); t.textContent = '';
  if (bloqueada()) t.append(el('div', { class: 'aviso ' + (pendenteExport(V) ? '' : 'info') }, el('strong', {}, 'Visita finalizada em ' + dataHora(V.finalizadaEm)),
    pendenteExport(V) ? 'Falta exportar. ' : `Exportada em ${dataHora(V.exportadoEm)}. `,
    el('button', { class: 'btn peq', onclick: reabrir }, 'Reabrir para corrigir')));
  const propOk = !!(p.cab_IdATeG && p.cab_NomePropriedade);
  t.append(card('Propriedade', 1, propOk,
    propOk ? el('dl', { class: 'kv' }, el('dt', {}, 'ID ATeG'), el('dd', {}, p.cab_IdATeG), el('dt', {}, 'Nome'), el('dd', {}, p.cab_NomePropriedade),
      p.cab_Municipio ? [el('dt', {}, 'Município'), el('dd', {}, p.cab_Municipio + (p.cab_Estado ? '/' + p.cab_Estado : ''))] : null)
      : el('p', { class: 'dica' }, 'Informe o ID e o nome da propriedade.'),
    el('div', { class: 'linhaBtns' }, el('button', { class: 'btn' + (propOk ? '' : ' prim'), onclick: () => ir(`#/v/${V.id}/prop`) }, propOk ? 'Ver / editar' : 'Preencher'))));
  t.append(blocoPonto('checkin', 2));
  /* Cada assistido aparece dentro do seu domicílio. */
  const itemAss = (a) => {
    const s = situacaoAssistido(a); const i = idadeDe(a.cadastro);
    return el('button', { class: 'item sub', onclick: () => ir(`#/v/${V.id}/ass/${a.id}`) },
      el('div', { class: 'txt' }, el('strong', {}, nomeAssistido(a)),
        el('small', {}, [i != null ? i + ' anos' : null, a.cadastro.cab_Sexo].filter(Boolean).join(' · ') || 'toque para preencher'),
        el('div', { class: 'chips' }, el('span', { class: 'chip ' + (s.cad ? 'ok' : 'al') }, 'cadastro'), el('span', { class: 'chip ' + (s.perfil ? 'ok' : '') }, 'perfil de saúde'),
          el('span', { class: 'chip ' + (s.acomp ? 'ok' : '') }, 'acompanhamento'))), el('span', { class: 'seta' }, '›'));
  };
  const blocos = V.domicilios.map((d) => {
    const membros = V.assistidos.filter((a) => a.cadastro.cab_IdDomicilio === d.id);
    return el('div', { class: 'grupoDom' },
      el('button', { class: 'item', onclick: () => ir(`#/v/${V.id}/dom/${d.id}`) },
        el('div', { class: 'txt' }, el('strong', {}, '🏠 ' + (d.cab_NomeDomicilio || '(domicílio sem nome)')),
          el('small', {}, [d.cab_NomeResponsavel ? 'Resp.: ' + d.cab_NomeResponsavel : null, membros.length + ' assistido(s)'].filter(Boolean).join(' · '))), el('span', { class: 'seta' }, '›')),
      ...membros.map(itemAss),
      el('button', { class: 'btn peq sub', disabled: bloqueada() || null, onclick: () => novoAssistido(d.id) }, '+ Assistido neste domicílio'));
  });
  const soltos = V.assistidos.filter((a) => !V.domicilios.some((d) => d.id === a.cadastro.cab_IdDomicilio));
  if (soltos.length) blocos.push(el('div', { class: 'grupoDom' }, el('p', { class: 'dica' }, 'Sem domicílio (abra o cadastro e escolha o domicílio):'), ...soltos.map(itemAss)));
  const okDom = V.domicilios.length > 0 && V.assistidos.length > 0 && V.assistidos.every((a) => situacaoAssistido(a).cad) && !soltos.length;
  t.append(card('Domicílios e assistidos', 3, okDom, blocos.length ? blocos : el('p', { class: 'dica' }, 'Cadastre o domicílio e depois os assistidos que moram nele.'),
    el('button', { class: 'btn', disabled: bloqueada() || null, onclick: novoDomicilio }, '+ Adicionar domicílio')));
  const visOk = !vazio(V.visita.cab_BreveResumoVisita);
  t.append(card('Encerramento', 4, visOk, el('p', { class: 'dica' }, 'Breve resumo, previsão da próxima visita e horário previsto.'),
    el('div', { class: 'linhaBtns' }, el('button', { class: 'btn' + (visOk ? '' : ' prim'), onclick: () => ir(`#/v/${V.id}/visita`) }, visOk ? 'Ver / editar' : 'Preencher'))));
  t.append(blocoPonto('checkout', 5));
  if (!bloqueada()) t.append(el('button', { class: 'btn ok grande', onclick: finalizar }, 'Finalizar visita'));
  t.append(el('div', { class: 'linhaBtns', style: 'margin-top:24px' }, el('button', { class: 'btn perigo', onclick: excluirVisita }, 'Excluir visita')));
}
function blocoPonto(tipo, passo) {
  const pt = V[tipo]; const nome = NOME_PONTO[tipo];
  if (!pt) {
    const propOk = !!(V.propriedade.cab_IdATeG && V.propriedade.cab_NomePropriedade);
    const pode = tipo === 'checkin' ? propOk : !!V.checkin;
    const dica = tipo === 'checkin'
      ? (pode ? 'Ao chegar: tire a foto. O app grava data, hora e localização (funciona sem internet).' : 'Preencha o ID e o nome da propriedade antes do check-in.')
      : (pode ? 'Ao sair da propriedade: tire a foto de check-out.' : 'Faça o check-in primeiro.');
    return card(nome, passo, false, el('p', { class: 'dica' }, dica),
      el('button', { class: 'btn prim grande', disabled: !pode || bloqueada() || null, onclick: () => registrarPonto(tipo) }, '📷 Fazer ' + nome.toLowerCase()));
  }
  const dur = tipo === 'checkout' && V.checkin ? Math.round((new Date(pt.em) - new Date(V.checkin.em)) / 60000) : null;
  return card(nome, passo, true, el('div', { class: 'foto' }, imgFoto(pt.fotoId), el('div', { class: 'info' },
    el('div', {}, el('strong', {}, dataHora(pt.em, true))),
    pt.geoErro ? el('div', { class: 'chip er' }, 'Sem localização: ' + pt.geoErro)
      : el('div', {}, `${pt.lat.toFixed(6)}, ${pt.lng.toFixed(6)}`, el('br'), el('span', { class: 'pequeno' }, `precisão ±${pt.precisao} m${pt.geoDepoisDaFoto ? ' · obtida depois da foto' : ''}`)),
    dur != null ? el('div', { class: 'pequeno' }, `Duração da visita: ${Math.floor(dur / 60)}h${pad(dur % 60)}`) : null)),
  el('div', { class: 'linhaBtns' },
    pt.geoErro && !bloqueada() ? el('button', { class: 'btn prim', onclick: () => refazerGeo(tipo) }, 'Tentar localização de novo') : null,
    bloqueada() ? null : el('button', { class: 'btn peq', onclick: () => registrarPonto(tipo) }, 'Refazer ' + nome.toLowerCase())));
}
function rodapeConcluir(voltar, extra) {
  return el('div', { class: 'rodape' }, extra || null, el('button', { class: 'btn prim', onclick: async () => { await salvarAgora(); ir(voltar); } }, 'Concluir'));
}
function telaProp() {
  cabecalho('Propriedade', V.propriedade.cab_NomePropriedade || '', '#/v/' + V.id);
  const t = tela(); t.textContent = '';
  const f = formulario(F.propriedade, V.propriedade, () => V.propriedade, () => { mudou(); $('#subtitulo').textContent = V.propriedade.cab_NomePropriedade || ''; });
  t.append(el('div', { class: 'card' }, f), rodapeConcluir('#/v/' + V.id));
}
function telaDadosVisita() {
  cabecalho('Encerramento', V.propriedade.cab_NomePropriedade || '', '#/v/' + V.id);
  const t = tela(); t.textContent = '';
  t.append(el('div', { class: 'card' }, formulario(F.visita, V.visita, () => V.visita, mudou)), rodapeConcluir('#/v/' + V.id));
}
function novoDomicilio() {
  const d = { id: uid(), criadoEm: new Date().toISOString(), cab_IdATeG: V.propriedade.cab_IdATeG, cab_NomeProdutor: V.propriedade.cab_NomeProdutor };
  for (const k of ['cab_IdATeG', 'cab_NomeProdutor']) if (vazio(d[k])) delete d[k];
  V.domicilios.push(d); mudou(); ir(`#/v/${V.id}/dom/${d.id}`);
}
function telaDomicilio(did) {
  const d = V.domicilios.find((x) => x.id === did);
  if (!d) return ir('#/v/' + V.id);
  cabecalho('Domicílio', d.cab_NomeDomicilio || V.propriedade.cab_NomePropriedade || '', '#/v/' + V.id);
  const t = tela(); t.textContent = '';
  const membros = V.assistidos.filter((a) => a.cadastro.cab_IdDomicilio === did);
  t.append(el('div', { class: 'card' }, formulario(F.domicilio, d, () => d, () => { mudou(); $('#subtitulo').textContent = d.cab_NomeDomicilio || ''; })),
    el('div', { class: 'card' }, el('h3', { class: 'sec' }, 'Assistidos deste domicílio'),
      membros.length ? membros.map((a) => el('button', { class: 'item', onclick: () => ir(`#/v/${V.id}/ass/${a.id}`) }, el('div', { class: 'txt' }, el('strong', {}, nomeAssistido(a))), el('span', { class: 'seta' }, '›')))
        : el('p', { class: 'dica' }, 'Nenhum assistido neste domicílio.'),
      el('button', { class: 'btn', disabled: bloqueada() || null, onclick: async () => { await salvarAgora(); novoAssistido(did); } }, '+ Adicionar assistido')),
    rodapeConcluir('#/v/' + V.id, bloqueada() ? null : el('button', { class: 'btn perigo', onclick: () => {
      const n = V.assistidos.filter((a) => a.cadastro.cab_IdDomicilio === did).length;
      if (!confirm(`Excluir este domicílio?${n ? `\n${n} assistido(s) ficarão sem domicílio.` : ''}`)) return;
      V.domicilios = V.domicilios.filter((x) => x.id !== did);
      V.assistidos.forEach((a) => { if (a.cadastro.cab_IdDomicilio === did) delete a.cadastro.cab_IdDomicilio; });
      mudou(); ir('#/v/' + V.id);
    } }, 'Excluir')));
}
function novoAssistido(did) {
  const a = { id: uid(), criadoEm: new Date().toISOString(), cadastro: {}, perfil: {}, acomp: {} };
  if (typeof did === 'string') a.cadastro.cab_IdDomicilio = did;
  else if (V.domicilios.length === 1) a.cadastro.cab_IdDomicilio = V.domicilios[0].id;
  V.assistidos.push(a); mudou(); ir(`#/v/${V.id}/ass/${a.id}`);
}
function telaAssistido(aid, aba) {
  const a = V.assistidos.find((x) => x.id === aid);
  if (!a) return ir('#/v/' + V.id);
  aba = ['perfil', 'acomp'].includes(aba) ? aba : 'cad';
  const base = `#/v/${V.id}/ass/${aid}`;
  cabecalho(nomeAssistido(a), V.propriedade.cab_NomePropriedade || '', '#/v/' + V.id);
  const t = tela(); t.textContent = '';
  const s = situacaoAssistido(a);
  t.append(el('nav', { class: 'abas' },
    el('a', { href: base, class: aba === 'cad' ? 'atual' : null }, (s.cad ? '✓ ' : '') + 'Cadastro'),
    el('a', { href: base + '/perfil', class: aba === 'perfil' ? 'atual' : null }, (s.perfil ? '✓ ' : '') + 'Saúde'),
    el('a', { href: base + '/acomp', class: aba === 'acomp' ? 'atual' : null }, (s.acomp ? '✓ ' : '') + 'Acompanhamento')));
  if (vazio(a.perfil.cab_DesejaPreencherPerfil) && Object.keys(a.perfil).length) a.perfil.cab_DesejaPreencherPerfil = 'Sim'; // visitas da versão 1.0
  const ctx = aba === 'cad' ? () => ({}) : aba === 'perfil' ? () => basePerfil(a) : () => baseAcomp(a);
  const dados = aba === 'cad' ? a.cadastro : aba === 'perfil' ? a.perfil : a.acomp;
  const schema = aba === 'cad' ? F.cadastro : aba === 'perfil' ? F.perfil : F.acomp;
  if (aba !== 'cad' && !a.cadastro.cab_DataNascimento) t.append(el('div', { class: 'aviso' }, 'Preencha a data de nascimento e o sexo no Cadastro para mostrar as perguntas da faixa etária certa.'));
  if (aba === 'cad' && !V.domicilios.length) t.append(el('div', { class: 'aviso info' }, 'Nenhum domicílio cadastrado nesta visita. ', el('a', { href: `#/v/${V.id}` }, 'Voltar e adicionar')));
  t.append(el('div', { class: 'card' }, formulario(schema, dados, ctx, () => { mudou(); if (aba === 'cad') $('#titulo').textContent = nomeAssistido(a); })));
  const prox = aba === 'cad' ? base + '/perfil' : aba === 'perfil' ? base + '/acomp' : '#/v/' + V.id;
  t.append(el('div', { class: 'rodape' },
    bloqueada() ? null : el('button', { class: 'btn perigo', onclick: () => {
      if (!confirm(`Excluir o assistido ${nomeAssistido(a)} e tudo o que foi preenchido para ele?`)) return;
      const foto = a.cadastro.termo; V.assistidos = V.assistidos.filter((x) => x.id !== aid); mudou();
      salvarAgora().then((ok) => { if (ok) apagarFoto(foto); }); ir('#/v/' + V.id);
    } }, 'Excluir'),
    el('button', { class: 'btn prim', onclick: async () => { await salvarAgora(); ir(prox); } }, aba === 'acomp' ? 'Concluir' : 'Próximo ›')));
}
async function finalizar() {
  await salvarAgora();
  const p = V.propriedade; const bloq = [];
  if (!p.cab_IdATeG) bloq.push('ID da propriedade (ATeG)');
  if (!p.cab_NomePropriedade) bloq.push('Nome da propriedade');
  if (!V.checkin) bloq.push('Check-in');
  if (!V.checkout) bloq.push('Check-out');
  if (bloq.length) return alert('Para finalizar, falta:\n\n• ' + bloq.join('\n• '));
  const av = [];
  for (const x of faltando(F.visita, V.visita)) av.push('Encerramento: ' + x);
  V.domicilios.forEach((d, i) => faltando(F.domicilio, d).forEach((x) => av.push(`Domicílio ${i + 1}: ${x}`)));
  V.assistidos.forEach((a) => {
    const n = nomeAssistido(a);
    faltando(F.cadastro, a.cadastro).forEach((x) => av.push(`${n}: ${x}`));
    if (vazio(a.perfil.cab_DesejaPreencherPerfil)) av.push(`${n}: responder "Deseja preencher o perfil de saúde?"`);
    else faltando(F.perfil, a.perfil, basePerfil(a)).forEach((x) => av.push(`${n} (saúde): ${x}`));
    if (Object.keys(a.acomp).length) faltando(F.acomp, a.acomp, baseAcomp(a)).forEach((x) => av.push(`${n} (acompanhamento): ${x}`));
  });
  if (!V.assistidos.length) av.push('Nenhum assistido cadastrado');
  if (V.checkin.geoErro || V.checkout.geoErro) av.push('Check-in ou check-out sem localização');
  const durMin = Math.round((new Date(V.checkout.em) - new Date(V.checkin.em)) / 60000);
  if (durMin < 120 && !confirm(`Atenção: esta visita durou ${Math.floor(Math.max(0, durMin) / 60)}h${pad(Math.max(0, durMin) % 60)}, menos de 2 horas entre o check-in e o check-out.\n\nDeseja finalizar mesmo assim?`)) return;
  if (av.length && !confirm('Atenção, há itens incompletos:\n\n• ' + av.slice(0, 15).join('\n• ') + (av.length > 15 ? `\n… e mais ${av.length - 15}` : '') + '\n\nFinalizar mesmo assim?')) return;
  V.status = 'finalizada'; V.finalizadaEm = new Date().toISOString(); mudou(); await salvarAgora();
  toast('Visita finalizada. Lembre-se de exportar.'); render();
}
async function reabrir() {
  if (!confirm('Reabrir a visita para corrigir? Depois, finalize e exporte de novo.')) return;
  V.status = 'andamento'; mudou(); await salvarAgora(); render();
}
async function excluirVisita() {
  if (V.status !== 'finalizada' || pendenteExport(V)) {
    if (!confirm('Esta visita AINDA NÃO FOI EXPORTADA. Excluir apaga tudo o que foi preenchido e as fotos, sem volta.\n\nContinuar?')) return;
  }
  const r = prompt('Para confirmar a exclusão, digite EXCLUIR');
  if ((r || '').trim().toUpperCase() !== 'EXCLUIR') return;
  const id = V.id;
  sujo = false; clearTimeout(timerSalvar);
  const fotos = await DB.chavesFotos(id).catch(() => []);
  for (const f of fotos) await apagarFoto(f);
  await DB.del('visitas', id); V = null; toast('Visita excluída'); ir('#/');
}

/* ============ exportação ============ */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function criarZip(arqs) {
  const enc = new TextEncoder(); const partes = []; const central = []; let off = 0;
  const d = new Date(); const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(); const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  for (const a of arqs) {
    const nome = enc.encode(a.nome); const dados = a.dados; const crc = crc32(dados); const n = dados.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, tm, true); h.setUint16(12, dt, true);
    h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, nome.length, true); h.setUint16(28, 0, true);
    partes.push(h.buffer, nome, dados);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, tm, true); c.setUint16(14, dt, true);
    c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, nome.length, true); c.setUint32(42, off, true);
    central.push(c.buffer, nome);
    off += 30 + nome.length + n;
  }
  const tamC = central.reduce((s, b) => s + b.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, arqs.length, true); e.setUint16(10, arqs.length, true); e.setUint32(12, tamC, true); e.setUint32(16, off, true);
  return new Blob([...partes, ...central, e.buffer], { type: 'application/zip' });
}
async function lerZip(buf) {
  const dv = new DataView(buf); let i = buf.byteLength - 22;
  while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
  if (i < 0) throw new Error('o arquivo não é um ZIP válido');
  const n = dv.getUint16(i + 10, true); let p = dv.getUint32(i + 16, true);
  const dec = new TextDecoder(); const out = {};
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP corrompido');
    const metodo = dv.getUint16(p + 10, true); const tamC = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true); const offL = dv.getUint32(p + 42, true);
    const nome = dec.decode(new Uint8Array(buf, p + 46, ln));
    const ini = offL + 30 + dv.getUint16(offL + 26, true) + dv.getUint16(offL + 28, true);
    const bruto = new Uint8Array(buf, ini, tamC);
    if (metodo === 0) out[nome] = bruto;
    else if (metodo === 8 && window.DecompressionStream) out[nome] = new Uint8Array(await new Response(new Blob([bruto]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else if (metodo === 8) throw new Error('ZIP compactado não suportado neste aparelho; use o arquivo original exportado pelo app');
    p += 46 + ln + le + lc;
  }
  return out;
}
/* ---------- exportação: uma planilha Excel com todas as visitas ---------- */
function valorExport(f, c, nomesFotos, vis) {
  if (f.t === 'calc') return fmtCalc(f.k ? c[f.k] : f.calc(c));
  if (f.t === 'info') return f.calc(c) || '';
  let v = c[f.k]; if (vazio(v) && f.def) v = f.def(c);
  if (vazio(v)) return '';
  if (f.t === 'foto') return nomesFotos[v] || '';
  if (f.t === 'date') return dataBR(v);
  if (Array.isArray(v)) return v.filter((x) => !vazio(x)).join(' | ');
  if (f.t === 'sel' && typeof f.o === 'function') { const o = opcoes(f, vis).find((x) => x.v === v); return o ? o.l : v; }
  return v;
}
/* Colunas visíveis de um formulário para uma linha: [{k, l, form}] e os valores em lin. */
function linhaForm(lin, cols, form, pre, schema, base, dados, nomesFotos, vis) {
  const r = podar(schema, base, dados);
  for (const f of r.campos) {
    if (!f.k || f.k[0] === '_' || f.oculto || (f.t === 'info' && !f.texto)) continue;
    const k = pre + f.k;
    cols.push({ k, l: f.l || f.k, form, nome: f.k });
    lin[k] = valorExport(f, r.c, nomesFotos, vis);
  }
  return r;
}
/* Junta as colunas de várias linhas mantendo a ordem do formulário. */
function mesclar(ordem, lista) {
  let pos = -1;
  for (const c of lista) {
    const i = ordem.findIndex((x) => x.k === c.k);
    if (i >= 0) pos = i; else { ordem.splice(pos + 1, 0, c); pos++; }
  }
}
function matriz(linhas) {
  const cols = []; for (const l of linhas) mesclar(cols, l.cols);
  const cab = [cols.map((c) => c.form), cols.map((c) => c.l), cols.map((c) => c.nome)];
  return [...cab, ...linhas.map((l) => cols.map((c) => (l.v[c.k] == null ? '' : String(l.v[c.k]))))];
}
const colLetra = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const xesc = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 32000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function criarXlsx(folhas) {
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = 'http://schemas.openxmlformats.org/';
  const folhaXML = (m) => {
    const larg = Math.max(1, ...m.map((l) => l.length));
    const linhas = m.map((lin, r) => `<row r="${r + 1}">` + lin.map((v, c) => (v === '' ? '' :
      `<c r="${colLetra(c)}${r + 1}" t="inlineStr"${r < 3 ? ` s="${r === 1 ? 2 : 1}"` : ''}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`)).join('') + '</row>').join('');
    return `${X}<worksheet xmlns="${NS}spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="0" ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols><col min="1" max="${larg}" width="26" customWidth="1"/></cols><sheetData>${linhas}</sheetData></worksheet>`;
  };
  const enc = new TextEncoder();
  const arqs = [
    { nome: '[Content_Types].xml', dados: enc.encode(`${X}<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      folhas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') },
    { nome: '_rels/.rels', dados: enc.encode(`${X}<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${NS}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { nome: 'xl/workbook.xml', dados: enc.encode(`${X}<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships"><sheets>` +
      folhas.map((f, i) => `<sheet name="${xesc(f.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>') },
    { nome: 'xl/_rels/workbook.xml.rels', dados: enc.encode(`${X}<Relationships xmlns="${NS}package/2006/relationships">` +
      folhas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${folhas.length + 1}" Type="${NS}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { nome: 'xl/styles.xml', dados: enc.encode(`${X}<styleSheet xmlns="${NS}spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="9"/><color rgb="FF666666"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>') },
    ...folhas.map((f, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: enc.encode(folhaXML(f.m)) })),
  ];
  return new Uint8Array(await criarZip(arqs).arrayBuffer());
}
function etapasAtendimento(a) {
  const e = ['Cadastro do Assistido'];
  if (a.perfil.cab_DesejaPreencherPerfil === 'Sim') e.push('Perfil de Saúde');
  if (Object.keys(a.acomp).length) e.push('Acompanhamento');
  return e;
}
const categoriaVisita = (e) => (e.includes('Acompanhamento') ? 'Acompanhamento' : e.includes('Perfil de Saúde') ? 'Perfil de Saúde' : 'Visita de Cadastro');
async function montarExportacao(visitas) {
  const enc = new TextEncoder(); const arqs = []; const fotosIdx = []; const nomesFotos = {};
  for (const v of visitas) {
    const ateg = seguro(v.propriedade.cab_IdATeG) || 'sem-id';
    const ids = await DB.chavesFotos(v.id);
    for (const id of ids) {
      const f = await DB.get('fotos', id); if (!f) continue;
      const usada = (v.checkin && v.checkin.fotoId === id) || (v.checkout && v.checkout.fotoId === id) || v.assistidos.some((a) => a.cadastro.termo === id);
      if (!usada) continue;
      const nome = `fotos/${ateg}_${seguro(f.tipo)}_${id.slice(0, 8)}.jpg`;
      nomesFotos[id] = nome; fotosIdx.push({ id, visitaId: v.id, tipo: f.tipo, arquivo: nome });
      arqs.push({ nome, dados: new Uint8Array(f.buf) });
    }
  }
  const fx = (k, l, form = 'Controle (app)') => ({ k, l, form, nome: k });
  const T = { vis: [], dom: [], ass: [], perf: [], acomp: [], tudo: [] };
  for (const v of visitas) {
    const p = v.propriedade;
    const idc = { app_visita_id: v.id, cab_IdATeG: p.cab_IdATeG || '', cab_NomePropriedade: p.cab_NomePropriedade || '' };
    const colsId = [fx('app_visita_id', 'ID da visita (app)'), fx('cab_IdATeG', 'ID ATeG', 'Propriedade'), fx('cab_NomePropriedade', 'Nome da propriedade', 'Propriedade')];
    /* visita */
    const lv = { ...idc, app_situacao: v.status === 'finalizada' ? 'Finalizada' : 'Em andamento', app_tecnico: v.tecnico || '', app_criadaEm: dataHora(v.criadoEm), app_finalizadaEm: dataHora(v.finalizadaEm) };
    const cv = [...colsId, fx('app_situacao', 'Situação'), fx('app_tecnico', 'Técnico'), fx('app_criadaEm', 'Criada em'), fx('app_finalizadaEm', 'Finalizada em')];
    const propSem = F.propriedade.filter((f) => !['cab_IdATeG', 'cab_NomePropriedade'].includes(f.k));
    linhaForm(lv, cv, 'Propriedade', '', propSem, {}, p, nomesFotos);
    linhaForm(lv, cv, 'Visita', 'visita.', F.visita, {}, v.visita, nomesFotos);
    for (const [tipo, n] of [['checkin', 'Check-in'], ['checkout', 'Check-out']]) {
      const pt = v[tipo] || {};
      Object.assign(lv, { [tipo + '_em']: dataHora(pt.em, true), [tipo + '_lat']: pt.lat != null ? pt.lat.toFixed(6) : '', [tipo + '_lng']: pt.lng != null ? pt.lng.toFixed(6) : '',
        [tipo + '_precisao']: pt.precisao != null ? Math.round(pt.precisao) : '', [tipo + '_erro']: pt.geoErro || '', [tipo + '_foto']: nomesFotos[pt.fotoId] || '' });
      cv.push(fx(tipo + '_em', `${n} — data e hora`, n), fx(tipo + '_lat', `${n} — latitude`, n), fx(tipo + '_lng', `${n} — longitude`, n),
        fx(tipo + '_precisao', `${n} — precisão (m)`, n), fx(tipo + '_erro', `${n} — problema de localização`, n), fx(tipo + '_foto', `${n} — arquivo da foto`, n));
    }
    lv.app_duracao = v.checkin && v.checkout ? Math.round((new Date(v.checkout.em) - new Date(v.checkin.em)) / 60000) : '';
    lv.app_qtdDom = v.domicilios.length; lv.app_qtdAss = v.assistidos.length;
    cv.push(fx('app_duracao', 'Duração (min)'), fx('app_qtdDom', 'Domicílios'), fx('app_qtdAss', 'Assistidos'));
    T.vis.push({ v: lv, cols: cv });
    /* domicílios */
    const doms = {};
    v.domicilios.forEach((d) => {
      const l = { ...idc, app_dom_id: d.id }; const c = [...colsId, fx('app_dom_id', 'ID do domicílio (app)')];
      linhaForm(l, c, 'Domicílio (1001)', 'dom.', F.domicilio, {}, d, nomesFotos); T.dom.push({ v: l, cols: c }); doms[d.id] = { l, c };
    });
    /* assistidos: cadastro, perfil, acompanhamento e a linha completa */
    if (!v.assistidos.length) T.tudo.push({ v: { ...lv }, cols: [...cv] });
    v.assistidos.forEach((a) => {
      const e = etapasAtendimento(a);
      const id2 = { ...idc, app_ass_id: a.id, app_ass_nome: a.cadastro.cab_NomeCompleto || '' };
      const c2 = [...colsId, fx('app_ass_id', 'ID do assistido (app)'), fx('app_ass_nome', 'Nome do assistido')];
      const lc = { ...id2 }; const cc = [...c2];
      linhaForm(lc, cc, 'Assistido (1002)', 'cad.', F.cadastro, {}, a.cadastro, nomesFotos, v);
      lc['cad.cab_EtapasAtendimento'] = e.join(' | '); lc['cad.cab_CategoriaVisita'] = categoriaVisita(e);
      cc.push({ k: 'cad.cab_EtapasAtendimento', l: 'Etapas do Atendimento', form: 'Assistido (1002)', nome: 'cab_EtapasAtendimento' },
        { k: 'cad.cab_CategoriaVisita', l: 'Categoria da Visita', form: 'Assistido (1002)', nome: 'cab_CategoriaVisita' });
      T.ass.push({ v: lc, cols: cc });
      const lp = { ...id2 }; const cp = [...c2];
      linhaForm(lp, cp, 'Perfil do Assistido (1008)', 'perfil.', F.perfil, basePerfil(a), a.perfil, nomesFotos);
      T.perf.push({ v: lp, cols: cp });
      const la = { ...id2, app_data: dataHora(v.checkin ? v.checkin.em : v.criadoEm) }; const ca = [...c2, fx('app_data', 'Data do atendimento')];
      if (Object.keys(a.acomp).length) linhaForm(la, ca, 'Atendimento (1002)', 'acomp.', F.acomp, baseAcomp(a), a.acomp, nomesFotos);
      T.acomp.push({ v: la, cols: ca });
      const dm = doms[a.cadastro.cab_IdDomicilio];
      const tudoV = { ...lv, ...(dm ? dm.l : {}), ...lc, ...lp, ...la };
      const tudoC = [...cv, ...(dm ? dm.c.slice(colsId.length) : []), ...cc.slice(colsId.length), ...cp.slice(c2.length), ...ca.slice(colsId.length)];
      T.tudo.push({ v: tudoV, cols: tudoC });
    });
  }
  const xlsx = await criarXlsx([
    { nome: 'Tudo (1 linha por assistido)', m: matriz(T.tudo) },
    { nome: 'Visitas', m: matriz(T.vis) },
    { nome: 'Domicílios', m: matriz(T.dom) },
    { nome: 'Assistidos', m: matriz(T.ass) },
    { nome: 'Perfil de Saúde', m: matriz(T.perf) },
    { nome: 'Acompanhamento', m: matriz(T.acomp) },
  ]);
  arqs.unshift({ nome: 'SDE_Contingencia_importacao.xlsx', dados: xlsx });
  const json = { app: 'SDE Contingência', formato: 1, versaoApp: VERSAO, geradoEm: new Date().toISOString(), tecnico: cfg.tecnico, visitas, fotos: fotosIdx };
  arqs.splice(1, 0, { nome: 'dados.json', dados: enc.encode(JSON.stringify(json, null, 1)) });
  arqs.push({ nome: 'LEIA-ME.txt', dados: enc.encode(
    'Exportação do SDE Contingência\r\n\r\n' +
    '- SDE_Contingencia_importacao.xlsx: todas as visitas deste arquivo numa só planilha Excel.\r\n' +
    '  Aba "Tudo": uma linha por assistido, com propriedade, visita, check-in/out, domicílio, cadastro, perfil de saúde e acompanhamento.\r\n' +
    '  As outras abas trazem os mesmos dados separados por formulário do SDE.\r\n' +
    '  Linha 1 = formulário do SDE; linha 2 = pergunta como aparece no SDE; linha 3 = nome interno do campo (cab_..., ate_...). Os dados começam na linha 4.\r\n' +
    '  Respostas de múltipla escolha vêm separadas por " | ". Só aparecem as perguntas que estavam visíveis para cada assistido.\r\n' +
    '- fotos/: check-in, check-out e termos, com data, hora e localização gravadas na imagem.\r\n' +
    '- dados.json: cópia completa. Serve para restaurar em outro aparelho (Ajustes > Importar).\r\n\r\n' +
    'Contém dados pessoais e de saúde. Envie e guarde somente pelos canais autorizados pela coordenação.\r\n') });
  return criarZip(arqs);
}
async function telaExportar() {
  await salvarAgora(); V = null;
  cabecalho('Exportar', cfg.tecnico || '', '#/');
  const todas = await DB.all('visitas');
  const pend = todas.filter(pendenteExport); const and = todas.filter((v) => v.status !== 'finalizada');
  const t = tela(); t.textContent = '';
  t.append(el('div', { class: 'aviso' }, el('strong', {}, 'O arquivo contém dados pessoais e de saúde'),
    'Envie somente pelo canal indicado pela coordenação. Exportar não apaga nada do celular.'));
  const gerar = async (lista, rotulo) => {
    if (!lista.length) return alert('Nada para exportar.');
    carregando('Montando o arquivo…');
    let zip;
    try { zip = await montarExportacao(lista); } catch (e) { fimCarregando(); return alert('Erro ao montar a exportação: ' + (e.message || e)); }
    fimCarregando();
    const d = new Date();
    const nome = `SDE_Contingencia_${seguro(cfg.tecnico) || 'tecnico'}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    const file = new File([zip], nome, { type: 'application/zip' });
    const marcar = async () => {
      const agora = new Date().toISOString();
      for (const v of lista) { const atual = await DB.get('visitas', v.id); if (atual && atual.status === 'finalizada') { atual.exportadoEm = agora; await DB.put('visitas', atual); } }
      const log = (await DB.get('config', 'exportacoes').catch(() => null)) || { k: 'exportacoes', v: [] };
      log.v.unshift({ em: agora, arquivo: nome, visitas: lista.length, tamanho: zip.size }); log.v = log.v.slice(0, 50); await DB.put('config', log);
    };
    const area = $('#resultadoExport'); area.textContent = '';
    const podeCompartilhar = navigator.canShare && navigator.canShare({ files: [file] });
    area.append(card('Arquivo pronto', null, true,
      el('p', { class: 'dica' }, `${nome}\n${(zip.size / 1048576).toFixed(1).replace('.', ',')} MB · ${lista.length} visita(s) · ${rotulo}`),
      el('div', { class: 'linhaBtns' },
        podeCompartilhar ? el('button', { class: 'btn prim', onclick: async () => {
          try { await navigator.share({ files: [file], title: nome }); await marcar(); toast('Exportação concluída'); ir('#/'); } catch (e) { if (e.name !== 'AbortError') alert('Não foi possível compartilhar: ' + e.message + '\nUse "Salvar no aparelho".'); }
        } }, 'Enviar / compartilhar') : null,
        el('button', { class: 'btn' + (podeCompartilhar ? '' : ' prim'), onclick: async () => {
          const u = URL.createObjectURL(file); const a = el('a', { href: u, download: nome }); document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 60000); await marcar(); toast('Arquivo salvo em Downloads/Arquivos');
        } }, 'Salvar no aparelho'))));
    area.scrollIntoView({ behavior: 'smooth' });
  };
  t.append(card('Visitas finalizadas', null, false,
    el('p', { class: 'dica' }, pend.length ? `${pend.length} visita(s) finalizada(s) ainda não exportada(s).` : 'Nenhuma visita finalizada pendente.'),
    el('button', { class: 'btn ok grande', disabled: !pend.length || null, onclick: () => gerar(pend, 'finalizadas pendentes') }, 'Gerar arquivo')));
  t.append(card('Cópia de segurança completa', null, false,
    el('p', { class: 'dica' }, `Todas as ${todas.length} visita(s) do aparelho, inclusive ${and.length} em andamento. Use para backup ou para passar para outro celular. Visitas em andamento não são marcadas como exportadas.`),
    el('button', { class: 'btn grande', disabled: !todas.length || null, onclick: () => gerar(todas, 'cópia completa') }, 'Gerar cópia completa')));
  t.append(el('div', { id: 'resultadoExport' }));
  const log = await DB.get('config', 'exportacoes').catch(() => null);
  if (log && log.v.length) t.append(el('details', { class: 'grupo card' }, el('summary', {}, 'Histórico de exportações'),
    el('ul', { class: 'pequeno' }, log.v.map((x) => el('li', {}, `${dataHora(x.em)} — ${x.visitas} visita(s) — ${x.arquivo}`)))));
}

/* ============ ajustes, backup e importação ============ */
async function telaAjustes() {
  await salvarAgora(); V = null;
  cabecalho('Ajustes e backup', '', '#/');
  const t = tela(); t.textContent = '';
  const dadosCfg = cfg;
  t.append(card('Técnico', null, !!cfg.tecnico, formulario([{ k: 'tecnico', l: 'Seu nome', t: 'text', req: true }, { k: 'uf', l: 'UF de atuação', t: 'sel', o: UFS }],
    dadosCfg, () => dadosCfg, () => { clearTimeout(telaAjustes.t); telaAjustes.t = setTimeout(() => salvarCfg().then(() => statusSalvo('Salvo ' + horaAgora())), 300); })));
  const arm = el('div', {}, el('p', { class: 'dica' }, 'Verificando…'));
  t.append(card('Armazenamento no aparelho', null, false, arm));
  (async () => {
    arm.textContent = '';
    let persist = null; try { persist = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* */ }
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      const usado = e.usage || 0, cota = e.quota || 0;
      arm.append(el('div', {}, `Usado: ${(usado / 1048576).toFixed(1)} MB${cota ? ` de ${(cota / 1048576 / 1024).toFixed(1)} GB disponíveis para o app` : ''}`),
        cota ? el('div', { class: 'barra' }, el('i', { style: `width:${Math.min(100, (usado / cota) * 100).toFixed(1)}%` })) : '');
    }
    arm.append(el('p', { class: 'dica', style: 'margin-top:8px' }, persist === true ? '✓ Dados protegidos contra limpeza automática do navegador.'
      : persist === false ? 'O navegador ainda não garantiu a proteção dos dados contra limpeza automática. Instale o app e toque abaixo.' : 'Este navegador não informa a proteção dos dados.'),
    persist === false ? el('button', { class: 'btn', onclick: async () => { persistPedido = false; await pedirPersistencia(); telaAjustes(); } }, 'Proteger dados') : '',
    el('p', { class: 'dica' }, 'Nunca use "Limpar dados do site" ou "Limpar cache" no navegador: isso apaga as visitas que ainda não foram exportadas.'));
  })();
  t.append(card('Importar cópia', null, false,
    el('p', { class: 'dica' }, 'Restaura um arquivo .zip exportado por este app (de outro celular ou backup). Visitas que já existem só são substituídas se a cópia for mais recente.'),
    el('button', { class: 'btn', onclick: () => { const i = $('#importar'); i.value = ''; i.onchange = () => i.files[0] && importar(i.files[0]); i.click(); } }, 'Escolher arquivo…')));
  t.append(card('Sobre', null, false, el('p', { class: 'dica' }, `SDE Contingência ${VERSAO}. Registro offline usado enquanto o SDE Saúde no Campo está indisponível. ` +
    'Os dados não são enviados a nenhum servidor: saem apenas pelos arquivos exportados. Quando o SDE voltar, os registros devem ser lançados nele.')));
}
async function importar(file) {
  carregando('Lendo arquivo…');
  try {
    const buf = await file.arrayBuffer();
    let json, arqs = {};
    if (/\.json$/i.test(file.name) || new Uint8Array(buf)[0] === 0x7b) json = JSON.parse(new TextDecoder().decode(buf));
    else { arqs = await lerZip(buf); if (!arqs['dados.json']) throw new Error('o ZIP não tem dados.json'); json = JSON.parse(new TextDecoder().decode(arqs['dados.json'])); }
    if (!json || json.app !== 'SDE Contingência' || !Array.isArray(json.visitas)) throw new Error('arquivo não foi gerado pelo SDE Contingência');
    let novas = 0, atual = 0, iguais = 0, fotos = 0;
    for (const v of json.visitas) {
      if (!v || !v.id || !v.propriedade) continue;
      const ex = await DB.get('visitas', v.id);
      if (!ex) { await DB.put('visitas', v); novas++; } else if ((v.atualizadoEm || '') > (ex.atualizadoEm || '')) { await DB.put('visitas', v); atual++; } else iguais++;
    }
    for (const f of json.fotos || []) {
      const b = arqs[f.arquivo]; if (!b || (await DB.get('fotos', f.id))) continue;
      await DB.put('fotos', { id: f.id, visitaId: f.visitaId, tipo: f.tipo, buf: b.slice().buffer, type: 'image/jpeg', criadoEm: new Date().toISOString() }); fotos++;
    }
    fimCarregando();
    alert(`Importação concluída.\n\nNovas: ${novas}\nAtualizadas: ${atual}\nSem mudança: ${iguais}\nFotos: ${fotos}`);
    ir('#/');
  } catch (e) { fimCarregando(); alert('Não foi possível importar: ' + (e.message || e)); }
}

/* ============ atualização do app (nunca recarrega sozinho) ============ */
let aplicando = false;
function aplicarAtualizacao() {
  if (!swEsperando) return;
  salvarAgora().then((ok) => { if (!ok) return; aplicando = true; swEsperando.postMessage('aplicar'); });
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ver = () => { if (reg.waiting && navigator.serviceWorker.controller) { swEsperando = reg.waiting; if (rotaAtual === '') render(); } };
    ver();
    reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') ver(); }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (aplicando) { aplicando = false; location.reload(); } });
}

/* ============ rotas ============ */
let rotaAtual = '';
async function render() {
  const h = location.hash.replace(/^#\/?/, '');
  rotaAtual = h;
  const p = h.split('/');
  try {
    if (p[0] === 'v' && p[1]) {
      if (!V || V.id !== p[1]) { await salvarAgora(); V = await DB.get('visitas', p[1]); }
      if (!V) { toast('Visita não encontrada'); return ir('#/'); }
      if (!p[2]) telaVisita();
      else if (p[2] === 'prop') telaProp();
      else if (p[2] === 'visita') telaDadosVisita();
      else if (p[2] === 'dom') telaDomicilio(p[3]);
      else if (p[2] === 'ass') telaAssistido(p[3], p[4]);
      else ir('#/v/' + V.id);
    } else if (p[0] === 'exportar') await telaExportar();
    else if (p[0] === 'ajustes') await telaAjustes();
    else { await salvarAgora(); await telaInicio(); }
  } catch (e) {
    console.error(e);
    tela().textContent = '';
    tela().append(el('div', { class: 'aviso erro' }, el('strong', {}, 'Erro ao abrir esta tela'), String(e && e.message ? e.message : e), el('br'),
      'Seus dados continuam guardados. ', el('a', { href: '#/' }, 'Voltar ao início')));
  }
}
window.addEventListener('hashchange', () => { salvarAgora().then(() => { window.scrollTo(0, 0); render(); }); });

(async function iniciar() {
  try {
    if (!window.indexedDB) throw new Error('Este navegador não permite guardar dados offline (modo anônimo?). Use o Chrome no Android ou o Safari no iPhone, fora do modo privado.');
    await DB.abrir(); await carregarCfg();
    render();
  } catch (e) {
    tela().textContent = '';
    tela().append(el('div', { class: 'aviso erro' }, el('strong', {}, 'Não foi possível abrir o armazenamento do aparelho'), String(e && e.message ? e.message : e)));
  }
})();
