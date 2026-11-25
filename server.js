require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.LANGSEARCH_API_URL || 'https://api.langsearch.com/v1/web-search';
const MAX_CRAWL_PAGES = Math.min(1000, Math.max(1, Number(process.env.MAX_CRAWL_PAGES || 1000)));
const MAX_DOCUMENTS = Math.min(5000, Math.max(100, Number(process.env.MAX_DOCUMENTS || 5000)));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const EXTENSIONS = {
  pdf: ['pdf'], word: ['doc', 'docx', 'odt', 'rtf'], powerpoint: ['ppt', 'pptx', 'odp'],
  excel: ['xls', 'xlsx', 'csv', 'ods'], images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tif', 'tiff'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz']
};
const ALL_EXTS = [...new Set(Object.values(EXTENSIONS).flat())];

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return !(p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === '::1' ? false : !(s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:') || s === '::');
  }
  return false;
}
async function safePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (net.isIP(host)) return isPublicIp(host);
  try {
    const records = await dns.lookup(host, { all: true });
    return records.length > 0 && records.every(r => isPublicIp(r.address));
  } catch { return false; }
}
function extensionOf(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : '';
  } catch { return ''; }
}
function selectedExtensions(types) {
  if (!Array.isArray(types) || !types.length || types.includes('all')) return ALL_EXTS;
  return [...new Set(types.flatMap(t => EXTENSIONS[t] || []))];
}
function matchesType(url, allowed) { return allowed.includes(extensionOf(url)); }

const STOP_WORDS = new Set(['the','and','for','with','from','that','this','these','those','into','about','your','you','are','was','were','what','where','when','how','why','who','which','can','could','should','would','will','shall','have','has','had','are','not','but','all','any','per','via','using','use','find','search','download','free','latest']);
function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
    .filter(term => !STOP_WORDS.has(term));
}
function relevance(query, fields) {
  const terms = queryTerms(query);
  if (!terms.length) return 1;
  const text = String(fields.filter(Boolean).join(' ')).toLowerCase();
  const hits = terms.filter(term => text.includes(term)).length;
  const phrase = String(query || '').trim().toLowerCase();
  if (phrase.length >= 5 && text.includes(phrase)) return 1;
  return hits / terms.length;
}
function relevantEnough(query, fields, threshold = 0.5) {
  const terms = queryTerms(query);
  if (!terms.length) return true;
  return relevance(query, fields) >= threshold;
}

function normalizeUrl(url) {
  try { const u = new URL(url); u.hash = ''; return u.toString(); } catch { return ''; }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) return; try { out[i] = await fn(items[i], i); } catch (error) { out[i] = []; } }
  });
  await Promise.all(workers); return out;
}
async function langSearch({ query, count, freshness, includeDomains, excludeDomains }) {
  const key = process.env.LANGSEARCH_API_KEY;
  if (!key || key === 'replace_with_your_new_api_key') {
    const e = new Error('LangSearch API key is missing. Copy .env.example to .env and add your API key.'); e.status = 503; throw e;
  }
  const body = { query, count, contents: { text: false } };
  if (freshness && freshness !== 'noLimit') body.freshness = freshness;
  if (includeDomains.length) body.includeDomains = includeDomains;
  if (excludeDomains.length) body.excludeDomains = excludeDomains;
  const response = await axios.post(API_URL, body, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000,
    maxContentLength: 2 * 1024 * 1024, maxBodyLength: 100 * 1024
  });
  const payload = response.data;
  if (String(payload?.code) !== '200') {
    const e = new Error(payload?.message || 'LangSearch returned an unsuccessful response.'); e.status = 502; throw e;
  }
  const results = payload?.data?.webPages?.value;
  // Some search responses may contain null or malformed entries. Ignore them safely.
  return Array.isArray(results) ? results.filter(item => item && typeof item === 'object') : [];
}
async function inspectPage(source, allowed) {
  if (!source || typeof source.url !== 'string' || !(await safePublicUrl(source.url))) return [];
  const response = await axios.get(source.url, {
    timeout: 9000, maxRedirects: 3, maxContentLength: 2 * 1024 * 1024,
    responseType: 'text', headers: { 'User-Agent': 'WebDocumentFinder/2.0 (+local research tool)', Accept: 'text/html,application/xhtml+xml' },
    validateStatus: s => s >= 200 && s < 400
  });
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) return [];
  const $ = cheerio.load(response.data);
  const found = [];
  $('a[href], source[src], img[src]').each((_, el) => {
    const raw = $(el).attr('href') || $(el).attr('src');
    if (!raw) return;
    try {
      const url = normalizeUrl(new URL(raw, source.url).toString());
      if (url && matchesType(url, allowed)) found.push({ url, title: ($(el).text() || $(el).attr('alt') || '').trim().slice(0, 240) });
    } catch {}
  });
  return found;
}

app.get('/api/status', (req, res) => res.json({ configured: Boolean(process.env.LANGSEARCH_API_KEY && process.env.LANGSEARCH_API_KEY !== 'replace_with_your_new_api_key'), maxCrawlPages: MAX_CRAWL_PAGES, maxDocuments: MAX_DOCUMENTS }));

app.post('/api/search', async (req, res) => {
  try {
    const query = String(req.body.query || '').trim();
    if (!query || query.length > 300) return res.status(400).json({ error: 'Enter a search query (maximum 300 characters).' });
    const count = Math.min(50, Math.max(1, Number(req.body.count || 50)));
    const crawlPages = Math.min(MAX_CRAWL_PAGES, Math.max(0, Number(req.body.crawlPages ?? 200)));
    const searchVariations = Math.min(10, Math.max(1, Number(req.body.searchVariations || 10)));
    const maxDocuments = Math.min(MAX_DOCUMENTS, Math.max(100, Number(req.body.maxDocuments || 5000)));
    const types = Array.isArray(req.body.types) ? req.body.types : ['all'];
    const allowed = selectedExtensions(types);
    const includeDomains = (Array.isArray(req.body.includeDomains) ? req.body.includeDomains : [])
      .map(x => String(x).trim().replace(/^https?:\/\//i, '').split('/')[0]).filter(x => /^[a-z0-9.-]+$/i.test(x)).slice(0, 20);
    const excludeDomains = (Array.isArray(req.body.excludeDomains) ? req.body.excludeDomains : [])
      .map(x => String(x).trim().replace(/^https?:\/\//i, '').split('/')[0]).filter(x => /^[a-z0-9.-]+$/i.test(x)).slice(0, 20);
    const freshness = ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'].includes(req.body.freshness) ? req.body.freshness : 'noLimit';

    // LangSearch returns at most 50 results per request and does not expose
    // documented offset pagination. Broaden coverage with controlled related queries.
    const variations = [query];
    // Use distinct search angles, including common filetype operators. These
    // are separate API searches (not pagination); each may surface a different
    // slice of the provider's index.
    const suffixes = [
      'filetype:pdf',
      'filetype:docx OR filetype:doc',
      'filetype:pptx OR filetype:ppt',
      'filetype:xlsx OR filetype:xls OR filetype:csv',
      'download file documents',
      'lecture notes course materials',
      'manuals guides reports publications',
      'research papers books resources',
      'educational materials study resources'
    ];
    for (const suffix of suffixes) {
      if (variations.length >= searchVariations) break;
      if ((suffix.includes('PDF') && !allowed.some(x => x === 'pdf')) ||
          (suffix.includes('Word') && !allowed.some(x => ['doc','docx','odt','rtf'].includes(x))) ||
          (suffix.includes('PowerPoint') && !allowed.some(x => ['ppt','pptx','odp'].includes(x))) ||
          (suffix.includes('Excel') && !allowed.some(x => ['xls','xlsx','csv','ods'].includes(x)))) continue;
      variations.push(`${query} ${suffix}`);
    }
    const pageBatches = [];
    const searchErrors = [];
    for (const searchQuery of variations) {
      try {
        const batch = await langSearch({ query: searchQuery, count, freshness, includeDomains, excludeDomains });
        pageBatches.push(...batch.map(item => item && typeof item === 'object' ? { ...item, _searchQuery: searchQuery } : item));
      } catch (e) {
        searchErrors.push(e.message || 'A related search failed.');
      }
      // Stay below the documented 5 requests/second starting limit for new accounts.
      await new Promise(resolve => setTimeout(resolve, 260));
    }
    if (!pageBatches.length && searchErrors.length) throw new Error(searchErrors[0]);
    const pages = pageBatches;
    // Merge and deduplicate source pages across all query variations.
    const sourceMap = new Map();
    pages.filter(p => p && typeof p === 'object' && typeof p.url === 'string' && p.url.trim())
      .forEach(p => {
        const url = normalizeUrl(p.url);
        if (!url) return;
        const previous = sourceMap.get(url);
        const candidate = { title: p.name || p.title || 'Untitled page', url, snippet: p.snippet || p.text || '', date: p.datePublished || '', matchedQuery: p._searchQuery || query };
        if (!previous || (candidate.snippet.length + candidate.title.length) > (previous.snippet.length + previous.title.length)) sourceMap.set(url, candidate);
      });
    const sources = [...sourceMap.values()]
      .filter(p => relevantEnough(query, [p.title, p.snippet, p.url], 0.20));
    const directDocs = sources
      .filter(p => matchesType(p.url, allowed))
      .filter(p => relevantEnough(query, [p.title, p.snippet, p.url], 0.30))
      .map(p => ({ ...p, foundOn: p.url }));
    const crawlTargets = sources.filter(p => !matchesType(p.url, allowed)).slice(0, crawlPages);
    const crawled = await mapLimit(crawlTargets, 8, async source => {
      if (!source || typeof source.url !== 'string' || !(await safePublicUrl(source.url))) return [];
      const inspected = await inspectPage(source, allowed);
      return (Array.isArray(inspected) ? inspected : [])
        .filter(item => item && typeof item === 'object' && typeof item.url === 'string' && item.url.trim())
        .map(item => ({
          title: item.title || `${extensionOf(item.url).toUpperCase()} document`, url: item.url,
          snippet: `Discovered on ${source.title}`, date: source.date, foundOn: source.url,
          _sourceTitle: source.title, _sourceSnippet: source.snippet
        }))
        // A file extension alone is not evidence that a link matches the query.
        .filter(item => relevantEnough(query, [item.title, item.url], 0.25) ||
          relevantEnough(query, [item._sourceTitle, item._sourceSnippet], 0.50))
        .map(({ _sourceTitle, _sourceSnippet, ...item }) => item);
    });
    const unique = new Map();
    const allDocuments = [...directDocs, ...crawled.flat()];
    allDocuments
      .filter(item => item && typeof item === 'object' && typeof item.url === 'string' && item.url.trim())
      .forEach(item => { if (!unique.has(item.url) && unique.size < maxDocuments) unique.set(item.url, item); });
    res.json({ query, sources, documents: [...unique.values()], stats: { searchPages: sources.length, pagesInspected: crawlTargets.length, documentsFound: unique.size, langSearchLimit: 50, searchRequests: variations.length - searchErrors.length, attemptedSearchRequests: variations.length, searchVariations: variations, maxDocuments, partialSearchErrors: searchErrors, relevanceFiltering: 'broader keyword matching' } });
  } catch (error) {
    const status = error.status || (error.response?.status === 401 || error.response?.status === 403 ? 502 : 500);
    let message = error.message || 'Search failed.';
    if (error.response?.status === 401 || error.response?.status === 403) message = 'LangSearch rejected the API key. Check that your new key is correct and active.';
    if (error.response?.status === 429) message = 'LangSearch rate or usage limit reached. Wait and try again; check your LangSearch dashboard.';
    if (error.code === 'ECONNABORTED') message = 'LangSearch or a website took too long to respond. Please try again.';
    res.status(status).json({ error: message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Web Document Finder is running at http://localhost:${PORT}`));
