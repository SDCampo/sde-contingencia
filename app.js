'use strict';
/* SDE Contingência — registro offline de visitas quando o SDE Saúde no Campo está fora do ar.
   Os dados ficam só no aparelho (IndexedDB) e saem por exportação (ZIP com JSON, CSV e fotos). */
const VERSAO = '1.1.0';

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
/* Listas do Perfil de Saúde e do Atendimento: textos copiados do SDE (vídeo de 23/11/2026 e configuração lida em 13/11/2026). */
const SN = ['Sim', 'Não'];
const IMP = 'Pessoa impossibilitada de responder (por idade ou condição de saúde)';
const FREQ = ['Diariamente/Sempre', 'Frequentemente (3–6 vezes/semana)', 'Ocasionalmente (1–2 vezes/semana)', 'Raramente (< 1 vez/semana)', 'Nunca', IMP];
const FREQ_D = ['Diariamente', ...FREQ.slice(1)];
const ESCALA = ['Sempre', 'Frequentemente', 'Ocasionalmente', 'Raramente', 'Nunca', IMP];
const CONSULTA = ['Até 1 ano', 'Entre 1 e 2 anos', 'Entre 2 e 3 anos', 'Mais de 3 anos', 'Nunca', 'Não sei'];
const HA_TEMPO = ['Menos de 6 meses', 'Entre 6 meses e 1 ano', 'Entre 1 e 5 anos', 'Entre 6 e 10 anos', 'Mais de 10 anos', 'Não sabe informar'];
const DIAGNOSTICO = ['Entre 6 meses e 1 ano', 'Entre 1 e 5 anos', 'Entre 6 e 10 anos', 'Mais de 10 anos', 'Não sabe informar'];
const MOTIVO_NAO = ['Recusa ou decisão do assistido', 'Condição clínica que impossibilita o procedimento', 'Falha, falta ou demais problemas relacionados à material e/ou equipamento'];
const VACINAS = ['Sim', 'Parcialmente atualizadas / Atrasadas', 'Nenhuma dose registrada ou informada', 'Não sabe informar'];
const CARTAO = ['Sim', 'Não encontrou o cartão de vacina', 'Recusou apresentar o cartão de vacina', 'Não possui cartão de vacina'];
const FAMILIARES = ['Filho', 'Pai', 'Mãe', 'Irmãos', 'Avô(ó) - materna', 'Avô(ó) - paterno', 'Tio(a) - materna', 'Tio(a) - paterno'];
const ANOS_FUMO = ['Menos de 1 ano', 'Entre 1 e 5 anos', 'Mais de 5 anos', 'Mais de 10 anos', 'Mais de 20 anos', 'Mais de 30 anos', 'Mais de 40 anos', 'Mais de 50 anos'];
const ESC10 = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const SEM_TRABALHO = ['Aposentado/Pensionista', 'Desempregado', 'Estudante', 'Afastado por doença', 'Não trabalha'];
const OCUPACOES = [
  'Agricultura, Pecuária e Atividades Rurais (Agricultor, Produtor(a) rural, Trabalhador(a) agrícola, Pecuarista, etc)',
  'Serviços Gerais (Auxiliar de serviços gerais, Faxineiro, Zelador, Cozinheiro, Lavador, Porteiro, etc.)',
  'Construção Civil (Pedreiro, Servente de obras, Eletricista, Pintor, etc)',
  'Comércio e Atendimento (Vendedor, Atendente, Comerciário, etc.)',
  'Saúde (ACS, Técnico de enfermagem, Enfermeiro, Médico, etc)',
  'Educação (Professor, Monitor escolar, etc.)',
  'Indústria e Produção (Operador de máquina, Metalúrgico, Mecânico, etc.)',
  'Transporte e Logística (Motorista, Entregador, Caminhoneiro, etc.)',
  'Administrativas (Assistente administrativo, Secretário, Recepcionista, etc.)',
  'Segurança (Vigia, Policial, Bombeiro, etc.)',
  'Serviços Domésticos e Cuidados (Empregado(a) doméstico(a), diarista, Cuidador de idosos, Babá, etc.)'];
const RISCOS_TRAB = ['Não foram identificados riscos', 'Aplicação de produtos químicos/defensivo agrícola/venenos para controle de parasitas', 'Exposição à Luz Solar Intensa',
  'Ataques de animais peçonhentos', 'Acidentes com animais, como coices, mordidas e cabeçada', 'Acidentes com ferramentas e máquinas',
  'Exposição a agentes causadores de doenças respiratórias, como ácaros, pólens, pós', 'Rotina repetitiva sem pausa ao executar determinadas tarefas', 'Carregamento de Peso',
  'Exposição a ruídos altos', 'Exposição a agentes infecciosos/parasitários', 'Exposição frequente à vibração', 'Outro'];
const CONDICOES = [
  'Acidente Isquêmico Transitório (AIT)', 'Acidente vascular encefálico (AVE)/Derrame/AVC', 'Adenomiose', 'Alergias respiratórias', 'Alopecia', 'Alzheimer', 'Anemia (outras)',
  'Anemia falciforme', 'Aneurisma', 'Angina', 'Anorexia', 'Ansiedade', 'Apneia do sono', 'Arritmia', 'Artrite', 'Artrite reumatoide', 'Asma', 'Ataxia de Friedreich',
  'Atrofia muscular espinhal', 'Bronquite crônica', 'Bursites', 'Câncer cerebral', 'Câncer de boca', 'Câncer de brônquios', 'Câncer de cólon e reto', 'Câncer de esôfago',
  'Câncer de estômago', 'Câncer de fígado', 'Câncer de intestino', 'Câncer de laringe', 'Câncer de mama', 'Câncer de ovário', 'Câncer de pâncreas', 'Câncer de pele',
  'Câncer de pênis', 'Câncer de próstata', 'Câncer de pulmão', 'Câncer de rim', 'Câncer de testículo', 'Câncer de tireoide', 'Câncer de traqueia', 'Câncer do colo de útero',
  'Chikungunya', 'Clamídia', 'Colite ulcerativa', 'Depressão', 'Diabetes', 'Dislipidemias', 'Doença de Addison', 'Doença de Behçet', 'Doença de Chagas', 'Doença de Crohn',
  'Doença do refluxo gastroesofágico (DRGE)', 'Doença hepática alcoólica', 'Doenças do fígado', 'DORT (Distúrbios osteomusculares relacionados ao trabalho)',
  'DPOC (Doença pulmonar obstrutiva crônica)', 'Endometriose', 'Enfisema', 'Epilepsia', 'Esclerodermia', 'Esclerose lateral amiotrófica (ELA)', 'Esclerose múltipla',
  'Escoliose', 'Espondilite anquilosante', 'Esquistossomose', 'Esquizofrenia', 'Esteatose hepática', 'Fibromialgia', 'Fibrose cística', 'Gastrite', 'Gonorreia', 'Gota',
  'Hanseníase', 'Hemofilia', 'Hepatites virais', 'Hérnia de disco', 'Herpes genital', 'Hipertensão arterial sistêmica', 'Hipertireoidismo', 'Hipotireoidismo', 'HIV', 'HPV',
  'Infarto', 'Insuficiência cardíaca', 'Insuficiência renal/Diálise', 'Insuficiência venosa crônica', 'Leishmaniose visceral', 'LER (Lesão por esforço repetitivo)',
  'Leucemias', 'Linfoma de Hodgkin', 'Linfoma não-Hodgkin', 'Lúpus', 'Mieloma Múltiplo', 'Neuropatias', 'Obesidade', 'Osteoartrite', 'Osteoporose', 'Parkinson', 'Sífilis',
  'Síndrome de Down', 'Síndrome de Guillain-Barré', 'Síndrome de Sjögren', 'Síndrome de Turner', 'Síndrome pós-pólio', 'Talassemia', 'TDAH (Transtorno do déficit de atenção e hiperatividade)',
  'Tendinites', 'Tireoidite de Hashimoto', 'Toxoplasmose', 'Transtorno bipolar', 'Transtorno do Espectro Autista (TEA)', 'Tricomoníase', 'Tuberculose', 'Valvulopatia', 'Zika congênita'];
const CIRURGIAS = ['Cesárea (parto cesáreo) — cirurgia obstétrica bastante frequente no país.',
  'Hernioplastia / correção de hérnia abdominal ou inguinal — reparo de hérnias da parede abdominal', 'Colecistectomia (remoção da vesícula biliar) — para tratamento de cálculos biliares',
  'Apendicectomia (retirada do apêndice)', 'Cirurgia de catarata', 'Sutura / tratamento de feridas', 'Histerectomia (retirada do útero)', 'Cirurgia ortopédica / tratamento de fraturas',
  'Cirurgias abdominais gerais', 'Cirurgia bariátrica', 'Ressecção de tumor', 'Transplante'];
const TEMAS = [['SaudeAmbiente', 'Saúde do ambiente'], ['AlimentacaoSaudavel', 'Alimentação saudável'], ['AtividadeFisica', 'Atividade física/Estímulo cognitivo'],
  ['Cidadania', 'Cidadania'], ['Alcool', 'Cuidado relacionado ao uso de álcool'], ['Drogas', 'Cuidado relacionado ao uso de drogas'], ['CulturaLazer', 'Cultura e lazer'],
  ['EducacaoTrabalho', 'Educação e trabalho'], ['GestaoTempoRotina', 'Gestão do Tempo e Rotina'], ['HigienePessoal', 'Higiene pessoal'], ['MedicacaoSegura', 'Medicação segura'],
  ['PrevencaoQueda', 'Prevenção de queda'], ['SaudeAuditiva', 'Saúde auditiva'], ['SaudeBucal', 'Saúde bucal'], ['SaudeComplEnc', 'Saúde complementar / Encaminhamento'],
  ['SaudePele', 'Saúde da pele'], ['SaudeCuidador', 'Saúde do cuidador'], ['SaudeSono', 'Saúde do sono'], ['SaudeTrabalhador', 'Saúde do trabalhador'],
  ['SaudeFinanceira', 'Saúde Financeira Básica'], ['SaudeMental', 'Saúde Mental'], ['SaudeOcular', 'Saúde ocular'], ['SaudeSexualReprodutiva', 'Saúde sexual e reprodutiva'],
  ['Vacinacao', 'Vacinação'], ['CessacaoTabagismo', 'Cessação do tabagismo']];
const ALERTAS_IC = {
  'Alerta 1': 'Perfil identificado: motivado, porém inseguro. O assistido quer mudar, mas não se sente capaz. Foque em apoio prático, metas pequenas e acompanhamento nas próximas visitas.',
  'Alerta 2': 'Perfil identificado: capaz, porém desengajado. O assistido tem capacidade, mas pouco interesse. Trabalhe conscientização, impacto da saúde no trabalho e benefícios a médio prazo.',
  'Alerta 3': 'Perfil identificado: baixa prontidão para o autocuidado. Priorize vínculo, escuta qualificada e orientações básicas. Evite sobrecarregar com muitas recomendações.' };
/* Nome interno a partir do texto da opção (ex.: "Câncer de fígado" → CancerFigado), no padrão cab_1PergCancerFigado do SDE. */
const codigo = (s) => String(s).split(' — ')[0].replace(/\([^)]*\)/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/)
  .filter((w) => w && !['de', 'do', 'da', 'dos', 'das', 'e', 'a', 'o'].includes(w.toLowerCase())).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const SIM_NAO_NS = ['Sim', 'Não', 'Não sabe'];

const idadeDe = (o) => idade(o.cab_DataNascimento);
const mulher = (o) => o.cab_Sexo === 'Feminino';
function imc(o) {
  const p = num(o.cab_Peso); let a = num(o.cab_Altura);
  if (!p || !a) return '';
  if (a > 3) a /= 100;
  const v = p / (a * a);
  return isFinite(v) ? v.toFixed(2).replace('.', ',') : '';
}
/* condições de exibição */
const ge = (n) => (o) => { const i = idadeDe(o); return i == null || i >= n; };
const eq = (k, ...v) => (o) => v.includes(o[k]);
const tem = (k, v) => (o) => Array.isArray(o[k]) && o[k].includes(v);
const todos = (...fs) => (o) => fs.every((f) => f(o));
function linhaCuidado(o) {
  const i = idadeDe(o); if (i == null) return '';
  return i < 10 ? 'Criança' : i < 20 ? 'Adolescente' : i < 60 ? (mulher(o) ? 'Mulher' : 'Homem') : 'Idoso';
}
const lc = (x) => (o) => linhaCuidado(o) === x;
function alertaIC(i, c) {
  if (vazio(i) || vazio(c)) return '';
  i = +i; c = +c;
  return i >= 7 && c <= 6 ? 'Alerta 1' : i <= 6 && c >= 7 ? 'Alerta 2' : i <= 6 && c <= 6 ? 'Alerta 3' : '';
}
const notaLivre = (l, se) => ({ t: 'info', calc: () => l, se });

/* ---------- Perfil de Saúde (formulário 1008, "Antecedentes") ---------- */
const fum = todos(ge(18), eq('cab_Fumante', 'Fumante'));
const alc = todos(ge(18), eq('cab_UsoBebidaAlcoolica', ...FREQ_D.slice(0, 3)));
const drog = todos(ge(18), eq('cab_UtilizaDrogas', ...FREQ_D.slice(0, 3)));
const acam = eq('cab_EncontraseAcamada', 'Sim, em caráter permanente', 'Sim, em caráter temporário');
const mensurar = (nome, rotulo, campos, se) => [
  { k: 'cab_Mensurar' + nome, l: `Mensurar ${rotulo}?`, t: 'rad', o: SN, req: true, linha: true, se },
  { k: 'cab_MotivoNaoMensurar' + nome, l: 'Motivo', t: 'rad', o: MOTIVO_NAO, se: todos(se || (() => true), eq('cab_Mensurar' + nome, 'Não')) },
  { k: 'cab_JustificativaNaoMensurar' + nome, l: 'Justificativa', t: 'area', req: true, se: todos(se || (() => true), eq('cab_Mensurar' + nome, 'Não')) },
  ...campos.map((c) => ({ t: 'num', dec: true, req: true, ...c, se: todos(se || (() => true), eq('cab_Mensurar' + nome, 'Sim')) })),
];
const vacinasLC = (cod, rotulo, se) => [
  { k: 'cab_RecebeuVacinasLC' + cod, l: rotulo, t: 'rad', o: VACINAS, req: true, se },
  { k: 'cab_CartaoVacinaApresentadoLC' + cod, l: 'O cartão de vacinação foi apresentado para conferência?', t: 'rad', o: CARTAO, req: true, se },
];
const PERFIL = [
  { k: 'cab_DesejaPreencherPerfil', l: 'Deseja preencher o perfil de saúde?', t: 'rad', o: SN, req: true, linha: true, abre: true },
  { t: 'titulo', l: 'Educação e trabalho' },
  { k: 'cab_FrequentaEscolaCreche', l: 'Frequenta ou já frequentou alguma instituição de ensino básico e/ou superior', t: 'rad', o: SN, req: true, linha: true },
  { k: 'cab_Escolaridade', l: 'Escolaridade', t: 'rad', req: true, se: eq('cab_FrequentaEscolaCreche', 'Sim'),
    o: ['Não é alfabetizado', 'Creche', 'Pré-escola', 'Ensino fundamental incompleto', 'Ensino fundamental completo', 'Ensino médio incompleto', 'Ensino médio completo', 'Ensino superior incompleto', 'Ensino superior completo'] },
  { k: 'cab_SabeLerEscrever', l: 'Sabe ler e escrever um bilhete simples?', t: 'rad', o: SN, req: true, linha: true, se: todos((o) => !vazio(o.cab_FrequentaEscolaCreche), ge(7)) },
  { k: 'cab_SituacaoMercado', l: 'Situação atual no mercado de trabalho?', t: 'multi', req: true, se: todos((o) => !vazio(o.cab_FrequentaEscolaCreche), ge(14)),
    o: ['Empregador/Produtor', 'Aposentado/Pensionista', 'Assalariado com carteira de trabalho', 'Assalariado sem carteira de trabalho', 'Autônomo com previdência social',
      'Autônomo sem previdência social', 'Desempregado', 'Trabalho doméstico', 'Estudante', 'Afastado por doença', 'Não trabalha'] },
  { k: 'cab_OcupacaoAtual', l: 'Qual sua ocupação atual?', t: 'multi', o: OCUPACOES, req: true, se: todos(ge(14), (o) => (o.cab_SituacaoMercado || []).some((x) => !SEM_TRABALHO.includes(x))) },
  { k: 'cab_PrincipaisRiscosAssociadosTrabalhoDiario', l: 'Principais riscos associados ao trabalho diário:', t: 'multi', o: RISCOS_TRAB, req: true, se: (o) => !vazio(o.cab_OcupacaoAtual) },

  { t: 'titulo', l: 'Autoavaliação – Estado emocional', se: ge(10) },
  { k: 'cab_ComoConsidera', l: 'Como você se considera?', t: 'rad', req: true, se: ge(10),
    o: ['Uma pessoa feliz', 'Uma pessoa triste', 'Uma pessoa ansiosa', 'Uma pessoa estressada/irritada', 'Uma pessoa calma', 'Uma pessoa desanimada', 'Uma pessoa bem-disposta', 'Pessoa impossibilitada'] },
  { k: 'cab_FrequenciaPrazerAtividades', l: 'Com que frequência você sente prazer nas atividades do dia a dia?', t: 'rad', o: FREQ, req: true, se: ge(10) },
  { k: 'cab_SatisfacaoGeralVida', l: 'Como você avalia sua satisfação geral com a vida atualmente?', t: 'rad', se: ge(10),
    o: ['Muito satisfeito(a)', 'Satisfeito(a)', 'Indiferente', 'Pouco satisfeito(a)', 'Insatisfeito(a)', IMP] },
  { t: 'titulo', l: 'Autoavaliação – Sono', se: ge(10) },
  { k: 'cab_ConsideraDormiuBem', l: 'Você considera que dorme bem?', t: 'rad', o: FREQ, se: ge(10) },
  { k: 'cab_HorasSono', l: 'Quantas horas costuma dormir por noite?', t: 'rad', se: todos(ge(10), eq('cab_ConsideraDormiuBem', ...FREQ.slice(2, 5))),
    o: ['Menos de 3 horas', '3 a 4 horas', '5 a 6 horas', '7 a 8 horas', 'Mais de 8 horas', 'Sono irregular', IMP] },
  { t: 'titulo', l: 'Autoavaliação – Higiene', se: ge(10) },
  { k: 'cab_FrequenciaHigieneCorporalCapilar', l: 'Com que frequência realiza higiene corporal e capilar?', t: 'rad', o: FREQ, se: ge(10) },
  { k: 'cab_FrequenciaHigieneBucal', l: 'Com que frequência realiza higiene bucal (escovação de dentes com escova individual, escovação da língua e uso de fio dental)?', t: 'rad', o: FREQ, se: ge(10) },
  { t: 'titulo', l: 'Autoavaliação – Alimentação e Bem-estar', se: ge(10) },
  { k: 'cab_AvaliaAlimentacao', l: 'Como você avalia sua alimentação?', t: 'rad', req: true, se: ge(10),
    o: ['Muito saudável', 'Saudável', 'Parcialmente saudável', 'Pouco saudável', 'Nada saudável', IMP] },
  { t: 'titulo', l: 'Autoavaliação – Organização e rotina', se: ge(10) },
  { k: 'cab_AvaliaOrganizacao', l: 'Você se considera uma pessoa organizada?', t: 'rad', o: ESCALA, se: ge(10) },
  { k: 'cab_EquilibraTrabalhoTarefasDescanso', l: 'Você consegue equilibrar trabalho, tarefas e descanso?', t: 'rad', o: ESCALA, se: ge(10) },
  { t: 'titulo', l: 'Autoavaliação – Relações e comunicação', se: ge(10) },
  { k: 'cab_UsaAparelhoAuditivo', l: 'O assistido usa aparelho auditivo?', t: 'rad', o: ['Sim', 'Não', IMP], req: true, se: ge(10) },
  { k: 'cab_ConsideraSociavel', l: 'Você se considera uma pessoa sociável?', t: 'rad', o: ESCALA, req: true, se: ge(10) },
  { k: 'cab_FacilidadeConversarExpressar', l: 'Você tem facilidade em conversar e expressar o que sente?', t: 'rad', o: ESCALA, req: true, se: ge(10) },
  { t: 'titulo', l: 'Autoavaliação – Autoavaliação Geral da Saúde', se: ge(10) },
  { k: 'cab_AvaliaEstadoSaude', l: 'De um modo geral, como você avalia o seu estado de saúde?', t: 'rad', o: ['Muito bom', 'Bom', 'Regular', 'Ruim', 'Muito ruim', IMP], req: true, se: ge(10) },
  { k: 'cab_RelataQueixa', l: 'Relata queixa relacionada a algum dos itens abaixo?', t: 'multi', req: true, se: ge(10),
    o: ['Visão (ex.: dificuldade para enxergar, visão embaçada)', 'Fala (ex.: dificuldade para falar ou se comunicar)', 'Audição (ex.: dificuldade para ouvir)',
      'Movimento (ex.: dificuldade para andar, levantar ou movimentar partes do corpo)', 'Não apresenta queixas', IMP] },

  { t: 'titulo', l: 'Hábitos de Vida - Atividade física', se: ge(14) },
  { k: 'cab_PraticaAtividadeFisica', l: 'Pratica atividade física?', t: 'rad', o: FREQ, req: true, se: ge(14) },
  { k: 'cab_QualAtividadeFisica', l: 'Qual?', t: 'multi', req: true, se: todos(ge(14), eq('cab_PraticaAtividadeFisica', ...FREQ.slice(0, 3))),
    o: ['Caminhada', 'Musculação/Academia', 'Corrida', 'Dança (zumba/fitdance)', 'Futebol/Futsal', 'Vôlei', 'Natação', 'Pilates', 'Yoga', 'Atividades domésticas (faxina, lavagem, varrer quintal)', 'Outro'] },
  { t: 'titulo', l: 'Hábitos de Vida - Tabagismo', se: ge(18) },
  { k: 'cab_Fumante', l: 'É fumante?', t: 'rad', o: ['Nunca fumou', 'Ex-fumante', 'Fumante', IMP], req: true, se: ge(18) },
  { k: 'cab_FumouQuantosAnos', l: 'Fumou por quantos anos?', t: 'rad', o: ANOS_FUMO, req: true, se: todos(ge(18), eq('cab_Fumante', 'Ex-fumante')) },
  { k: 'cab_HaQuantoTempoParouFumar', l: 'Há quanto tempo parou de fumar?', t: 'rad', o: ['Menos de 1 ano', 'Entre 1 e 5 anos', 'Mais de 5 anos', 'Mais de 10 anos'], req: true, se: todos(ge(18), eq('cab_Fumante', 'Ex-fumante')) },
  { k: 'cab_ExpostoFumaca', l: 'Fica exposto(a) à fumaça do cigarro?', t: 'rad', o: FREQ_D, req: true, se: todos(ge(18), eq('cab_Fumante', 'Nunca fumou', 'Ex-fumante')) },
  { t: 'titulo', l: 'Protocolo - Tabagismo', se: fum },
  { k: 'cab_TipoCigarroProtocoloTabagismo', l: 'Informe o tipo de cigarro/fumo:', t: 'multi', req: true, se: fum,
    o: ['Cachimbo', 'Charutos ou Cigarrilhas', 'Cigarro Convencional (industrializado)', 'Cigarro de Palha ou Fumo de Corda', 'Cigarro Eletrônico (vape)', 'Narguilé', 'Tabaco aquecido', 'Tabaco triturado e enrolado manualmente'] },
  { k: 'cab_QtdCigarrosDiaProtocoloTabagismo', l: 'Quantos cigarros fuma por dia?', t: 'rad', o: ['Menos de 10', 'De 11 a 20', 'De 21 a 30', 'Mais de 31'], req: true, se: fum },
  { k: 'cab_FumaAmbienteFechadoProtocoloTabagismo', l: 'Fuma dentro de casa ou em ambientes fechados?', t: 'rad', o: SN, linha: true, req: true, se: fum },
  { k: 'cab_PrentendeParaFumarProtocoloTabagismo', l: 'Tem intenção de parar de fumar?', t: 'rad', o: SN, linha: true, req: true, se: fum },
  { k: 'cab_LesaoBucalProtocoloTabagismo', l: 'Identifica alguma lesão/ferida bucal?', t: 'rad', o: SN, linha: true, req: true, se: fum },
  { k: 'cab_FumaHaQuantosAnosProtocoloTabagismo', l: 'Fuma há quantos anos?', t: 'rad', o: ANOS_FUMO, req: true, se: fum },
  { t: 'titulo', l: 'Hábitos de Vida - Álcool', se: ge(18) },
  { k: 'cab_UsoBebidaAlcoolica', l: 'Faz uso de bebida alcoólica?', t: 'rad', o: FREQ_D, req: true, se: ge(18) },
  { t: 'titulo', l: 'Protocolo - Alcoolismo', se: alc },
  notaLivre('As opções destas duas perguntas não foram capturadas do SDE: responda por extenso.', alc),
  { k: 'cab_QuaisBebidasProtocoloAlcoolismo', l: 'Quais Bebibas?', t: 'text', req: true, se: alc },
  { k: 'cab_BebeFrequenciaAnosProtocoloAlcoolismo', l: 'Bebe com esta frequência há quantos anos?', t: 'text', req: true, se: alc },
  { k: 'cab_IntencaoParaReduzirFrequenciaQuantidadeProtocoloAlcoolismo', l: 'Tem intenção de parar de beber ou reduzir a frequência/quantidade?', t: 'rad', o: SN, linha: true, req: true, se: alc },
  { t: 'titulo', l: 'Hábitos de Vida - Outras Drogas', se: ge(18) },
  { k: 'cab_UtilizaDrogas', l: 'Faz uso de outras drogas?', t: 'rad', o: FREQ_D, se: ge(18) },
  { t: 'titulo', l: 'Protocolo - Dependência química', se: drog },
  { k: 'cab_QuaisDrogasProtocoloDependenciaQuimica', l: 'Quais drogas?', t: 'multi', req: true, se: drog,
    o: ['Crack, Oxi, Merla', 'Ecstasy/MDMA', 'Heroína', 'Maconha, Haxixim Skank', 'Opióides', 'Quetamina', 'Solventes: Lança-perfume, loló', 'Não informou', 'Outro'] },
  { k: 'cab_IntencaoParaReduzirFrequenciaQuantidadeProtocoloDependenciaQuimica', l: 'Tem intenção de parar de usar ou reduzir a frequência/quantidade?', t: 'rad', o: SN, linha: true, req: true, se: drog },

  { t: 'titulo', l: 'Acesso, Saúde e Doença Acesso à saúde' },
  { k: 'cab_PossuiPlanoSaude', l: 'Possui plano de saúde?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_UltimaConsultaComMedico', l: 'Quando foi sua última consulta com o médico?', t: 'rad', o: CONSULTA, req: true },
  { k: 'cab_UltimaConsultaComDentista', l: 'Quando foi sua última consulta com o dentista?', t: 'rad', o: CONSULTA, req: true },
  { k: 'cab_UsoProteseDentaria', l: 'Atualmente, você faz uso de prótese dentária?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_UltimaConsultaComOftalmologista', l: 'Quando foi sua última consulta com o oftalmologista?', t: 'rad', o: CONSULTA, req: true },
  { k: 'cab_UsaOculosLentes', l: 'Usa óculos/lentes de contato?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_ProcuraAtendimentoSaude', l: 'Quando está doente ou precisando de atendimento de saúde costuma procurar', t: 'multi', req: true,
    o: ['Centro de Atenção Psicossocial', 'Farmácia', 'Serviços de saúde da rede privada (hospital, consultório, clínica, etc.)', 'Teleconsulta', 'Unidade básica de saúde/Policlínica',
      'Unidade de Pronto Atendimento (UPA)/Hospital Público', 'Informações na internet', 'Outro'] },
  { k: 'cab_MeioTransporteServicosSaude', l: 'Meio de transporte mais utilizado para chegar à cidade/serviços de saúde', t: 'multi', req: true,
    o: ['Veículo motorizado próprio (carro, moto, etc)', 'Bicicleta', 'Transporte coletivo', 'Caminhada', 'Carona'] },

  { t: 'titulo', l: 'Acesso, Saúde e Doença Condição atual' },
  ...mensurar('Peso', 'Peso', [{ k: 'cab_Peso', l: 'Peso', ph: 'kg' }]),
  ...mensurar('Altura', 'Altura', [{ k: 'cab_Altura', l: 'Altura', ph: 'Informar altura em (cm)' }]),
  { k: 'cab_IMC', l: 'IMC', t: 'calc', calc: imc, se: (o) => o.cab_MensurarPeso === 'Sim' && o.cab_MensurarAltura === 'Sim' },
  ...mensurar('Pressao', 'Pressão', [{ k: 'cab_PressaoArterialSistolica', l: 'Sistólica', dec: false }, { k: 'cab_PressaoArterialDiastolica', l: 'Diastólica', dec: false }], ge(18)),
  { k: 'cab_PossuiDeficiencia', l: 'Possui alguma deficiência?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_EspecificaDeficiencia', l: 'Especificar a deficiência:', t: 'multi', o: ['Física', 'Visual', 'Auditiva', 'Intelectual', 'Psicossocial'], req: true, se: eq('cab_PossuiDeficiencia', 'Sim') },
  ...['Física', 'Visual', 'Auditiva', 'Intelectual', 'Psicossocial'].map((d) => ({ k: 'cab_DetalhamentoDeficiencia' + codigo(d), l: 'Detalhamento – Deficiência ' + d, t: 'area', req: true,
    se: todos(eq('cab_PossuiDeficiencia', 'Sim'), tem('cab_EspecificaDeficiencia', d)) })),
  { k: 'cab_EncontraseAcamada', l: 'A pessoa atendida encontra-se acamada no momento do atendimento?', t: 'rad', o: ['Sim, em caráter permanente', 'Sim, em caráter temporário', 'Não'], req: true },
  { t: 'titulo', l: 'Protocolo - Cuidado da pessoa acamada', se: acam },
  notaLivre('As opções deste protocolo não foram capturadas do SDE: responda por extenso quando não for Sim/Não.', acam),
  { k: 'cab_TempoAcamadaProtocoloAcamado', l: 'Há quanto tempo está acamada?', t: 'text', req: true, se: acam },
  { k: 'cab_NivelConscienciaProtocoloAcamado', l: 'Nível de consciência e orientação da pessoa acamada', t: 'text', req: true, se: acam },
  { k: 'cab_RealizaAtividadeSozinhaProtocoloAcamado', l: 'A pessoa consegue realizar alguma atividade sozinha?', t: 'text', req: true, se: acam },
  { k: 'cab_CuidadorPrincipalProtocoloAcamado', l: 'Existe um cuidador principal?', t: 'rad', o: SN, linha: true, req: true, se: acam },
  { k: 'cab_QuemRealizaCuidadoProtocoloAcamado', l: 'Quem realiza o cuidado?', t: 'text', req: true, se: acam },
  { k: 'cab_CuidadorOrientadoProtocoloAcamado', l: 'O cuidador recebeu orientações de profissionais de saúde sobre os cuidados?', t: 'rad', o: SN, linha: true, req: true, se: acam },
  { k: 'cab_DetalhamentoProtocoloAcamado', l: 'Detalhamento', t: 'area', se: acam },

  { t: 'titulo', l: 'Condições de Saúde' },
  { k: 'cab_PossuiDoencaLongaDuracao', l: 'Possui alguma condição de saúde ou algum médico já deu o diagnóstico de alguma doença crônica, física ou mental, ou doença de longa duração (de mais de 6 meses de duração)?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_SelecionaCondicao', l: 'Condições de Saúde', t: 'multi', o: CONDICOES, busca: true, req: true, se: eq('cab_PossuiDoencaLongaDuracao', 'Sim') },
  { k: 'cab_LimitaAtividadesHabituais', l: 'Alguma dessas doenças limita, de alguma forma, suas atividades habituais (trabalhar, ir à escola, brincar, afazeres domésticos etc.)?', t: 'rad', o: SN, linha: true, req: true, se: eq('cab_PossuiDoencaLongaDuracao', 'Sim') },
  { t: 'cada', k: '_condicoes', se: eq('cab_PossuiDoencaLongaDuracao', 'Sim'), itens: (o) => (o.cab_SelecionaCondicao || []).map((x) => ({ id: x, l: x })),
    campos: (x) => { const c = codigo(x.id); const k = (n) => `cab_${n}Perg${c}`; const ativa = eq(k(2), 'Ativa'); return [
      { k: k(1), l: 'Quando foi diagnosticado?', t: 'rad', o: DIAGNOSTICO, req: true },
      { k: k(2), l: 'Situação da condição de saúde?', t: 'rad', o: ['Ativa', 'Curada', 'Desconhecida'], req: true, linha: true },
      { k: k(3), l: 'Situação da condição ativa:', t: 'text', req: true, se: ativa },
      { k: k(4), l: 'Quando foi a última avaliação pelo profissional de saúde referente à esta condição de saúde?', t: 'text', req: true, se: ativa },
      { k: k(5), l: 'Motivo de desconhecer a evolução da condição:', t: 'text', req: true, se: eq(k(2), 'Desconhecida') },
    ]; } },
  { t: 'titulo', l: 'Protocolo - Diabetes', se: tem('cab_SelecionaCondicao', 'Diabetes') },
  { k: 'cab_FrequenciaGlicemiaProtocoloDiabetes', l: 'Com que frequência sua glicemia é medida?', t: 'text', req: true, se: tem('cab_SelecionaCondicao', 'Diabetes') },
  { k: 'cab_ValorGlicemiaProtocoloDiabetes', l: 'Sabe informar o valor habitual da sua glicemia?', t: 'text', req: true, se: tem('cab_SelecionaCondicao', 'Diabetes') },
  { t: 'titulo', l: 'Protocolo - Hipertensão Arterial', se: tem('cab_SelecionaCondicao', 'Hipertensão arterial sistêmica') },
  { k: 'cab_FrequenciaPressaoProtocoloHipertensao', l: 'Com que frequência sua pressão arterial é medida?', t: 'text', req: true, se: tem('cab_SelecionaCondicao', 'Hipertensão arterial sistêmica') },
  { k: 'cab_ValoresPressaoProtocoloHipertensao', l: 'Sabe informar os valores habituais da sua pressão arterial?', t: 'text', req: true, se: tem('cab_SelecionaCondicao', 'Hipertensão arterial sistêmica') },

  { t: 'titulo', l: 'Acesso, Saúde e Doença Terapias e tratamentos' },
  { k: 'cab_AlergiaMedicamento', l: 'Tem alergia a algum medicamento?', t: 'rad', o: ['Sim', 'Não', 'Não sabe informar'], req: true },
  { k: 'cab_NomeMedicamentoAlergia', l: 'Nome do medicamento que tem alergia', t: 'lista', req: true, se: eq('cab_AlergiaMedicamento', 'Sim') },
  { k: 'cab_PergMedicacaoUsoContinua', l: 'Faz uso de medicação contínua?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_QtdMedicamentos', l: 'Seleciona o a sessão para incluir ou remover medicamentos', t: 'multi', req: true, se: eq('cab_PergMedicacaoUsoContinua', 'Sim'),
    o: Array.from({ length: 10 }, (_, i) => 'Medicamento ' + (i + 1)) },
  { t: 'cada', k: '_medicamentos', se: eq('cab_PergMedicacaoUsoContinua', 'Sim'), itens: (o) => (o.cab_QtdMedicamentos || []).map((x) => ({ id: x, l: x })),
    campos: (x) => { const n = x.id.replace(/\D/g, ''); const k = (b) => b + n; const presc = eq(k('cab_3PergMedicacaoUsoContinua'), 'Sim'); return [
      { k: k('cab_NomeMedicamento'), l: 'Nome do medicamento', t: 'text', req: true },
      { k: k('cab_3PergMedicacaoUsoContinua'), l: 'A medicação foi prescrita por um profissional de saúde?', t: 'rad', o: SN, linha: true, req: true },
      { k: k('cab_DoseMedicamento'), l: 'Dose do medicamento', t: 'text', req: true, se: presc },
      { k: k('cab_FormaFarmaceutica'), l: 'Forma Farmacêutica do medicamento', t: 'rad', req: true, se: presc,
        o: ['Sólida (cápsula, comprimido, pastilha, etc.)', 'Semissólida (pomada, gel, loção, etc.)', 'Líquida (solução, xarope, etc.)', 'Gasosa (spray, aerosol, etc.)'] },
      { k: k('cab_ViaAdministracao'), l: 'Via de administração da medicação', t: 'rad', o: ['Oral', 'Tópica', 'Nasal', 'Injetável'], req: true, se: presc },
      { k: k('cab_FrequenciaUsoMedicacao'), l: 'Frequência em que faz uso da medicação', t: 'rad', req: true, se: presc,
        o: ['12 em 12 horas (2x ao dia)', '1x ao dia', '1x na semana', '1x no mês', '2 em 2 meses'] },
      { k: k('cab_HorariosUsoMedicacao'), l: 'Horários de uso da medicação', t: 'area', req: true, se: presc },
      { k: k('cab_UsoMedicacaoConformeOrientado'), l: 'Faz uso da medicação conforme orientado pelo profissional de saúde?', t: 'rad', req: true, se: presc,
        o: ['Sempre', 'Frequentemente', 'Ocasionalmente', 'Raramente', 'Nunca'] },
      { k: k('cab_TempoUsoMedicacao'), l: 'Há quanto tempo usa essa medicação (mesma medicação, mesma posologia)?', t: 'rad', req: true, se: presc,
        o: ['Menos de 1 mês', 'De 1 a 3 meses', 'De 4 a 6 meses', 'De 7 meses a 1 ano', 'Mais de 1 ano', 'Mais de 2 anos', 'Não lembra / Não sabe informar'] },
      { k: k('cab_ArmazenamentoAdequado'), l: 'Armazenamento adequado?', t: 'rad', o: SN, linha: true, req: true, se: presc },
    ]; } },
  { t: 'titulo', l: 'Plantas Medicinais' },
  { k: 'cab_UsoPlantasMedicinais', l: 'Faz uso de plantas medicinais?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_QualPlantaMedicinal', l: 'Qual?', t: 'multi', req: true, se: eq('cab_UsoPlantasMedicinais', 'Sim'),
    o: ['Camomila', 'Erva-cidreira / Melissa', 'Capim-cidreira / Capim-limão', 'Hortelã', 'Boldo', 'Alecrim', 'Guaco', 'Gengibre', 'Alfavaca / Manjericão', 'Babosa / Aloe vera', 'Outro'] },
  { t: 'titulo', l: 'Acesso, Saúde e Doença Práticas Integrativas e Complementares de Saúde' },
  { k: 'cab_UsoPICS', l: 'Faz uso de Práticas Integrativas e Complementares em Saúde (PICS)?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_QualPICS', l: 'Qual prática?', t: 'multi', req: true, se: eq('cab_UsoPICS', 'Sim'),
    o: ['Fisioterapia', 'Fonoaudiologia', 'Psicoterapia / Terapia psicológica', 'Terapia Ocupacional', 'Acupuntura', 'Massoterapia', 'Homeopatia', 'Fitoterapia', 'Reiki', 'Quiropraxia', 'Meditação guiada / Mindfulness', 'Outro'] },
  { t: 'titulo', l: 'Acesso, Saúde e Doença Internações' },
  { k: 'cab_Internacao12Meses', l: 'Internação nos últimos 12 meses?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_TempoInternacao', l: 'Há quanto tempo ocorreu a internação?', t: 'rad', o: HA_TEMPO, se: eq('cab_Internacao12Meses', 'Sim') },
  { k: 'cab_MotivoInternacao', l: 'Qual motivo?', t: 'area', se: eq('cab_Internacao12Meses', 'Sim') },
  { k: 'cab_internacao_outro_1', l: 'Outro motivo de Internação?', t: 'rad', o: SN, linha: true, req: true, se: eq('cab_Internacao12Meses', 'Sim') },
  { k: 'cab_Internacao12Meses_1', l: 'Internação nos últimos 12 meses?', t: 'rad', o: SN, linha: true, req: true, se: todos(eq('cab_Internacao12Meses', 'Sim'), eq('cab_internacao_outro_1', 'Sim')) },
  { k: 'cab_TempoInternacao_1', l: 'Há quanto tempo ocorreu a internação?', t: 'rad', o: HA_TEMPO, se: eq('cab_Internacao12Meses_1', 'Sim') },
  { k: 'cab_MotivoInternacao_1', l: 'Qual motivo?', t: 'area', se: eq('cab_Internacao12Meses_1', 'Sim') },
  { k: 'cab_internacao_outro_2', l: 'Outro motivo de Internação?', t: 'rad', o: SN, linha: true, req: true, se: eq('cab_Internacao12Meses_1', 'Sim') },
  { k: 'cab_Internacao12Meses_2', l: 'Internação nos últimos 12 meses?', t: 'rad', o: SN, linha: true, req: true, se: todos(eq('cab_Internacao12Meses_1', 'Sim'), eq('cab_internacao_outro_2', 'Sim')) },
  { k: 'cab_TempoInternacao_2', l: 'Há quanto tempo ocorreu a internação?', t: 'rad', o: HA_TEMPO, se: eq('cab_Internacao12Meses_2', 'Sim') },
  { k: 'cab_MotivoInternacao_2', l: 'Qual motivo?', t: 'area', se: eq('cab_Internacao12Meses_2', 'Sim') },
  { t: 'titulo', l: 'Acesso, Saúde e Doença Cirurgia' },
  { k: 'cab_RealizouCirurgia', l: 'Já fez alguma cirurgia?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_MotivoCirurgia', l: 'Qual o motivo?', t: 'multi', o: CIRURGIAS, req: true, se: eq('cab_RealizouCirurgia', 'Sim') },
  { t: 'cada', k: '_cirurgias', titulo: (x) => 'Cirurgia: ' + x.id.split(' — ')[0], se: eq('cab_RealizouCirurgia', 'Sim'), itens: (o) => (o.cab_MotivoCirurgia || []).map((x) => ({ id: x, l: x })),
    campos: (x) => [{ k: 'cab_TempoCirurgia' + codigo(x.id), l: 'Há quanto tempo realizou a cirurgia?', t: 'rad', o: HA_TEMPO, req: true }] },

  { t: 'titulo', l: 'Condições de Saúde na Família' },
  { k: 'cab_TemConvivenciaProximaFamiliaBiologica', l: 'Teve ou tem convivência próxima com familiares biológicos?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_QuaisFamiliaresConvivencia', l: 'Quais?', t: 'multi', o: FAMILIARES, req: true, se: eq('cab_TemConvivenciaProximaFamiliaBiologica', 'Sim') },
  { k: 'cab_PossuiCondicaoSaudeFamiliar', l: 'Algum familiar tem ou já teve diagnóstico de doença genética, hereditária ou que apresente histórico familiar?', t: 'rad', o: SN, req: true },
  { k: 'cab_FamiliarSelecionaCondicao', l: 'Condições de saúde', t: 'multi', o: CONDICOES, busca: true, req: true, se: eq('cab_PossuiCondicaoSaudeFamiliar', 'Sim') },
  { t: 'cada', k: '_familia', titulo: (x) => 'Família: ' + x.id, se: eq('cab_PossuiCondicaoSaudeFamiliar', 'Sim'), itens: (o) => (o.cab_FamiliarSelecionaCondicao || []).map((x) => ({ id: x, l: x })),
    campos: (x) => [{ k: 'Familiar1Perg' + codigo(x.id), l: 'Qual familiar possui essa condição?', t: 'multi', o: FAMILIARES, req: true }] },

  { t: 'titulo', l: 'Linha do cuidado - Saúde da Criança', se: lc('Criança') },
  notaLivre('No SDE esta linha de cuidado tem 29 perguntas e só parte delas foi capturada. Registre o restante em "Anotações".', lc('Criança')),
  { k: 'cab_CriancaTermoLCSaudeCrianca', l: 'Criança a termo?', t: 'text', req: true, se: lc('Criança') },
  { k: 'cab_AleitamentoLCSaudeCrianca', l: 'Aleitamento/alimentação:', t: 'text', req: true, se: lc('Criança') },
  { k: 'cab_RecebeuTodasVacinasLCSaudeCrianca', l: 'Recebeu as vacinas recomendadas para a idade?', t: 'rad', o: VACINAS, req: true, se: lc('Criança') },
  { k: 'cab_CartaoVacinaApresentadoLCSaudeCrianca', l: 'O cartão de vacinação foi apresentado para conferência?', t: 'rad', o: CARTAO, req: true, se: lc('Criança') },
  { k: 'cab_AnotacoesLCSaudeCrianca', l: 'Anotações (demais perguntas da linha de cuidado)', t: 'area', se: lc('Criança') },
  { t: 'titulo', l: 'Linha do cuidado - Saúde do Adolescente e Jovem', se: lc('Adolescente') },
  ...vacinasLC('SaudeAdolescente', 'Recebeu dT, HPV (meninas e meninos), meningocócica ACWY e febre amarela?', lc('Adolescente')),
  { t: 'titulo', l: 'Linha do cuidado - Saúde da Mulher', se: lc('Mulher') },
  { k: 'cab_EstaGestanteLCSaudeMulher', l: 'Você está gestante no momento?', t: 'rad', o: SN, linha: true, req: true, se: lc('Mulher') },
  { k: 'cab_PuerperioLCSaudeMulher', l: 'Está no Puerpério?', t: 'rad', o: SN, linha: true, req: true, se: lc('Mulher') },
  ...vacinasLC('SaudeMulher', 'Recebeu as vacinas recomendadas (dT, febre amarela, tríplice viral conforme necessidade, hepatite B)?', lc('Mulher')),
  { k: 'cab_AnotacoesLCSaudeMulher', l: 'Anotações (demais perguntas da linha de cuidado)', t: 'area', se: lc('Mulher') },
  { t: 'titulo', l: 'Protocolo - Gestante', se: todos(lc('Mulher'), eq('cab_EstaGestanteLCSaudeMulher', 'Sim'), ge(14)) },
  { k: 'cab_PrimeiraGestacaoProtocoloGestante', l: 'Esta é a sua primeira gestação?', t: 'rad', o: SN, linha: true, req: true, se: todos(lc('Mulher'), eq('cab_EstaGestanteLCSaudeMulher', 'Sim'), ge(14)) },
  { k: 'cab_IdadeGestacionalProtocoloGestante', l: 'Sabe a idade gestacional?', t: 'text', req: true, se: todos(lc('Mulher'), eq('cab_EstaGestanteLCSaudeMulher', 'Sim'), ge(14)) },
  { k: 'cab_AnotacoesProtocoloGestante', l: 'Anotações (demais perguntas do protocolo)', t: 'area', se: todos(lc('Mulher'), eq('cab_EstaGestanteLCSaudeMulher', 'Sim'), ge(14)) },
  { t: 'titulo', l: 'Linha do cuidado - Saúde da Homem', se: lc('Homem') },
  ...vacinasLC('SaudeHomem', 'Recebeu as vacinas recomendadas (dT, febre amarela, tríplice viral conforme necessidade, hepatite B)?', lc('Homem')),
  { t: 'titulo', l: 'Linha do cuidado - Pessoa Idosa', se: lc('Idoso') },
  { k: 'cab_PerdaFuncionalLCSaudeIdoso', l: 'Apresenta perda funcional?', t: 'rad', o: SN, linha: true, req: true, se: lc('Idoso') },
  ...vacinasLC('SaudeIdoso', 'Recebeu as vacinas recomendadas (influenza anual, COVID-19 e demais do calendário da pessoa idosa)?', lc('Idoso')),
  { t: 'titulo', l: 'Protocolo - Prevenção do Câncer de pele', se: tem('cab_PrincipaisRiscosAssociadosTrabalhoDiario', 'Exposição à Luz Solar Intensa') },
  { k: 'cab_ProtecaoSolProtocoloPrevencaoCancerPele', l: 'Costuma utilizar algum tipo de proteção contra o sol?', t: 'text', req: true, se: tem('cab_PrincipaisRiscosAssociadosTrabalhoDiario', 'Exposição à Luz Solar Intensa') },
  { k: 'cab_PeleQueimaProtocoloPrevencaoCancerPele', l: 'Sua pele costuma queimar com facilidade quando exposta ao sol?', t: 'text', req: true, se: tem('cab_PrincipaisRiscosAssociadosTrabalhoDiario', 'Exposição à Luz Solar Intensa') },
  { t: 'titulo', l: 'Outros protocolos do SDE' },
  { k: 'cab_AnotacoesOutrosProtocolos', l: 'Anotações de outros protocolos (câncer, desnutrição, sobrepeso/obesidade, prevenção de câncer de mama, próstata e colo do útero)', t: 'area' },
  { t: 'titulo', l: 'Breve Resumo' },
  { k: 'cab_BreveResumo', l: 'Breve Resumo', t: 'area' },
];
for (const f of PERFIL) if (!f.abre) { const s = f.se; f.se = s ? (o) => o.cab_DesejaPreencherPerfil === 'Sim' && s(o) : (o) => o.cab_DesejaPreencherPerfil === 'Sim'; }

/* ---------- Acompanhamento (formulário 1002, "Atendimento") ---------- */
const META_AUTO = {
  SaudeAmbiente: (o) => FREQ_D.slice(0, 3).includes(o.cab_ExpostoFumaca) || o.cab_FumaAmbienteFechadoProtocoloTabagismo === 'Sim',
  AlimentacaoSaudavel: (o) => ['Parcialmente saudável', 'Pouco saudável', 'Nada saudável'].includes(o.cab_AvaliaAlimentacao),
  AtividadeFisica: (o) => FREQ.slice(3, 5).includes(o.cab_PraticaAtividadeFisica),
  Alcool: (o) => FREQ_D.slice(0, 3).includes(o.cab_UsoBebidaAlcoolica) || o.cab_IntencaoParaReduzirFrequenciaQuantidadeProtocoloAlcoolismo === 'Sim',
  Drogas: (o) => FREQ_D.slice(0, 3).includes(o.cab_UtilizaDrogas) || o.cab_IntencaoParaReduzirFrequenciaQuantidadeProtocoloDependenciaQuimica === 'Sim',
  EducacaoTrabalho: (o) => { const i = idadeDe(o); return i != null && ((i > 4 && (o.cab_FrequentaEscolaCreche === 'Não' || o.cab_SabeLerEscrever === 'Não')) || (i > 13 && (o.cab_SituacaoMercado || []).includes('Desempregado'))); },
  GestaoTempoRotina: (o) => ['Ocasionalmente', 'Raramente', 'Nunca'].some((v) => v === o.cab_AvaliaOrganizacao || v === o.cab_EquilibraTrabalhoTarefasDescanso),
  HigienePessoal: (o) => FREQ.slice(1, 5).includes(o.cab_FrequenciaHigieneCorporalCapilar),
  MedicacaoSegura: (o) => (o.cab_QtdMedicamentos || []).some((m) => { const n = m.replace(/\D/g, '');
    return o['cab_3PergMedicacaoUsoContinua' + n] === 'Não' || ['Ocasionalmente', 'Raramente', 'Nunca'].includes(o['cab_UsoMedicacaoConformeOrientado' + n]) || o['cab_ArmazenamentoAdequado' + n] === 'Não'; }),
  SaudeBucal: (o) => FREQ.slice(1, 5).includes(o.cab_FrequenciaHigieneBucal),
  SaudeComplEnc: (o) => CONSULTA.slice(1).some((v) => v === o.cab_UltimaConsultaComMedico || v === o.cab_UltimaConsultaComDentista),
  SaudeMental: (o) => ['Uma pessoa triste', 'Uma pessoa ansiosa', 'Uma pessoa estressada/irritada', 'Uma pessoa desanimada'].includes(o.cab_ComoConsidera),
  SaudeSono: (o) => FREQ.slice(2, 5).includes(o.cab_ConsideraDormiuBem),
  SaudeTrabalhador: (o) => (o.cab_PrincipaisRiscosAssociadosTrabalhoDiario || []).some((x) => x !== 'Não foram identificados riscos'),
  SaudePele: (o) => (o.cab_PrincipaisRiscosAssociadosTrabalhoDiario || []).includes('Exposição à Luz Solar Intensa'),
  Vacinacao: (o) => Object.keys(o).some((k) => (/^cab_RecebeuVacinasLC|^cab_RecebeuTodasVacinasLC/.test(k) && VACINAS.slice(1).includes(o[k])) || (/^cab_CartaoVacinaApresentadoLC/.test(k) && o[k] === 'Não encontrou o cartão de vacina')),
  CessacaoTabagismo: (o) => o.cab_PrentendeParaFumarProtocoloTabagismo === 'Sim',
};
const temaAtivo = (cod, rot, o, d) => (META_AUTO[cod] ? META_AUTO[cod](o) : false) || ((d || o).ate_AdicionarOutrasMetas || []).includes(rot);
function camposMeta(cod, rot) {
  const out = [];
  ['', '1', '2'].forEach((s, i) => {
    const K = (b) => b + cod + s;
    const aberta = i === 0 ? () => true : (o) => o['ate_AdicionarNovaMeta' + cod + (i === 1 ? '' : String(i - 1))] === 'Sim';
    const on = (o) => aberta(o) && o[K('ate_AtivarMeta')] === 'Iniciar acompanhamento do autocuidado';
    const st = (v) => (o) => on(o) && o[K('ate_Reavaliacao')] === v;
    if (i) out.push({ t: 'titulo', l: `${rot} — meta ${i + 1}`, se: aberta });
    out.push(
      { k: K('ate_AtivarMeta'), l: rot, t: 'chk', v: 'Iniciar acompanhamento do autocuidado', se: aberta },
      { k: K('ate_Detalhamento'), l: 'Detalhamento / Motivo do compromisso / Justificativa', t: 'area', req: true, se: on },
      { k: K('ate_NivelInteresse'), l: 'Nível de interesse', t: 'rad', o: ESC10, linha: true, req: true, se: on },
      { k: K('ate_GrauConfianca'), l: 'Grau de confiança', t: 'rad', o: ESC10, linha: true, req: true, se: on },
      { k: K('ate_ValidacaoAlertaInteresseConfianca'), t: 'info', calc: (o) => alertaIC(o[K('ate_NivelInteresse')], o[K('ate_GrauConfianca')]), texto: (v) => ALERTAS_IC[v], se: on },
      { k: K('ate_Reavaliacao'), l: 'Status da Meta', t: 'rad', o: ['Pactuação de Meta', 'Manter meta', 'Concluir meta', 'Cancelar meta'], linha: true, req: true, se: on },
      { k: K('ate_DetalhamentoManterMeta'), l: 'Acompanhamento do compromisso', t: 'area', req: true, se: st('Manter meta') },
      { k: K('ate_NivelInteresseManter'), l: 'Nível de interesse', t: 'rad', o: ESC10, linha: true, req: true, se: st('Manter meta') },
      { k: K('ate_GrauConfiancaManter'), l: 'Grau de confiança', t: 'rad', o: ESC10, linha: true, req: true, se: st('Manter meta') },
      { k: K('ate_ValidacaoAlertaManterInteresseConfianca'), t: 'info', calc: (o) => alertaIC(o[K('ate_NivelInteresseManter')], o[K('ate_GrauConfiancaManter')]), texto: (v) => ALERTAS_IC[v], se: st('Manter meta') },
      { k: K('ate_DetalhamentoCancelarMeta'), l: 'Detalhamento da justificativa', t: 'area', req: true, se: st('Cancelar meta') },
      { k: K('ate_DetalhamentoConquistaMeta'), l: 'Detalhamento da conquista', t: 'area', req: true, se: st('Concluir meta') },
      { k: K('ate_DataFimMeta'), l: 'Data Fim', t: 'date', req: true, se: st('Concluir meta') },
      { k: K('ate_Conquistas'), l: 'Conquistas alcançadas:', t: 'area', req: true, ph: 'Opções não capturadas do SDE: descreva', se: st('Concluir meta') });
    if (i < 2) out.push({ k: K('ate_AdicionarNovaMeta'), l: 'Deseja adicionar uma nova meta para este tema?', t: 'chk', v: 'Sim', se: on });
  });
  return out;
}
const PROCS = ['Peso', 'Altura', 'IMC', 'Perímetro encefálico', 'Pressão arterial', 'Frequência cardíaca', 'Frequência respiratória', 'Glicemia capilar', 'Circunferência abdominal', 'Saturação', 'Temperatura', 'Outro'];
const proc = (p) => todos(eq('ate_RealizadoAlgumProcedimento', 'Sim'), tem('cab_TipoProcedimento', p));
const doPerfil = (k) => (o) => (o.ate_UtilizarDadosPerfil === 'Sim' ? o[k] || '' : '');
function imcProc(o) { const p = num(o.cab_PesoProcedimentos || doPerfil('cab_Peso')(o)); let a = num(o.cab_AlturaProcedimentos || doPerfil('cab_Altura')(o));
  if (!p || !a) return ''; if (a > 3) a /= 100; const v = p / (a * a); return isFinite(v) ? v.toFixed(2).replace('.', ',') : ''; }
const ACOMP = [
  { t: 'titulo', l: 'AutoCuidado' },
  { k: 'ate_EstadoSaudeUltimosDias', l: 'Nos últimos dias, como está o seu estado de saúde?', t: 'rad', o: ['Muito bom', 'Bom', 'Regular', 'Ruim', 'Muito ruim'], linha: true, req: true },
  { k: 'ate_TemSeSentido', l: 'Tem se sentido...', t: 'multi', req: true,
    o: ['Uma pessoa ansiosa', 'Uma pessoa bem-disposta', 'Uma pessoa calma', 'Uma pessoa cansada', 'Uma pessoa desanimada', 'Uma pessoa estressada/irritada', 'Uma pessoa feliz', 'Uma pessoa triste'] },
  { t: 'titulo', l: 'Planejamento AutoCuidado' },
  { t: 'info', k: '_temasPerfil', calc: (o) => { const a = TEMAS.filter(([c]) => META_AUTO[c] && META_AUTO[c](o)).map(([, r]) => r);
    return a.length ? 'Temas ativados pelo perfil de saúde: ' + a.join(', ') + '.' : 'Nenhum tema ativado pelo perfil de saúde. Inclua temas abaixo, se for o caso.'; } },
  { t: 'cada', k: '_metas', titulo: (x) => x.l, itens: (o, d) => TEMAS.filter(([c, r]) => temaAtivo(c, r, o, d)).map(([c, r]) => ({ id: c, l: r })), campos: (x) => camposMeta(x.id, x.l) },
  { k: 'ate_AdicionarOutrasMetas', l: 'Deseja adicionar metas não mapeadas no perfil?', t: 'multi', o: TEMAS.map(([, r]) => r) },
  { t: 'titulo', l: 'Conquista não pactuada previamente' },
  { k: 'cab_ConquistaAlcancada', l: 'O assistido teve alguma conquista não pactuada previamente?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_MetasNaoPactuadas', l: 'Categoria da conquista', t: 'multi', o: TEMAS.filter(([c]) => c !== 'CessacaoTabagismo').map(([, r]) => r), req: true, se: eq('cab_ConquistaAlcancada', 'Sim') },
  { t: 'cada', k: '_conquistas', titulo: (x) => 'Conquista: ' + x.l, se: eq('cab_ConquistaAlcancada', 'Sim'),
    itens: (o) => (o.cab_MetasNaoPactuadas || []).map((r) => ({ id: (TEMAS.find((t) => t[1] === r) || [codigo(r)])[0], l: r })),
    campos: (x) => [
      { k: 'cab_QuemPercebeuConquista' + x.id, l: 'Quem percebeu essa conquista inicialmente?', t: 'text', req: true, ph: 'Opções não capturadas do SDE: descreva' },
      { k: 'cab_DetalhamentoConquista' + x.id, l: 'Detalhamento da conquista', t: 'area', req: true }] },
  { t: 'titulo', l: 'Procedimentos' },
  { k: 'ate_RealizadoAlgumProcedimento', l: 'Foi realizado algum procedimento?', t: 'rad', o: SN, linha: true, req: true },
  { k: 'cab_TipoProcedimento', l: 'Selecione os procedimentos que serão avaliados:', t: 'multi', o: PROCS, se: eq('ate_RealizadoAlgumProcedimento', 'Sim') },
  { k: 'ate_UtilizarDadosPerfil', l: 'Deseja utilizar as aferições marcadas no perfil de saúde?', t: 'rad', o: SN, linha: true, se: eq('ate_RealizadoAlgumProcedimento', 'Sim') },
  { k: 'cab_PesoProcedimentos', l: 'Peso', t: 'num', dec: true, req: true, def: doPerfil('cab_Peso'), se: proc('Peso') },
  { k: 'cab_AlturaProcedimentos', l: 'Altura', t: 'num', dec: true, req: true, def: doPerfil('cab_Altura'), se: proc('Altura') },
  { k: 'cab_IMCProcedimentos', l: 'IMC', t: 'calc', calc: imcProc, se: proc('IMC') },
  { k: 'cab_PerimetroEncefalicoProcedimentos', l: 'Perímetro encefálico', t: 'num', dec: true, req: true, se: proc('Perímetro encefálico') },
  { k: 'ate_PressaoArterialSistolica', l: 'Sistólica', t: 'num', req: true, def: doPerfil('cab_PressaoArterialSistolica'), se: proc('Pressão arterial') },
  { k: 'ate_PressaoArterialDiastolica', l: 'Diastólica', t: 'num', req: true, def: doPerfil('cab_PressaoArterialDiastolica'), se: proc('Pressão arterial') },
  { k: 'cab_FrequenciaCardiacaProcedimentos', l: 'Frequência cardíaca', t: 'num', req: true, se: proc('Frequência cardíaca') },
  { k: 'cab_FrequenciaRespiratoriaProcedimentos', l: 'Frequência respiratória', t: 'num', req: true, se: proc('Frequência respiratória') },
  { k: 'cab_GlicemiaCapilarProcedimentos', l: 'Glicemia capilar', t: 'num', req: true, se: proc('Glicemia capilar') },
  { k: 'cab_CircunferenciaAbdominalProcedimentos', l: 'Circunferência abdominal', t: 'num', dec: true, req: true, se: proc('Circunferência abdominal') },
  { k: 'cab_SaturacaoProcedimentos', l: 'Saturação', t: 'num', req: true, se: proc('Saturação') },
  { k: 'cab_TemperaturaProcedimentos', l: 'Temperatura', t: 'num', dec: true, req: true, se: proc('Temperatura') },
  { k: 'cab_OutroProcedimento', l: 'Outro', t: 'text', req: true, se: proc('Outro') },
  { t: 'titulo', l: 'Acionamento de Teleconsulta' },
  { k: 'ate_AcionarEspecialista', l: 'Deseja acionar a Teleconsulta (Especialista Einstein)?', t: 'rad', o: SN, linha: true, req: true },
  notaLivre('Sem o SDE, a Teleconsulta não é acionada por este app. Registre aqui e acione pelo SDE (ou pelo canal de contingência da coordenação) assim que possível. Em urgência, siga o fluxo local (SAMU 192).', eq('ate_AcionarEspecialista', 'Sim')),
  { k: 'ate_TipoAtendimento', l: 'Selecione a especialidade / Tipo de Atendimento', t: 'rad', o: ['Clínica Médica', 'Pediatria', 'Psicologia', 'Enfermagem'], req: true, se: eq('ate_AcionarEspecialista', 'Sim') },
  { k: 'ate_MotivoAcionamento', l: 'Motivo do Acionamento', t: 'area', req: true, se: eq('ate_AcionarEspecialista', 'Sim') },
  { k: 'ate_BreveResumo', l: 'Breve Resumo', t: 'area', se: eq('ate_AcionarEspecialista', 'Não') },
];

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
function podar(schema, base, dados) {
  const c = { ...base }; const vis = new Set(); const itens = new Map(); const campos = [];
  const passo = (f) => {
    const ok = !f.se || f.se(c);
    if (f.t === 'cada') {
      const its = ok ? f.itens(c, dados) : []; itens.set(f, its);
      for (const x of its) for (const g of camposDe(f, x)) passo(g);
      return;
    }
    if (!ok) return;
    vis.add(f);
    if (f.t === 'titulo') return;
    if (f.k && f.k in dados) c[f.k] = dados[f.k];
    campos.push(f);
  };
  schema.forEach(passo);
  return { c, vis, itens, campos };
}
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
        node.hidden = !r.vis.has(f);
        if (f.t === 'calc') node.querySelector('.calc').textContent = f.calc(r.c) || '—';
        if (f.t === 'info') { const v = r.vis.has(f) ? f.calc(r.c) : ''; node.querySelector('.infoTxt').textContent = v ? (f.texto ? f.texto(v) : v) : ''; if (!v) node.hidden = true; }
        if (f.def) { const i = node.querySelector('input'); if (i) i.placeholder = f.def(r.c) ? 'Do perfil: ' + f.def(r.c) : f.ph || ''; }
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
  return podar(schema, base || {}, dados).campos.filter((f) => f.req && vazio(dados[f.k]) && !(f.def && f.def({ ...base, ...dados }))).map((f) => f.l);
}
const basePerfil = (a) => a.cadastro;
const baseAcomp = (a) => ({ ...a.cadastro, ...podar(F.perfil, a.cadastro, a.perfil).c });

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
  for (const x of faltando(F.visita, V.visita)) av.push('Dados da visita: ' + x);
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
  if (f.t === 'calc' || f.t === 'info') return f.calc(c) || '';
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
    if (!f.k || f.k[0] === '_' || (f.t === 'info' && !f.texto)) continue;
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
