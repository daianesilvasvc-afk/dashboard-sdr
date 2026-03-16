const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.PIPEDRIVE_TOKEN || '';

const SDR_IDS = {
  25471514: 'Edrius Vieira',
  25753510: 'Fernanda Piemonte',
  25862025: 'João Madeira',
  24713317: 'Kauai Moro',
  25394932: 'Kevin Amaro de Sousa',
  25609278: 'Lais',
  25862036: 'Luiz Roos',
  24832491: 'Nátali Helena',
};

function pipedriveGet(endpoint) {
  return new Promise((resolve, reject) => {
    const sep = endpoint.includes('?') ? '&' : '?';
    const reqUrl = `https://api.pipedrive.com/v1${endpoint}${sep}api_token=${API_TOKEN}`;
    https.get(reqUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchAllActivities(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  let all = [], start = 0;
  while (true) {
    const d = await pipedriveGet(`/activities?limit=500&start=${start}&start_date=${since}&sort=add_time+DESC`);
    const acts = d.data || [];
    all = all.concat(acts);
    if (!d.additional_data?.pagination?.more_items_in_collection) break;
    start += 500;
    if (start > 5000) break;
  }
  return all;
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function processActivities(acts, users) {
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  const sdrIdSet = new Set(Object.keys(SDR_IDS).map(Number));

  const map = {};
  Object.entries(SDR_IDS).forEach(([id, name]) => {
    map[id] = { name, agendados: 0, realizados: 0, noshows: 0, cancelados: 0, vendas: 0, reagend: 0 };
  });

  // Diagnóstico: quais campos têm IDs dos SDRs
  const fieldHits = { user_id: 0, owner_id: 0, assigned_to_user_id: 0, created_by_user_id: 0 };
  const sdrSubjects = new Set();

  acts.forEach(a => {
    // Testa todos os campos possíveis
    const fields = {
      user_id: a.user_id,
      owner_id: a.owner_id,
      assigned_to_user_id: a.assigned_to_user_id,
      created_by_user_id: a.created_by_user_id,
    };

    Object.entries(fields).forEach(([field, val]) => {
      if (val && sdrIdSet.has(val)) fieldHits[field]++;
    });

    // Usa o campo que tiver ID de SDR — prioridade: assigned > owner > user > created
    const sdrId = (sdrIdSet.has(a.assigned_to_user_id) && a.assigned_to_user_id) ||
                  (sdrIdSet.has(a.owner_id) && a.owner_id) ||
                  (sdrIdSet.has(a.user_id) && a.user_id) ||
                  (sdrIdSet.has(a.created_by_user_id) && a.created_by_user_id);

    if (!sdrId) return;
    const sdr = map[sdrId];
    if (!sdr) return;

    if (a.subject) sdrSubjects.add(a.subject);

    const s = norm(a.subject);
    if (s.includes('reuniao agendada') || (s.includes('reuni') && s.includes('agend'))) sdr.agendados++;
    if (s.includes('reuniao realizada') || s.includes('2o realizada') || s.includes('2a realizada') || (s.includes('venda') && s.includes('sdr'))) sdr.realizados++;
    if (s.includes('no show') || s.includes('noshow')) sdr.noshows++;
    if (s.includes('cancelou') || s.includes('cancelad')) sdr.cancelados++;
    if (s.includes('venda') && s.includes('sdr')) sdr.vendas++;
    if (s.includes('reagendamento') || s.includes('reagend')) sdr.reagend++;
  });

  return {
    sdrs: Object.values(map),
    field_hits: fieldHits,
    sdr_subjects: [...sdrSubjects].sort().slice(0, 30),
  };
}

async function handleApi(req, res, parsedUrl) {
  const days = parseInt(parsedUrl.query.days) || 30;
  try {
    const [acts, usersData] = await Promise.all([
      fetchAllActivities(days),
      pipedriveGet('/users')
    ]);
    const users = usersData.data || [];
    const { sdrs, field_hits, sdr_subjects } = processActivities(acts, users);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sdrs, total_acts: acts.length, field_hits, sdr_subjects, updated: new Date().toISOString() }));
  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/api/sdrs') {
    await handleApi(req, res, parsedUrl);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
