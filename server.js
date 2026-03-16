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
  25862025: 'Joao Madeira',
  24713317: 'Kauai Moro',
  25394932: 'Kevin Amaro de Sousa',
  25609278: 'Lais',
  25862036: 'Luiz Roos',
  24832491: 'Natali Helena',
};

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
        if (hasMore && start < 5000) {
          start += 500;
          return fetchPage();
        }
        return all;
      });
  }
  return fetchPage();
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function processActivities(acts) {
  var sdrIdSet = Object.keys(SDR_IDS).map(Number);

  var map = {};
  Object.keys(SDR_NAMES).forEach(function(id) {
    map[id] = { name: SDR_NAMES[id], agendados: 0, realizados: 0, noshows: 0, cancelados: 0, vendas: 0, reagend: 0 };
  });

  var fieldHits = { user_id: 0, owner_id: 0, assigned_to_user_id: 0, created_by_user_id: 0 };
  var sdrSubjects = {};

  acts.forEach(function(a) {
    // conta hits por campo
    if (a.user_id && sdrIdSet.indexOf(a.user_id) >= 0) fieldHits.user_id++;
    if (a.owner_id && sdrIdSet.indexOf(a.owner_id) >= 0) fieldHits.owner_id++;
    if (a.assigned_to_user_id && sdrIdSet.indexOf(a.assigned_to_user_id) >= 0) fieldHits.assigned_to_user_id++;
    if (a.created_by_user_id && sdrIdSet.indexOf(a.created_by_user_id) >= 0) fieldHits.created_by_user_id++;

    // pega o id do SDR pelo melhor campo disponível
    var sdrId = null;
    if (a.assigned_to_user_id && sdrIdSet.indexOf(a.assigned_to_user_id) >= 0) sdrId = a.assigned_to_user_id;
    else if (a.owner_id && sdrIdSet.indexOf(a.owner_id) >= 0) sdrId = a.owner_id;
    else if (a.user_id && sdrIdSet.indexOf(a.user_id) >= 0) sdrId = a.user_id;
    else if (a.created_by_user_id && sdrIdSet.indexOf(a.created_by_user_id) >= 0) sdrId = a.created_by_user_id;

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

  return {
    sdrs: Object.values(map),
    field_hits: fieldHits,
    sdr_subjects: Object.keys(sdrSubjects).sort().slice(0, 50),
  };
}

function handleApi(req, res, parsedUrl) {
  var days = parseInt(parsedUrl.query.days) || 30;
  fetchAllActivities(days)
    .then(function(acts) {
      var result = processActivities(acts);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ sdrs: result.sdrs, total_acts: acts.length, field_hits: result.field_hits, sdr_subjects: result.sdr_subjects, updated: new Date().toISOString() }));
    })
    .catch(function(e) {
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
  if (parsedUrl.pathname === '/api/sdrs') {
    handleApi(req, res, parsedUrl);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, function() { console.log('Dashboard rodando na porta ' + PORT); });
