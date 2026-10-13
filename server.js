const express = require('express'), Database = require('better-sqlite3'), cheerio = require('cheerio');
const dns = require('dns').promises, path = require('path');
const db = new Database(process.env.DB || 'leads.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY, key TEXT UNIQUE, company TEXT, website TEXT,
 contact TEXT, title TEXT, email TEXT, industry TEXT, size INTEGER, location TEXT, score INTEGER DEFAULT 0,
 reasons TEXT DEFAULT '[]', email_status TEXT, enriched TEXT, enriched_at INTEGER);
 CREATE INDEX IF NOT EXISTS i_score ON leads(score DESC);`);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const domainOf = w => { try { return new URL(/^https?:/.test(w) ? w : 'https://' + w).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const ROLE = /^(info|contact|hello|support|sales|admin|office|team)@/i;

async function verify(e) { // syntax -> MX lookup -> role-account heuristic
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'invalid';
  try { if (!(await dns.resolveMx(e.split('@')[1])).length) return 'invalid'; } catch { return 'invalid'; }
  return ROLE.test(e) ? 'risky' : 'valid';
}

function score(l, icp) { // transparent, explainable ICP-fit scoring (0-100)
  let s = 0; const r = [];
  const has = (a, v) => a && a.length && v && a.some(x => v.toLowerCase().includes(String(x).toLowerCase()));
  if (has(icp.industries, l.industry)) { s += 30; r.push('Industry match +30'); }
  if (l.size && l.size >= (icp.minSize || 0) && l.size <= (icp.maxSize || 1e9)) { s += 20; r.push('Company size in range +20'); }
  if (has(icp.locations, l.location)) { s += 15; r.push('Location match +15'); }
  if (has(icp.titles, l.title)) { s += 15; r.push('Decision-maker title +15'); }
  if (l.email_status === 'valid') { s += 10; r.push('Verified email +10'); }
  else if (l.email_status === 'risky') { s += 4; r.push('Generic/risky email +4'); }
  if (l.website) { s += 5; r.push('Has website +5'); }
  const e = l.enriched ? JSON.parse(l.enriched) : null;
  if (e && (e.emails.length || e.phones.length)) { s += 5; r.push('Contact data found on site +5'); }
  return { score: s, reasons: r };
}

const update = db.prepare(`UPDATE leads SET email=@email,email_status=@email_status,enriched=@enriched,enriched_at=@enriched_at,score=@score,reasons=@reasons WHERE id=@id`);
function save(l, icp) { const { score: sc, reasons } = score(l, icp); update.run({ ...l, score: sc, reasons: JSON.stringify(reasons) }); }

async function allowedByRobots(origin) { // ethical collection: honour robots.txt
  try {
    const t = await (await fetch(origin + '/robots.txt', { signal: AbortSignal.timeout(4000) })).text();
    const grp = t.split(/user-agent:\s*\*/i)[1]?.split(/user-agent:/i)[0] || '';
    return !/^\s*disallow:\s*\/\s*$/im.test(grp);
  } catch { return true; }
}
async function safeFetch(u) { // basic SSRF guard + timeout + size cap
  const addrs = await dns.lookup(new URL(u).hostname, { all: true });
  if (addrs.some(a => /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)|^(::1|fc|fd|fe80)/i.test(a.address))) throw new Error('blocked host');
  const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'LeadLensBot/1.0' } });
  return (await r.text()).slice(0, 500000);
}

const TTL = 7 * 864e5; // enrichment cache: 7 days, stored in SQLite
async function enrich(l, icp, force) {
  if (!force && l.enriched_at && Date.now() - l.enriched_at < TTL) return l;
  let e = { emails: [], phones: [], socials: [], tech: [], description: '', error: null };
  try {
    const u = /^https?:/.test(l.website) ? l.website : 'https://' + l.website;
    if (!(await allowedByRobots(new URL(u).origin))) e.error = 'robots.txt disallows';
    else {
      const html = await safeFetch(u), $ = cheerio.load(html);
      e.emails = [...new Set([...html.matchAll(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi)].map(m => m[0].toLowerCase()))].filter(x => !/\.(png|jpe?g|svg|webp|gif)$/.test(x)).slice(0, 5);
      e.phones = [...new Set(($('body').text().match(/\+?\d[\d\s().-]{8,}\d/g) || []).map(x => x.trim()))].slice(0, 3);
      e.socials = [...new Set($('a[href]').map((_, a) => $(a).attr('href')).get().filter(h => /linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com/.test(h)))].slice(0, 5);
      e.tech = ['shopify', 'wordpress', 'hubspot', 'salesforce', 'wix', 'squarespace', 'stripe', 'intercom'].filter(t => html.toLowerCase().includes(t));
      e.description = ($('meta[name=description]').attr('content') || $('title').text() || '').slice(0, 200);
    }
  } catch (err) { e.error = err.message; }
  if (!l.email && e.emails[0]) l.email = e.emails[0];
  l.email_status = await verify(l.email);
  l.enriched = JSON.stringify(e); l.enriched_at = Date.now();
  save(l, icp); return l;
}

const pick = (o, ...ks) => { for (const k of ks) if (o[k] != null && String(o[k]).trim()) return String(o[k]).trim(); return ''; };
const getAll = () => db.prepare('SELECT * FROM leads ORDER BY score DESC, id').all();
const tier = x => x >= 70 ? 'Hot' : x >= 40 ? 'Warm' : 'Cold';
function pitch(l, e) { // rule-based outreach opener personalised from enrichment signals
  const first = (l.contact || 'there').split(' ')[0];
  const hook = e && e.description ? `I saw that ${l.company} is focused on "${e.description.slice(0, 80).trim()}"` : `I've been following ${l.company}${l.industry ? ' in ' + l.industry : ''}`;
  const tech = e && e.tech && e.tech.length ? ` Since you're on ${e.tech.slice(0, 2).join(' & ')}, it should plug in easily.` : '';
  return `Hi ${first}, ${hook}.${tech} We help teams prioritise the right prospects and cut research time. Worth a 15-min chat this week?`;
}
const out = l => { const e = l.enriched ? JSON.parse(l.enriched) : null; return { ...l, reasons: JSON.parse(l.reasons || '[]'), enriched: e, tier: tier(l.score), pitch: pitch(l, e) }; };

app.get('/api/leads', (req, res) => res.json(getAll().map(out)));

app.post('/api/import', async (req, res) => {
  const { rows = [], icp = {} } = req.body; let added = 0, dupes = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO leads(key,company,website,contact,title,email,industry,size,location) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < rows.length; i += 25) {
    await Promise.all(rows.slice(i, i + 25).map(async r => {
      const company = pick(r, 'company', 'name', 'company name'), website = pick(r, 'website', 'url', 'domain');
      const key = domainOf(website) || company.toLowerCase(); if (!key) return;
      const email = pick(r, 'email').toLowerCase();
      const info = ins.run(key, company, website, pick(r, 'contact', 'contact name'), pick(r, 'title', 'job title'), email,
        pick(r, 'industry'), parseInt(pick(r, 'size', 'employees')) || null, pick(r, 'location', 'city'));
      if (!info.changes) { dupes++; return; }
      added++;
      const l = db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid);
      l.email_status = email ? await verify(email) : null; save(l, icp);
    }));
  }
  res.json({ added, dupes });
});

app.post('/api/enrich/:id', async (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).end();
  res.json(out(await enrich(l, req.body.icp || {}, req.body.force)));
});
app.post('/api/rescore', (req, res) => { db.transaction(() => getAll().forEach(l => save(l, req.body.icp || {})))(); res.json({ ok: true }); });
app.delete('/api/leads', (req, res) => { db.exec('DELETE FROM leads'); res.json({ ok: true }); });

app.get('/api/export.csv', (req, res) => {
  const min = +req.query.min || 0, q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['company', 'website', 'contact', 'title', 'email', 'email_status', 'industry', 'size', 'location', 'score'];
  const lines = [cols.join(',')].concat(getAll().filter(l => l.score >= min).map(l => cols.map(c => q(l[c])).join(',')));
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=leads.csv' }).send(lines.join('\n'));
});

app.get('/api/export-hubspot.csv', (req, res) => { // HubSpot import-ready columns
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, min = +req.query.min || 0;
  const lines = ['First Name,Last Name,Email,Company Name,Job Title,Website URL,Industry,Lead Status,Lead Score'];
  getAll().filter(l => l.score >= min).forEach(l => { const [f, ...r] = (l.contact || '').split(' ');
    lines.push([f, r.join(' '), l.email, l.company, l.title, l.website, l.industry, tier(l.score), l.score].map(q).join(',')); });
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=leads-hubspot.csv' }).send(lines.join('\n'));
});

app.listen(process.env.PORT || 3000, () => console.log('LeadLens on http://localhost:' + (process.env.PORT || 3000)));
