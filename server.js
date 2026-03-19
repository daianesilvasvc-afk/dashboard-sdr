const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PIPEDRIVE_KEY = process.env.PIPEDRIVE_API_KEY;

app.use(express.static(path.join(__dirname, 'public')));

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getPeriodDates(mode) {
  const now = new Date();
  let start;
  if (mode === 'week') {
    start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);
  } else if (mode === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else { // 30days
    start = new Date(now);
    start.setDate(now.getDate() - 30);
  }
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

async function pipedriveGet(path) {
  const url = `https://api.pipedrive.com/v1${path}${path.includes('?') ? '&' : '?'}api_token=${PIPEDRIVE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pipedrive error ${res.status}: ${path}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Pipedrive API error');
  return json.data || [];
}

async function fetchAllActivities() {
  let all = [], start = 0;
  while (true) {
    const [done, open] = await Promise.all([
      pipedriveGet(`/activities?done=1&limit=500&start=${start}`),
      pipedriveGet(`/activities?done=0&limit=500&start=${start}`),
    ]);
    all = [...all, ...(done || []), ...(open || [])];
    if ((done || []).length < 500 && (open || []).length < 500) break;
    start += 500;
    if (start > 15000) break;
  }
  return all;
}

// ─── TYPE CLASSIFICATION ─────────────────────────────────────────────────────
const TYPE_RULES = [
  { prefix: 'reuniao_realizada',        group: 'realizada',     label: 'Reunião realizada',       countsMeta: true  },
  { prefix: 'sdr_venda_feita',          group: 'venda',         label: 'Venda pelo SDR',          countsMeta: true  },
  { prefix: 'ligacao_de_prospeccaonao', group: 'ligacao',       label: 'Ligação não atendida',    countsMeta: false },
  { prefix: 'ligacao_de_prospeccao',    group: 'ligacao',       label: 'Ligação de prospecção',   countsMeta: false },
  { prefix: 'ligacao_atendida',         group: 'ligacao',       label: 'Ligação atendida',        countsMeta: false },
  { prefix: 'ligacao_de_fechamento',    group: 'fechamento',    label: 'Follow-up fechamento',    countsMeta: false },
  { prefix: 'ligacao_atendidar',        group: 'ligacao',       label: 'Ligação — retornar',      countsMeta: false },
  { prefix: 'ccl___ligacao',            group: 'ligacao_ccl',   label: 'Ligação CCL',             countsMeta: false },
  { prefix: '1o_tentativa_de_whatsapp', group: 'whatsapp',      label: '1ª Tentativa WhatsApp',   countsMeta: false },
  { prefix: '2o_tentativa_de_whatsapp', group: 'whatsapp',      label: '2ª Tentativa WhatsApp',   countsMeta: false },
  { prefix: '3o_tentativa_de_whatsapp', group: 'whatsapp',      label: '3ª Tentativa WhatsApp',   countsMeta: false },
  { prefix: '4o_tentativa_de_whatsapp', group: 'whatsapp',      label: '4ª Tentativa WhatsApp',   countsMeta: false },
  { prefix: '5o_tentativa_de_whatsapp', group: 'whatsapp',      label: '5ª Tentativa WhatsApp',   countsMeta: false },
  { prefix: 'confirmacao_de_presenca',  group: 'confirmacao',   label: 'Confirmação de presença', countsMeta: false },
  { prefix: '1o_confirmacao',           group: 'confirmacao',   label: '1ª Confirmação',          countsMeta: false },
  { prefix: '2o_confirmacao',           group: 'confirmacao',   label: '2ª Confirmação',          countsMeta: false },
  { prefix: '3o_confirmacao',           group: 'confirmacao',   label: '3ª Confirmação',          countsMeta: false },
  { prefix: 'mensagem_de_30_min',       group: 'confirmacao',   label: 'WhatsApp 30min antes',    countsMeta: false },
  { prefix: 'mensagem_apos_no_show',    group: 'noshow',        label: 'Mensagem pós no-show',    countsMeta: false },
  { prefix: 'no_show',                  group: 'noshow',        label: 'No show',                 countsMeta: false },
  { prefix: 'auto_agendamento',         group: 'autoagend',     label: 'Auto agendamento',        countsMeta: false },
  { prefix: 'auto_agenadmento',         group: 'autoagend',     label: 'Auto agend.',             countsMeta: false },
  { prefix: 'reagendamento',            group: 'reagendamento', label: 'Reagendamento',           countsMeta: false },
  { prefix: 'sdr_lead_cancelou',        group: 'cancelamento',  label: 'Lead cancelou',           countsMeta: false },
  { prefix: 'sdr_oportunidade',         group: 'oportunidade',  label: 'Oportunidade cash',       countsMeta: false },
  { prefix: 'closer_fupreativacao',     group: 'reativacao',    label: 'Reativação de base',      countsMeta: false },
  { prefix: 'depoimento',               group: 'fechamento',    label: 'Depoimento',              countsMeta: false },
  { prefix: 'coleta_de_dados',          group: 'pos_venda',     label: 'Coleta pós-venda',        countsMeta: false },
  { prefix: 'call',                     group: 'ligacao',       label: 'Ligação',                 countsMeta: false },
];

function norm(s) { return (s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function classifyType(type) {
  const t = norm(type);
  for (const r of TYPE_RULES) { if (t.startsWith(r.prefix)) return r; }
  return null;
}

const SDR_NAMES = new Set([
  'Edrius Vieira', 'Fernanda Piemonte', 'João Madeira', 'Kauai Moro',
  'Kevin Amaro de Sousa', 'Lais', 'Luiz Roos', 'Nátali Helena', 'Samuel', 'Thiago Palivoda'
]);

// ─── API ENDPOINT ─────────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const mode = req.query.period || 'month';
    const { start, end } = getPeriodDates(mode);

    // Busca todos os usuários (ativos e inativos)
    const [usersActive, usersAll, allActs] = await Promise.all([
      pipedriveGet('/users?limit=500'),
      pipedriveGet('/users?limit=500&filter_id=0').catch(() => []),
      fetchAllActivities(),
    ]);

    // Mapa id → nome — inclui usuários deletados conhecidos
    const idToName = {};
    [...(usersActive || []), ...(usersAll || [])].forEach(u => {
      if (u && u.id && u.name) idToName[u.id] = u.name;
    });
    // IDs de ex-SDRs deletados do Pipedrive — mapeados manualmente
    // (aparecem em created_by_user_id mas não existem mais em /users)
    const DELETED_USERS = {
      23137369: 'Ex-SDR 1',
      22232696: 'Ex-SDR 2',
      24072512: 'Ex-SDR 3',
      25447600: 'Ex-SDR 4',
      21461662: 'Ex-SDR 5',
      22908184: 'Ex-SDR 6',
      21461629: 'Ex-SDR 7',
    };
    Object.entries(DELETED_USERS).forEach(([id, name]) => {
      if (!idToName[id]) idToName[id] = name;
    });

    // Filtra por período
    const acts = allActs.filter(a => {
      const raw = a.due_date || a.add_time || '';
      if (!raw) return false;
      const dt = new Date(raw.length === 10 ? raw + 'T12:00:00' : raw);
      return dt >= start && dt <= end;
    });

    // Agrupa por nome — tenta extrair nome de múltiplos campos
    const uMap = {};
    const globalGroup = {};

    acts.forEach(a => {
      // Tenta extrair id e nome do created_by_user_id
      let name = null;
      if (a.created_by_user_id) {
        const v = a.created_by_user_id;
        const id = typeof v === 'object' ? v?.id : v;
        const nameFromObj = typeof v === 'object' ? v?.name : null;
        name = idToName[id] || nameFromObj;
      }
      // Fallback: user_id
      if (!name && a.user_id) {
        const v = a.user_id;
        const id = typeof v === 'object' ? v?.id : v;
        const nameFromObj = typeof v === 'object' ? v?.name : null;
        name = idToName[id] || nameFromObj;
      }
      if (!name) return;

      if (!uMap[name]) uMap[name] = {
        name,
        byGroup: {}, realizadas: 0, ligacoes: 0,
        whatsapp: 0, noshow: 0, vendas: 0, total: 0
      };

      const u = uMap[name];
      const info = classifyType(a.type);
      u.total++;
      if (!info) return;

      const g = info.group;
      u.byGroup[g] = (u.byGroup[g] || 0) + 1;
      globalGroup[g] = (globalGroup[g] || 0) + 1;
      if (info.countsMeta) u.realizadas++;
      if (g === 'ligacao' || g === 'ligacao_ccl') u.ligacoes++;
      if (g === 'whatsapp') u.whatsapp++;
      if (g === 'noshow') u.noshow++;
      if (g === 'venda') u.vendas++;
    });

    // Seed — garante que todos os 10 SDRs aparecem mesmo com zero atividades
    const ALL_SDRS = [
      'Edrius Vieira','Fernanda Piemonte','João Madeira','Kauai Moro',
      'Kevin Amaro de Sousa','Lais','Luiz Roos','Nátali Helena','Samuel','Thiago Palivoda'
    ];
    ALL_SDRS.forEach(name => {
      if (!uMap[name]) uMap[name] = {
        name, byGroup: {}, realizadas: 0, ligacoes: 0,
        whatsapp: 0, noshow: 0, vendas: 0, total: 0
      };
    });

    // Filtra apenas SDRs do time atual — mostra todos mesmo com zero
    const sdrs = Object.values(uMap)
      .filter(s => SDR_NAMES.has(s.name))
      .sort((a, b) => b.realizadas - a.realizadas);

    const META_GOAL = 80;
    const totR = sdrs.reduce((s, u) => s + u.realizadas, 0);
    const totL = sdrs.reduce((s, u) => s + u.ligacoes, 0);
    const totW = sdrs.reduce((s, u) => s + u.whatsapp, 0);
    const totN = sdrs.reduce((s, u) => s + u.noshow, 0);
    const totV = sdrs.reduce((s, u) => s + u.vendas, 0);
    const metaTotal = sdrs.length * META_GOAL;
    const pctTime = metaTotal > 0 ? Math.round((totR / metaTotal) * 100) : 0;

    const pLabels = { month: 'Este mês', week: 'Esta semana', '30days': 'Últimos 30 dias' };
    const updatedAt = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    res.json({
      period: pLabels[mode] || mode,
      updated_at: updatedAt,
      total_activities: acts.length,
      summary: {
        realizadas: totR,
        ligacoes: totL,
        whatsapp: totW,
        noshow: totN,
        vendas: totV,
        pct_meta: pctTime,
        meta_total: metaTotal,
        sdrs_acima: sdrs.filter(s => s.realizadas >= META_GOAL).length,
        sdrs_faixa: sdrs.filter(s => s.realizadas >= 60 && s.realizadas < META_GOAL).length,
        sdrs_abaixo: sdrs.filter(s => s.realizadas < 60).length,
      },
      sdrs: sdrs.map((s, i) => ({
        position: i + 1,
        name: s.name,
        realizadas: s.realizadas,
        pct_meta: Math.round((s.realizadas / META_GOAL) * 100),
        ligacoes: s.ligacoes,
        whatsapp: s.whatsapp,
        noshow: s.noshow,
        vendas: s.vendas,
        total: s.total,
        byGroup: s.byGroup,
      })),
      globalGroup,
      funil: {
        ligacoes: globalGroup['ligacao'] || 0,
        whatsapp: globalGroup['whatsapp'] || 0,
        confirmacoes: globalGroup['confirmacao'] || 0,
        autoagend: globalGroup['autoagend'] || 0,
        realizadas: globalGroup['realizada'] || 0,
        reagendamentos: globalGroup['reagendamento'] || 0,
        noshow: globalGroup['noshow'] || 0,
        cancelamentos: globalGroup['cancelamento'] || 0,
        vendas: globalGroup['venda'] || 0,
        fechamento: globalGroup['fechamento'] || 0,
      },
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard Podium rodando na porta ${PORT}`);
});

// Endpoint de debug — mostra usuários e campos de atividades
app.get('/api/debug', async (req, res) => {
  try {
    const [users, acts] = await Promise.all([
      pipedriveGet('/users?limit=500'),
      pipedriveGet('/activities?done=1&limit=20&start=0'),
    ]);
    const userMap = {};
    (users||[]).forEach(u => { userMap[u.id] = u.name; });

    // Conta atividades por created_by_user_id
    const allActs2 = await pipedriveGet('/activities?done=0&limit=500&start=0');
    const allActs1 = await pipedriveGet('/activities?done=1&limit=500&start=0');
    const all = [...(allActs1||[]), ...(allActs2||[])];
    const byCreator = {};
    all.forEach(a => {
      const v = a.created_by_user_id;
      const id = typeof v === 'object' ? v?.id : v;
      const nameFromObj = typeof v === 'object' ? v?.name : null;
      const name = userMap[id] || nameFromObj || '— (id: '+id+')';
      byCreator[name] = (byCreator[name] || 0) + 1;
    });

    res.json({
      total_users: (users||[]).length,
      users: (users||[]).map(u => ({ id: u.id, name: u.name, active: u.active_flag })),
      total_acts_sample: all.length,
      by_creator: byCreator,
      sample_act_fields: (acts||[]).slice(0,3).map(a => ({
        subject: a.subject,
        type: a.type,
        user_id: a.user_id,
        created_by_user_id: a.created_by_user_id,
      }))
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
