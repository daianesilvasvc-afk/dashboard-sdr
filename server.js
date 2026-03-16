const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.PIPEDRIVE_TOKEN || '';
const SLA_MINUTOS = 10;

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

// Busca campo personalizado pelo nome
function findCustomField(fields, name) {
  var norm = name.toLowerCase();
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].name && fields[i].name.toLowerCase().indexOf(norm) >= 0) {
      return fields[i].key;
    }
  }
  return null;
}

// Busca todos os deals de um pipeline
function fetchAllDeals(pipelineId, days) {
  var since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  var all = [];
  var start = 0;

  function fetchPage() {
    return pipedriveGet('/deals?pipeline_id=' + pipelineId + '&start=' + start + '&limit=500&status=all')
      .then(function(d) {
        var deals = d.data || [];
        // filtra pelo período
        var filtered = deals.filter(function(deal) {
          return deal.add_time && deal.add_time >= since;
        });
        all = all.concat(filtered);
        var pagination = d.additional_data && d.additional_data.pagination;
        var hasMore = pagination && pagination.more_items_in_collection;
        if (hasMore && start < 10000) {
          start += 500;
          return fetchPage();
        }
        return all;
      });
  }
  return fetchPage();
}

function handleLeads(req, res, parsedUrl) {
  var days = parseInt(parsedUrl.query.days) || 30;

  Promise.all([
    pipedriveGet('/pipelines'),
    pipedriveGet('/dealFields')
  ]).then(function(results) {
    var pipelines = results[0].data || [];
    var dealFields = results[1].data || [];

    // Acha o funil comercial
    var pipeline = pipelines.find(function(p) {
      return p.name && p.name.toLowerCase().indexOf('comercial') >= 0;
    });

    if (!pipeline) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Funil Comercial não encontrado', pipelines: pipelines.map(function(p) { return p.name; }) }));
      return;
    }

    // Acha o campo de primeiro contato
    var firstContactKey = findCustomField(dealFields, '1º ligação');
    if (!firstContactKey) firstContactKey = findCustomField(dealFields, 'ligacao');
    if (!firstContactKey) firstContactKey = findCustomField(dealFields, 'primeiro contato');

    return fetchAllDeals(pipeline.id, days).then(function(deals) {
      var total = deals.length;
      var slaOk = 0, slaViolado = 0, semContato = 0;
      var tempos = [];

      // Agrupa por SDR (owner)
      var sdrMap = {};

      deals.forEach(function(deal) {
        var ownerName = deal.owner_name || 'Desconhecido';
        if (!sdrMap[ownerName]) sdrMap[ownerName] = { name: ownerName, total: 0, slaOk: 0, slaViolado: 0, semContato: 0, tempos: [] };
        sdrMap[ownerName].total++;

        var entrou = new Date(deal.add_time);
        var primeiroContato = firstContactKey && deal[firstContactKey] ? new Date(deal[firstContactKey]) : null;

        if (!primeiroContato) {
          semContato++;
          sdrMap[ownerName].semContato++;
          return;
        }

        var diffMin = (primeiroContato - entrou) / 60000;
        if (diffMin < 0) diffMin = 0;
        tempos.push(diffMin);
        sdrMap[ownerName].tempos.push(diffMin);

        if (diffMin <= SLA_MINUTOS) {
          slaOk++;
          sdrMap[ownerName].slaOk++;
        } else {
          slaViolado++;
          sdrMap[ownerName].slaViolado++;
        }
      });

      var tempoMedio = tempos.length > 0 ? Math.round(tempos.reduce(function(a,b){return a+b;},0) / tempos.length) : 0;
      var taxaSla = total > 0 ? Math.round(slaOk / total * 100) : 0;

      var sdrs = Object.values(sdrMap).map(function(s) {
        var tMedio = s.tempos.length > 0 ? Math.round(s.tempos.reduce(function(a,b){return a+b;},0) / s.tempos.length) : null;
        var taxa = s.total > 0 ? Math.round(s.slaOk / s.total * 100) : 0;
        return { name: s.name, total: s.total, slaOk: s.slaOk, slaViolado: s.slaViolado, semContato: s.semContato, tempoMedio: tMedio, taxaSla: taxa };
      }).sort(function(a,b) { return b.total - a.total; });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        pipeline: pipeline.name,
        total_leads: total,
        sla_ok: slaOk,
        sla_violado: slaViolado,
        sem_contato: semContato,
        tempo_medio_min: tempoMedio,
        taxa_sla: taxaSla,
        meta_sla: SLA_MINUTOS,
        campo_primeiro_contato: firstContactKey,
        sdrs: sdrs,
        updated: new Date().toISOString()
      }));
    });
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
  if (parsedUrl.pathname === '/api/leads') handleLeads(req, res, parsedUrl);
  else serveStatic(req, res);
});

server.listen(PORT, function() { console.log('Dashboard rodando na porta ' + PORT); });
