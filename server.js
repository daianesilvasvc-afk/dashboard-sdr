const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.PIPEDRIVE_TOKEN || '';

const SDR_NAMES = {
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
  return new Promise(function(resolve, reject) {
    var sep = endpoint.indexOf('?') >= 0 ? '&' : '?';
    var reqUrl = 'https://api.pipedrive.com/v1' + endpoint + sep + 'api_token=' + API_TOKEN;
    https.get(reqUrl, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchAllActivities(days) {
  var since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  var all = [];
  var start = 0;
  function fetchPage() {
    return pipedriveGet('/activities?limit=500&start=' + start + '&start_date=' + since + '&sort=add_time+DESC')
      .then(function(d) {
        var acts = d.data || [];
        all = all.concat(acts);
        var pagination = d.additional_data && d.additional_data.pagination;
        var hasMore = pagination && pagination.more_items_in_collection;
        if (hasMore && start < 5000) { start += 500; return fetchPage(); }
        return all;
      });
  }
  return fetchPage();
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function processActivities(acts) {
  var sdrIds = Object.keys(SDR_NAMES).map(Number);
  var map = {};
  Object.keys(SDR_NAMES).forEach(function(id) {
    map[id] = { name: SDR_NAMES[id], agendados: 0, realizados: 0, noshows: 0, cancelados: 0, vendas: 0, reagend: 0 };
  });
  var sdrSubjects = {};

  acts.forEach(function(a) {
    var sdrId = null;
    var fields = [a.assigned_to_user_id, a.owner_id, a.user_id, a.created_by_user_id];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && sdrIds.indexOf(fields[i]) >= 0) { sdrId = fields[i]; break; }
    }
    if (!sdrId) return;
    var sdr = map[sdrId];
    if (!sdr) return;
    if (a.subject) sdrSubjects[a.subject] = true;
    var s = norm(a.subject);
    if (s.indexOf('reuniao agendada') >= 0 || (s.indexOf('reuni') >= 0 && s.indexOf('agend') >= 0)) sdr.agendados++;
    if (s.indexOf('reuniao realizada') >= 0 || s.indexOf('2o realizada') >= 0 || s.indexOf('2a realizada') >= 0) sdr.realizados++;
    if (s.indexOf('venda') >= 0 && s.indexOf('sdr') >= 0) { sdr.realizados++; sdr.vendas++; }
    if (s.indexOf('no show') >= 0 || s.indexOf('noshow') >= 0) sdr.noshows++;
    if (s.indexOf('cancelou') >= 0 || s.indexOf('cancelad') >= 0) sdr.cancelados++;
    if (s.indexOf('reagendamento') >= 0 || s.indexOf('reagend') >= 0) sdr.reagend++;
  });

  return { sdrs: Object.values(map), sdr_subjects: Object.keys(sdrSubjects).sort() };
}

function handleApi(req, res, parsedUrl) {
  var days = parseInt(parsedUrl.query.days) || 30;
  fetchAllActivities(days).then(function(acts) {
    var result = processActivities(acts);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sdrs: result.sdrs, total_acts: acts.length, sdr_subjects: result.sdr_subjects, updated: new Date().toISOString() }));
  }).catch(function(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
}

function handleDebug(req, res) {
  Promise.all([
    fetchAllActivities(30),
    pipedriveGet('/users')
  ]).then(function(results) {
    var acts = results[0];
    var users = results[1].data || [];
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u.name; });

    // Conta atividades por cada campo de user
    var counts = {};
    acts.forEach(function(a) {
      var fields = {
        user_id: a.user_id,
        owner_id: a.owner_id,
        assigned_to_user_id: a.assigned_to_user_id,
        created_by_user_id: a.created_by_user_id
      };
      Object.keys(fields).forEach(function(field) {
        var uid = fields[field];
        if (!uid) return;
        var key = field + '_' + uid;
        if (!counts[key]) counts[key] = { field: field, user_id: uid, name: userMap[uid] || 'ID:'+uid, count: 0 };
        counts[key].count++;
      });
    });

    // Ordena por contagem
    var sorted = Object.values(counts).sort(function(a,b) { return b.count - a.count; }).slice(0, 40);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ total_acts: acts.length, top_users_by_field: sorted }));
  }).catch(function(e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
}

function serveStatic(req, res) {
  var filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  var ext = path.extname(filePath);
  var mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
}

var server = http.createServer(function(req, res) {
  var parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/api/sdrs') handleApi(req, res, parsedUrl);
  else if (parsedUrl.pathname === '/api/debug') handleDebug(req, res);
  else serveStatic(req, res);
});

server.listen(PORT, function() { console.log('Dashboard rodando na porta ' + PORT); });
