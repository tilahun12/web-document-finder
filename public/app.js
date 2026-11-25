const form = document.getElementById('searchForm');
const statusEl = document.getElementById('status');
const searchBtn = document.getElementById('searchBtn');
const resultsSection = document.getElementById('resultsSection');
const docsList = document.getElementById('documentsList');
const sourcesList = document.getElementById('sourcesList');
const exportBtn = document.getElementById('exportBtn');
let currentDocuments = [];
let currentSources = [];
let activeTab = 'documents';

function domainsFrom(id) { return document.getElementById(id).value.split(',').map(x => x.trim()).filter(Boolean); }
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function ext(url) { try { return new URL(url).pathname.split('.').pop().split('/')[0].toUpperCase().slice(0,5); } catch { return 'WEB'; } }
function card(item, isDoc) {
  if (!item || typeof item !== 'object') return '';
  const title = escapeHtml(item.title || (isDoc ? 'Document' : 'Web page'));
  const url = escapeHtml(item.url || '');
  const desc = escapeHtml(item.snippet || 'No preview is available.');
  const date = item.date ? ` · ${escapeHtml(item.date)}` : '';
  const source = item.foundOn ? `<div class="meta">Found on: ${escapeHtml(item.foundOn)}</div>` : '';
  return `<article class="result"><div class="file-icon">${isDoc ? escapeHtml(ext(item.url)) : 'WEB'}</div><div class="result-content"><a class="result-title" href="${url}" target="_blank" rel="noopener noreferrer">${title}</a><div class="result-url">${url}</div><div class="result-desc">${desc}</div><div class="meta">${isDoc ? 'Document link' : 'Search source'}${date}</div>${source}</div></article>`;
}
function render() {
  docsList.innerHTML = currentDocuments.length ? currentDocuments.map(x => card(x, true)).join('') : '<div class="empty">No matching document links were found. Try a broader query or inspect more source pages.</div>';
  sourcesList.innerHTML = currentSources.length ? currentSources.map(x => card(x, false)).join('') : '<div class="empty">No source pages were returned.</div>';
  document.getElementById('docCount').textContent = currentDocuments.length;
  document.getElementById('sourceCount').textContent = currentSources.length;
  docsList.classList.toggle('hidden', activeTab !== 'documents');
  sourcesList.classList.toggle('hidden', activeTab !== 'sources');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
  exportBtn.disabled = !currentDocuments.length;
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { activeTab = t.dataset.tab; render(); }));
form.addEventListener('submit', async event => {
  event.preventDefault();
  const query = document.getElementById('query').value.trim();
  if (!query) return;
  const types = [...document.querySelectorAll('input[name="type"]:checked')].map(x => x.value);
  if (!types.length) { statusEl.textContent = 'Select at least one document type.'; statusEl.className = 'status error'; return; }
  searchBtn.disabled = true; searchBtn.textContent = 'Searching…';
  statusEl.textContent = 'Searching LangSearch and inspecting selected source pages. This may take a little while.'; statusEl.className = 'status busy';
  resultsSection.classList.add('hidden');
  try {
    const response = await fetch('/api/search', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
      query, types, count: Number(document.getElementById('count').value), searchVariations: Number(document.getElementById('searchVariations').value), crawlPages: Number(document.getElementById('crawlPages').value), maxDocuments: Number(document.getElementById('maxDocuments').value),
      freshness: document.getElementById('freshness').value, includeDomains: domainsFrom('includeDomains'), excludeDomains: domainsFrom('excludeDomains')
    }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Search failed.');
    currentDocuments = Array.isArray(data.documents) ? data.documents.filter(x => x && typeof x === 'object' && typeof x.url === 'string') : [];
    currentSources = Array.isArray(data.sources) ? data.sources.filter(x => x && typeof x === 'object' && typeof x.url === 'string') : [];
    activeTab = 'documents';
    document.getElementById('resultTitle').textContent = `Results for “${query}”`;
    document.getElementById('stats').innerHTML = `<div class="stat"><strong>${data.stats.documentsFound}</strong><span>Document links found</span></div><div class="stat"><strong>${data.stats.searchPages}</strong><span>Search result pages</span></div><div class="stat"><strong>${data.stats.pagesInspected}</strong><span>Pages inspected for files</span></div><div class="stat"><strong>${data.stats.searchRequests || 1}</strong><span>Successful search requests</span></div>`;
    render(); resultsSection.classList.remove('hidden');
    statusEl.textContent = `Search complete. ${data.stats.documentsFound} unique document links found from ${data.stats.searchRequests || 1} successful searches (${data.stats.attemptedSearchRequests || data.stats.searchRequests || 1} attempted). More source pages may find more links, but thousands are not guaranteed.`; statusEl.className = 'status';
  } catch (error) { statusEl.textContent = error.message; statusEl.className = 'status error'; }
  finally { searchBtn.disabled = false; searchBtn.innerHTML = 'Search web <span>→</span>'; }
});
exportBtn.addEventListener('click', () => {
  const rows = [['Title','URL','Description','Found on','Date'], ...currentDocuments.map(x => [x.title || '', x.url || '', x.snippet || '', x.foundOn || '', x.date || ''])];
  const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const blob = new Blob([ '\ufeff' + csv ], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'web-document-results.csv'; a.click(); URL.revokeObjectURL(a.href);
});
fetch('/api/status').then(r => r.json()).then(s => { if (!s.configured) { statusEl.textContent = 'API key not configured yet. Copy .env.example to .env, add your new LangSearch key, and restart the server.'; statusEl.className = 'status error'; } }).catch(() => {});
