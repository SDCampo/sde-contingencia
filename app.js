'use strict';
/* SDE Contingência — registro offline de visitas quando o SDE Saúde no Campo está fora do ar.
   Os dados ficam só no aparelho (IndexedDB) e saem por exportação (ZIP com JSON, CSV e fotos). */
const VERSAO = '1.0.0';

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
const vazio = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
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
const TEMPO = ['Menos de 6 meses', '6 meses a 1 ano', '1 a 2 anos', 'Mais de 2 anos', 'Nunca', 'Não lembra'];
const CONDICOES = ['Hipertensão (pressão alta)', 'Diabetes tipo 1', 'Diabetes tipo 2', 'Colesterol / triglicerídeos altos', 'Obesidade',
  'Asma', 'DPOC / bronquite crônica', 'Alergias respiratórias / rinite', 'Angina / infarto prévio', 'Arritmia', 'Insuficiência cardíaca',
  'AVC / AIT (derrame)', 'Doença renal crônica', 'Hipotireoidismo', 'Hipertireoidismo', 'Câncer (especificar em outras)', 'Câncer de pele',
  'Lesões ou pintas suspeitas na pele', 'Depressão', 'Ansiedade', 'Outro transtorno mental', 'Alzheimer / demência', 'Epilepsia',
  'Artrite reumatoide', 'Artrose', 'Dor crônica na coluna', 'LER/DORT, bursite, tendinite', 'Osteoporose', 'Anemia', 'Hepatite',
  'HIV', 'Tuberculose', 'Doença de Chagas', 'Hanseníase', 'Intoxicação por agrotóxico (histórico)', 'Deficiência física',
  'Deficiência auditiva', 'Deficiência visual', 'Deficiência intelectual'];
const SIM_NAO_NS = ['Sim', 'Não', 'Não sabe'];

const idadeDe = (o) => idade(o.cab_DataNascimento);
const mulher = (o) => o.cab_Sexo === 'Feminino';
function imc(o) {
  const p = num(o.cab_Peso); let a = num(o.cab_Altura);
  if (!p || !a) return '';
  if (a > 3) a /= 100;
  const v = p / (a * a);
  if (!isFinite(v) || v < 8 || v > 90) return 'Confira peso e altura';
  const i = idadeDe(o);
  const cls = i != null && i < 20 ? 'abaixo de 20 anos: avaliar pela curva de crescimento' : v < 18.5 ? 'baixo peso' : v < 25 ? 'adequado' : v < 30 ? 'sobrepeso' : 'obesidade';
  return `${v.toFixed(1).replace('.', ',')} — ${cls}`;
}

/* Campos. "k" usa o nome do campo no SDE (cab_…) quando existe, para facilitar o lançamento depois. */
const F = {
  propriedade: [
    { t: 'titulo', l: 'Identificação da propriedade' },
    { k: 'cab_IdATeG', l: 'ID da propriedade (ATeG)', t: 'text', req: true, modo: 'numeric' },
    { k: 'cab_NomePropriedade', l: 'Nome da propriedade', t: 'text', req: true },
    { k: 'cab_IdPropriedade', l: 'ID da propriedade no SDE (se souber)', t: 'text', modo: 'numeric' },
    { k: 'cab_Municipio', l: 'Município', t: 'text' },
    { k: 'cab_Estado', l: 'UF', t: 'sel', o: UFS },
    { k: 'cab_NomeProdutor', l: 'Nome do produtor', t: 'text' },
    { k: 'cab_TelefoneProdutor', l: 'Telefone do produtor', t: 'tel' },
  ],
  visita: [
    { t: 'titulo', l: 'Dados da visita' },
    { k: 'cab_CategoriaVisita', l: 'Tipo de visita', t: 'sel', o: ['Visita acompanhada', 'Visita não acompanhada'], req: true },
    { k: 'cab_QuantidadePessoasVisita', l: 'Pessoas presentes na visita', t: 'num' },
    { k: 'cab_ProdutorResponsavelAtendido', l: 'O produtor responsável foi atendido?', t: 'sn' },
    { t: 'titulo', l: 'Estrutura da propriedade' },
    { k: 'cab_PropriedadePossuiDomicilio', l: 'A propriedade possui domicílio?', t: 'sn' },
    { k: 'cab_QtdDomiciliosPropriedade', l: 'Quantidade de domicílios', t: 'num', se: (o) => o.cab_PropriedadePossuiDomicilio === 'Sim' },
    { k: 'cab_QtdPessoasTrabalhamPropriedade', l: 'Pessoas que trabalham na propriedade', t: 'num' },
    { k: 'cab_AtividadeProdutiva', l: 'Atividade produtiva principal', t: 'text', ph: 'Ex.: café, leite, hortaliças' },
    { k: 'cab_PropriedadePossuiEnergia', l: 'Possui energia elétrica?', t: 'sn' },
    { k: 'cab_PropriedadePossuiAcessoInternet', l: 'Possui acesso à internet?', t: 'sn' },
    { t: 'titulo', l: 'Acesso e rede de saúde' },
    { k: 'cab_TipoAcessoPropriedadeRural', l: 'Tipo de acesso', t: 'sel', o: ['Estrada asfaltada', 'Estrada de terra', 'Trilha', 'Fluvial', 'Outro'] },
    { k: 'cab_GrauDificuldadeAcessoPropriedadeRural', l: 'Dificuldade de acesso', t: 'sel', o: ['Fácil', 'Moderada', 'Difícil'] },
    { k: 'cab_NomeUBS', l: 'UBS de referência', t: 'text' },
    { k: 'cab_DistanciaUBSPropriedade', l: 'Distância até a UBS (km)', t: 'num', dec: true },
    { k: 'cab_DentroAreaAbrangeciaESF', l: 'Dentro da área de abrangência da ESF?', t: 'sel', o: SIM_NAO_NS },
    { t: 'titulo', l: 'Análise de risco sanitário' },
    { k: 'cab_PrincipalFonteAbastecimento', l: 'Principal fonte de água', t: 'sel', o: AGUA },
    { k: 'cab_PrincipalDestinoLixoPropriedade', l: 'Principal destino do lixo', t: 'sel', o: LIXO },
    { k: 'cab_AreasAlagadasBrejosAguaParada', l: 'Áreas alagadas, brejos ou água parada?', t: 'sn' },
    { k: 'cab_EstruturasAbandonadas', l: 'Estruturas abandonadas?', t: 'sn' },
    { k: 'cab_CercasEntreMoradiaCultivoAnimais', l: 'Há cercas entre moradia, cultivo e animais?', t: 'sn' },
    { k: 'cab_RegistroZoonoses', l: 'Registro de zoonoses?', t: 'sn' },
    { k: 'cab_PrincipaisRiscosAssociadosTrabalhoDiario', l: 'Principais riscos do trabalho', t: 'multi', o: RISCOS },
    { t: 'titulo', l: 'Encerramento' },
    { k: 'cab_BreveResumoVisita', l: 'Breve resumo da visita', t: 'area' },
    { k: 'cab_PrevisaoProximaVisitaData', l: 'Previsão da próxima visita', t: 'date' },
    { k: 'cab_PrevisaoProximaVisitaHoraInicio', l: 'Horário previsto', t: 'time' },
  ],
  domicilio: [
    { k: 'cab_NomeDomicilio', l: 'Identificação do domicílio', t: 'text', req: true, ph: 'Ex.: Casa sede, Casa do caseiro' },
    { k: 'cab_NomeResponsavel', l: 'Responsável pelo domicílio', t: 'text' },
    { k: 'cab_RelacaoResponsavelPropriedade', l: 'Relação do responsável com a propriedade', t: 'sel', o: ['Proprietário', 'Familiar do proprietário', 'Arrendatário', 'Funcionário', 'Outro'] },
    { k: 'moradores', l: 'Número de moradores', t: 'num' },
    { k: 'cab_PrincipalFonteAbastecimento', l: 'Fonte de água do domicílio', t: 'sel', o: AGUA },
    { k: 'agua_tratamento', l: 'Tratamento da água para beber', t: 'sel', o: ['Filtrada', 'Fervida', 'Clorada', 'Mineral', 'Sem tratamento'] },
    { k: 'cab_ExpostoFumaca', l: 'Moradores expostos a fumaça (fogão a lenha, queimadas)?', t: 'sn' },
    { k: 'cab_ArmazenaMedicamentoAdequeadamente', l: 'Armazena medicamentos adequadamente?', t: 'sn' },
    { k: 'agrotoxico_casa', l: 'Agrotóxicos guardados dentro ou perto da casa?', t: 'sn' },
    { k: 'cab_ValidacaoDescarteLixoDistanciaSeguraDomi', l: 'Lixo descartado a distância segura do domicílio?', t: 'sn' },
    { k: 'obs', l: 'Observações', t: 'area' },
  ],
  cadastro: [
    { k: 'cab_NomeCompleto', l: 'Nome completo', t: 'text', req: true },
    { k: 'cab_NomeSocial', l: 'Nome social', t: 'text' },
    { k: 'cab_DataNascimento', l: 'Data de nascimento', t: 'date', req: true },
    { k: '_idade', l: 'Idade', t: 'calc', calc: (o) => { const i = idadeDe(o); return i == null ? '' : i + (i === 1 ? ' ano' : ' anos'); } },
    { k: 'cab_Sexo', l: 'Sexo', t: 'sel', o: ['Feminino', 'Masculino'], req: true },
    { k: 'cab_Raca', l: 'Raça/cor', t: 'sel', o: ['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena', 'Não declarada'] },
    { k: 'cab_CPF', l: 'CPF', t: 'text', modo: 'numeric' },
    { k: 'cns', l: 'Cartão Nacional de Saúde (CNS)', t: 'text', modo: 'numeric' },
    { k: 'cab_NomeMae', l: 'Nome da mãe', t: 'text' },
    { k: 'cab_TelefonePessoal', l: 'Telefone', t: 'tel' },
    { k: 'cab_IdDomicilio', l: 'Domicílio', t: 'sel', o: (vis) => ((vis || V || {}).domicilios || []).map((d) => ({ v: d.id, l: d.cab_NomeDomicilio || '(domicílio sem nome)' })) },
    { k: 'vinculo', l: 'Vínculo com a propriedade', t: 'sel', o: ['Produtor responsável', 'Familiar', 'Funcionário', 'Familiar de funcionário', 'Outro'] },
    { k: 'cab_SabeLerEscrever', l: 'Sabe ler e escrever?', t: 'sn', se: (o) => { const i = idadeDe(o); return i == null || i >= 6; } },
    { k: 'cab_FrequentaEscolaCreche', l: 'Frequenta escola ou creche?', t: 'sn', se: (o) => { const i = idadeDe(o); return i != null && i < 18; } },
    { k: 'cab_AceitePrograma', l: 'Aceitou participar do programa?', t: 'sn', req: true },
    { k: 'termo', l: 'Foto do termo de aceite (opcional)', t: 'foto', se: (o) => o.cab_AceitePrograma === 'Sim' },
  ],
  perfil: [
    { t: 'titulo', l: 'Condições de saúde' },
    { k: 'cab_PossuiDoencaLongaDuracao', l: 'Possui doença de longa duração?', t: 'sn' },
    { k: 'condicoes', l: 'Condições / doenças', t: 'multi', o: CONDICOES, busca: true, se: (o) => o.cab_PossuiDoencaLongaDuracao === 'Sim' },
    { k: 'condicoes_outras', l: 'Outras condições (descrever)', t: 'text', se: (o) => o.cab_PossuiDoencaLongaDuracao === 'Sim' },
    { k: 'alergias', l: 'Alergias (medicamentos, alimentos, outras)', t: 'text' },
    { t: 'titulo', l: 'Medicações' },
    { k: 'cab_MedicacaoUsoContinuoPrescritoProfissiona', l: 'Usa medicação contínua prescrita?', t: 'sn' },
    { k: 'medicacoes', l: 'Quais medicações (nome e dose)', t: 'area', se: (o) => o.cab_MedicacaoUsoContinuoPrescritoProfissiona === 'Sim' },
    { k: 'cab_UsoMedicacaoConformeOrientado', l: 'Usa conforme orientado?', t: 'sel', o: ['Sim', 'Não', 'Às vezes'], se: (o) => o.cab_MedicacaoUsoContinuoPrescritoProfissiona === 'Sim' },
    { t: 'titulo', l: 'Acesso à saúde' },
    { k: 'cab_UltimaConsultaComMedico', l: 'Última consulta com médico', t: 'sel', o: TEMPO },
    { k: 'cab_UltimaConsultaComDentista', l: 'Última consulta com dentista', t: 'sel', o: TEMPO },
    { t: 'titulo', l: 'Hábitos e estilo de vida' },
    { k: 'tabagismo', l: 'Fuma ou usa tabaco?', t: 'sel', o: ['Nunca fumou', 'Fuma atualmente', 'Ex-fumante'] },
    { k: 'cab_PrentendeParaFumarProtocoloTabagismo', l: 'Pretende parar de fumar?', t: 'sn', se: (o) => o.tabagismo === 'Fuma atualmente' },
    { k: 'cab_FumaAmbienteFechadoProtocoloTabagismo', l: 'Fuma em ambiente fechado?', t: 'sn', se: (o) => o.tabagismo === 'Fuma atualmente' },
    { k: 'cab_UsoBebidaAlcoolica', l: 'Consumo de bebida alcoólica', t: 'sel', o: ['Não bebe', 'Raramente', '1 a 2 vezes por semana', '3 ou mais vezes por semana', 'Diariamente'] },
    { k: 'cab_UtilizaDrogas', l: 'Utiliza outras drogas?', t: 'sel', o: ['Não', 'Sim', 'Prefere não responder'] },
    { k: 'cab_PraticaAtividadeFisica', l: 'Pratica atividade física (além do trabalho)?', t: 'sn' },
    { k: 'cab_AvaliaAlimentacao', l: 'Como avalia a própria alimentação', t: 'sel', o: ['Boa', 'Regular', 'Ruim'] },
    { k: 'cab_ConsideraDormiuBem', l: 'Considera que dorme bem?', t: 'sn' },
    { k: 'cab_EquilibraTrabalhoTarefasDescanso', l: 'Equilibra trabalho, tarefas e descanso?', t: 'sn' },
    { k: 'cab_FrequenciaHigieneBucal', l: 'Escovação dos dentes por dia', t: 'sel', o: ['Nenhuma', '1 vez', '2 vezes', '3 ou mais vezes'] },
    { t: 'titulo', l: 'Saúde do trabalhador', se: (o) => { const i = idadeDe(o); return i == null || i >= 14; } },
    { k: 'usa_epi', l: 'Usa EPI com agrotóxicos e máquinas?', t: 'sel', o: ['Sempre', 'Às vezes', 'Nunca', 'Não se aplica'], se: (o) => { const i = idadeDe(o); return i == null || i >= 14; } },
    { k: 'protecao_solar', l: 'Usa proteção solar no trabalho?', t: 'sel', o: ['Sempre', 'Às vezes', 'Nunca', 'Não se aplica'], se: (o) => { const i = idadeDe(o); return i == null || i >= 14; } },
    { t: 'titulo', l: 'Saúde da criança', se: (o) => { const i = idadeDe(o); return i != null && i < 12; } },
    { k: 'cab_CartaoVacinaApresentadoLCSaudeCrianca', l: 'Cartão de vacina apresentado?', t: 'sn', se: (o) => { const i = idadeDe(o); return i != null && i < 12; } },
    { k: 'cab_RecebeuTodasVacinasLCSaudeCrianca', l: 'Vacinas em dia?', t: 'sel', o: SIM_NAO_NS, se: (o) => { const i = idadeDe(o); return i != null && i < 12; } },
    { t: 'titulo', l: 'Saúde da mulher', se: (o) => mulher(o) && (idadeDe(o) == null || idadeDe(o) >= 10) },
    { k: 'gestante', l: 'Está gestante?', t: 'sel', o: ['Não', 'Sim', 'Não sabe'], se: (o) => mulher(o) && (idadeDe(o) == null || (idadeDe(o) >= 10 && idadeDe(o) <= 55)) },
    { k: 'pre_natal', l: 'Faz pré-natal?', t: 'sn', se: (o) => mulher(o) && o.gestante === 'Sim' },
    { k: 'preventivo', l: 'Último exame preventivo (Papanicolau)', t: 'sel', o: TEMPO, se: (o) => mulher(o) && (idadeDe(o) == null || idadeDe(o) >= 25) },
    { k: 'mamografia', l: 'Última mamografia', t: 'sel', o: TEMPO, se: (o) => mulher(o) && (idadeDe(o) == null || idadeDe(o) >= 40) },
    { t: 'titulo', l: 'Observações' },
    { k: 'obs_perfil', l: 'Observações do perfil de saúde', t: 'area' },
  ],
  acomp: [
    { t: 'titulo', l: 'Medidas' },
    { k: 'cab_Peso', l: 'Peso (kg)', t: 'num', dec: true },
    { k: 'cab_Altura', l: 'Altura (cm)', t: 'num', dec: true },
    { k: 'cab_IMC', l: 'IMC', t: 'calc', calc: imc },
    { k: 'cab_PressaoArterialSistolica', l: 'Pressão sistólica (mmHg)', t: 'num' },
    { k: 'cab_PressaoArterialDiastolica', l: 'Pressão diastólica (mmHg)', t: 'num' },
    { k: 'fc', l: 'Frequência cardíaca (bpm)', t: 'num' },
    { k: 'glicemia', l: 'Glicemia capilar (mg/dL)', t: 'num' },
    { k: 'glicemia_jejum', l: 'Glicemia em jejum?', t: 'sn', se: (o) => !vazio(o.glicemia) },
    { k: 'circ_abdominal', l: 'Circunferência abdominal (cm)', t: 'num', dec: true },
    { t: 'titulo', l: 'Atendimento' },
    { k: 'queixas', l: 'Queixas / situação atual', t: 'area' },
    { k: 'orientacoes', l: 'Orientações e condutas', t: 'area' },
    { k: 'cab_encaminhar_especialista', l: 'Precisa de encaminhamento?', t: 'sn' },
    { k: 'encaminhamento', l: 'Para onde / qual especialidade', t: 'text', se: (o) => o.cab_encaminhar_especialista === 'Sim' },
    { k: 'urgente', l: 'Situação de urgência identificada?', t: 'sn' },
    { k: 'urgente_desc', l: 'O que foi identificado e o que foi feito', t: 'area', se: (o) => o.urgente === 'Sim' },
  ],
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
function formulario(schema, dados, ctx, aoMudar) {
  const wrap = el('div', { class: 'form' }); const itens = [];
  const atualizar = () => {
    const c = ctx();
    for (const { f, node } of itens) {
      if (f.se) node.hidden = !f.se(c);
      if (f.t === 'calc') node.querySelector('.calc').textContent = f.calc(c) || '—';
    }
  };
  for (const f of schema) {
    const node = f.t === 'titulo' ? el('h3', { class: 'sec' }, f.l) : campo(f, dados, () => { aoMudar(); atualizar(); }, V && V.id);
    if (f.k) node.dataset.k = f.k;
    itens.push({ f, node }); wrap.append(node);
  }
  atualizar();
  return el('div', {}, bloqueada() ? el('div', { class: 'aviso info' }, 'Visita finalizada: somente leitura. Para corrigir, volte à visita e toque em "Reabrir para corrigir".') : null,
    el('fieldset', { disabled: bloqueada() || null }, wrap));
}
function faltando(schema, dados, ctx) {
  const c = ctx ? ctx() : dados;
  return schema.filter((f) => f.req && (!f.se || f.se(c)) && vazio(dados[f.k])).map((f) => f.l);
}
function marcarFaltando(raiz, schema, dados, ctx) {
  const c = ctx ? ctx() : dados;
  for (const f of schema) if (f.req && (!f.se || f.se(c)) && vazio(dados[f.k])) { const n = raiz.querySelector(`[data-k="${f.k}"]`); if (n) n.classList.add('faltando'); }
}

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
  const ctx = () => ({ ...a.cadastro, ...a.perfil, ...a.acomp });
  return {
    cad: faltando(F.cadastro, a.cadastro, ctx).length === 0,
    perfil: Object.keys(a.perfil).length > 0,
    acomp: Object.keys(a.acomp).length > 0,
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
  const doms = V.domicilios.map((d) => el('button', { class: 'item', onclick: () => ir(`#/v/${V.id}/dom/${d.id}`) },
    el('div', { class: 'txt' }, el('strong', {}, d.cab_NomeDomicilio || '(domicílio sem nome)'),
      el('small', {}, [d.cab_NomeResponsavel, d.moradores ? d.moradores + ' morador(es)' : null].filter(Boolean).join(' · ') || 'toque para preencher')), el('span', { class: 'seta' }, '›')));
  t.append(card('Domicílios', 3, V.domicilios.length > 0, doms.length ? doms : el('p', { class: 'dica' }, 'Nenhum domicílio cadastrado.'),
    el('button', { class: 'btn', disabled: bloqueada() || null, onclick: novoDomicilio }, '+ Adicionar domicílio')));
  const ass = V.assistidos.map((a) => {
    const s = situacaoAssistido(a); const i = idadeDe(a.cadastro); const dom = V.domicilios.find((d) => d.id === a.cadastro.cab_IdDomicilio);
    return el('button', { class: 'item', onclick: () => ir(`#/v/${V.id}/ass/${a.id}`) },
      el('div', { class: 'txt' }, el('strong', {}, nomeAssistido(a)),
        el('small', {}, [i != null ? i + ' anos' : null, a.cadastro.cab_Sexo, dom ? dom.cab_NomeDomicilio : null].filter(Boolean).join(' · ') || 'toque para preencher'),
        el('div', { class: 'chips' }, el('span', { class: 'chip ' + (s.cad ? 'ok' : 'al') }, 'cadastro'), el('span', { class: 'chip ' + (s.perfil ? 'ok' : '') }, 'perfil de saúde'),
          el('span', { class: 'chip ' + (s.acomp ? 'ok' : '') }, 'acompanhamento'))), el('span', { class: 'seta' }, '›'));
  });
  t.append(card('Assistidos', 4, V.assistidos.length > 0 && V.assistidos.every((a) => situacaoAssistido(a).cad), ass.length ? ass : el('p', { class: 'dica' }, 'Nenhum assistido cadastrado.'),
    el('button', { class: 'btn', disabled: bloqueada() || null, onclick: novoAssistido }, '+ Adicionar assistido')));
  const visOk = faltando(F.visita, V.visita).length === 0;
  t.append(card('Dados da visita', 5, visOk, el('p', { class: 'dica' }, V.visita.cab_CategoriaVisita || 'Tipo de visita, estrutura, risco sanitário e resumo.'),
    el('div', { class: 'linhaBtns' }, el('button', { class: 'btn' + (visOk ? '' : ' prim'), onclick: () => ir(`#/v/${V.id}/visita`) }, visOk ? 'Ver / editar' : 'Preencher'))));
  t.append(blocoPonto('checkout', 6));
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
  cabecalho('Dados da visita', V.propriedade.cab_NomePropriedade || '', '#/v/' + V.id);
  const t = tela(); t.textContent = '';
  t.append(el('div', { class: 'card' }, formulario(F.visita, V.visita, () => V.visita, mudou)), rodapeConcluir('#/v/' + V.id));
}
function novoDomicilio() {
  const d = { id: uid(), criadoEm: new Date().toISOString() };
  V.domicilios.push(d); mudou(); ir(`#/v/${V.id}/dom/${d.id}`);
}
function telaDomicilio(did) {
  const d = V.domicilios.find((x) => x.id === did);
  if (!d) return ir('#/v/' + V.id);
  cabecalho('Domicílio', d.cab_NomeDomicilio || V.propriedade.cab_NomePropriedade || '', '#/v/' + V.id);
  const t = tela(); t.textContent = '';
  t.append(el('div', { class: 'card' }, formulario(F.domicilio, d, () => d, () => { mudou(); $('#subtitulo').textContent = d.cab_NomeDomicilio || ''; })),
    rodapeConcluir('#/v/' + V.id, bloqueada() ? null : el('button', { class: 'btn perigo', onclick: () => {
      const n = V.assistidos.filter((a) => a.cadastro.cab_IdDomicilio === did).length;
      if (!confirm(`Excluir este domicílio?${n ? `\n${n} assistido(s) ficarão sem domicílio.` : ''}`)) return;
      V.domicilios = V.domicilios.filter((x) => x.id !== did);
      V.assistidos.forEach((a) => { if (a.cadastro.cab_IdDomicilio === did) delete a.cadastro.cab_IdDomicilio; });
      mudou(); ir('#/v/' + V.id);
    } }, 'Excluir')));
}
function novoAssistido() {
  const a = { id: uid(), criadoEm: new Date().toISOString(), cadastro: {}, perfil: {}, acomp: {} };
  if (V.domicilios.length === 1) a.cadastro.cab_IdDomicilio = V.domicilios[0].id;
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
  const ctx = () => ({ ...a.cadastro, ...a.perfil, ...a.acomp });
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
  for (const x of faltando(F.visita, V.visita)) av.push('Dados da visita: ' + x);
  V.domicilios.forEach((d, i) => faltando(F.domicilio, d).forEach((x) => av.push(`Domicílio ${i + 1}: ${x}`)));
  V.assistidos.forEach((a) => {
    const ctx = () => ({ ...a.cadastro, ...a.perfil, ...a.acomp });
    faltando(F.cadastro, a.cadastro, ctx).forEach((x) => av.push(`${nomeAssistido(a)}: ${x}`));
    if (!Object.keys(a.perfil).length) av.push(`${nomeAssistido(a)}: perfil de saúde vazio`);
  });
  if (!V.assistidos.length) av.push('Nenhum assistido cadastrado');
  if (V.checkin.geoErro || V.checkout.geoErro) av.push('Check-in ou check-out sem localização');
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
function valorCSV(f, v, c, vis) {
  if (f.t === 'calc') return f.calc(c);
  if (vazio(v)) return '';
  if (f.t === 'date') return dataBR(v);
  if (f.t === 'multi') return v.join(' | ');
  if (f.t === 'sel' && typeof f.o === 'function') { const o = opcoes(f, vis).find((x) => x.v === v); return o ? o.l : v; }
  return v;
}
function colunas(schema, pref) { return schema.filter((f) => f.t !== 'titulo').map((f) => ({ k: pref + f.k, l: f.l, f })); }
function preencher(linha, schema, pref, dados, ctx, nomesFotos, vis) {
  for (const f of schema) if (f.t !== 'titulo') linha[pref + f.k] = f.t === 'foto' ? (nomesFotos[dados[f.k]] || '') : valorCSV(f, dados[f.k], ctx, vis);
}
function csv(linhas, cols) {
  const esc = (v) => { v = v == null ? '' : String(v); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return '﻿' + [cols.map((c) => esc(c.l)).join(';'), ...linhas.map((r) => cols.map((c) => esc(r[c.k])).join(';'))].join('\r\n') + '\r\n';
}
function colsPonto(tipo, n) {
  return [['em', `${n} — data e hora`], ['lat', `${n} — latitude`], ['lng', `${n} — longitude`], ['precisao', `${n} — precisão (m)`], ['geoErro', `${n} — problema de localização`], ['foto', `${n} — arquivo da foto`]]
    .map(([k, l]) => ({ k: tipo + '.' + k, l }));
}
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
  const lV = [], lD = [], lA = [], lP = [], lC = [];
  for (const v of visitas) {
    const p = v.propriedade;
    const base = { 'visita.id': v.id, 'ateg': p.cab_IdATeG || '', 'propriedade': p.cab_NomePropriedade || '' };
    const lin = { ...base, status: v.status === 'finalizada' ? 'Finalizada' : 'Em andamento', tecnico: v.tecnico, criadoEm: dataHora(v.criadoEm), finalizadaEm: dataHora(v.finalizadaEm),
      qtdDom: v.domicilios.length, qtdAss: v.assistidos.length };
    preencher(lin, F.propriedade, 'p.', p, p, nomesFotos);
    preencher(lin, F.visita, 'v.', v.visita, v.visita, nomesFotos);
    for (const tipo of ['checkin', 'checkout']) {
      const pt = v[tipo] || {};
      Object.assign(lin, { [tipo + '.em']: dataHora(pt.em, true), [tipo + '.lat']: pt.lat != null ? pt.lat.toFixed(6) : '', [tipo + '.lng']: pt.lng != null ? pt.lng.toFixed(6) : '',
        [tipo + '.precisao']: pt.precisao != null ? pt.precisao : '', [tipo + '.geoErro']: pt.geoErro || '', [tipo + '.foto']: nomesFotos[pt.fotoId] || '' });
    }
    lin.duracao = v.checkin && v.checkout ? Math.round((new Date(v.checkout.em) - new Date(v.checkin.em)) / 60000) : '';
    lV.push(lin);
    v.domicilios.forEach((d) => { const l = { ...base, 'dom.id': d.id }; preencher(l, F.domicilio, 'd.', d, d, nomesFotos); lD.push(l); });
    v.assistidos.forEach((a) => {
      const ctx = { ...a.cadastro, ...a.perfil, ...a.acomp };
      const b2 = { ...base, 'ass.id': a.id, 'ass.nome': a.cadastro.cab_NomeCompleto || '' };
      const lc = { ...b2 }; preencher(lc, F.cadastro, 'c.', a.cadastro, ctx, nomesFotos, v); lA.push(lc);
      const lp = { ...b2 }; preencher(lp, F.perfil, 'pf.', a.perfil, ctx, nomesFotos); lP.push(lp);
      const la = { ...b2, 'ac.data': dataHora(v.checkin ? v.checkin.em : v.criadoEm) }; preencher(la, F.acomp, 'ac.', a.acomp, ctx, nomesFotos); lC.push(la);
    });
  }
  const cBase = [{ k: 'visita.id', l: 'ID da visita (app)' }, { k: 'ateg', l: 'ID ATeG' }, { k: 'propriedade', l: 'Propriedade' }];
  const cAss = [...cBase, { k: 'ass.id', l: 'ID do assistido (app)' }, { k: 'ass.nome', l: 'Nome do assistido' }];
  const cV = [...cBase, { k: 'status', l: 'Situação' }, { k: 'tecnico', l: 'Técnico' }, { k: 'criadoEm', l: 'Criada em' }, { k: 'finalizadaEm', l: 'Finalizada em' },
    ...colunas(F.propriedade, 'p.').filter((c) => !['p.cab_IdATeG', 'p.cab_NomePropriedade'].includes(c.k)), ...colunas(F.visita, 'v.'),
    ...colsPonto('checkin', 'Check-in'), ...colsPonto('checkout', 'Check-out'), { k: 'duracao', l: 'Duração (min)' }, { k: 'qtdDom', l: 'Domicílios' }, { k: 'qtdAss', l: 'Assistidos' }];
  arqs.unshift(
    { nome: 'planilhas/1_visitas.csv', dados: enc.encode(csv(lV, cV)) },
    { nome: 'planilhas/2_domicilios.csv', dados: enc.encode(csv(lD, [...cBase, { k: 'dom.id', l: 'ID do domicílio (app)' }, ...colunas(F.domicilio, 'd.')])) },
    { nome: 'planilhas/3_assistidos.csv', dados: enc.encode(csv(lA, [...cAss, ...colunas(F.cadastro, 'c.')])) },
    { nome: 'planilhas/4_perfil_saude.csv', dados: enc.encode(csv(lP, [...cAss, ...colunas(F.perfil, 'pf.')])) },
    { nome: 'planilhas/5_acompanhamento.csv', dados: enc.encode(csv(lC, [...cAss, { k: 'ac.data', l: 'Data do acompanhamento' }, ...colunas(F.acomp, 'ac.')])) },
  );
  const json = { app: 'SDE Contingência', formato: 1, versaoApp: VERSAO, geradoEm: new Date().toISOString(), tecnico: cfg.tecnico, visitas, fotos: fotosIdx };
  arqs.unshift({ nome: 'dados.json', dados: enc.encode(JSON.stringify(json, null, 1)) });
  arqs.push({ nome: 'LEIA-ME.txt', dados: enc.encode(
    'Exportação do SDE Contingência\r\n\r\n' +
    '- planilhas/: abra no Excel (separador ponto e vírgula). Uma linha por visita, domicílio, assistido, perfil de saúde e acompanhamento.\r\n' +
    '- fotos/: check-in, check-out e termos, com data, hora e localização gravadas na imagem.\r\n' +
    '- dados.json: cópia completa. Serve para restaurar em outro aparelho (Ajustes > Importar) e para lançar no SDE depois.\r\n\r\n' +
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
