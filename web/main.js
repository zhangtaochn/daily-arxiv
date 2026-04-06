// main.js

let allPapers = [];
let filteredPapers = [];
let currentPage = 1;
const pageSize = 20;
let categoryStats = {};
let countNewPapers = {};
let countAllPapers = {};
let updateTimeGlobal = '';
let favoritePapers = new Set();
let sortMode = 'date_desc'; // 'date_desc' | 'score_desc' | 'score_asc'

// New: manifest + caches for on-demand loading
let manifest = null; // { current_update_time, count_new_papers, count_all_papers, recent_days, dates, by_date_base }
const loadedDates = new Set(); // track which dates are loaded
const loadedIds = new Set(); // dedupe by paper id

function adaptRawData(raw) {
  // 兼容对象或数组
  if (Array.isArray(raw)) {
    return raw.map(paper => ({
      title: paper.title,
      summary: paper.summary,
      published: paper.published,
      authors: paper.authors,
      url: paper.arxiv_abstract_url,
      pdf: paper.arxiv_pdf_url,
      alphaxiv_url: paper.alphaxiv_url,
      categories: paper.keywords || [],
      category: paper.llm_cls_result || [],
      id: paper.id,
      cls_reason: paper.cls_reason || '',
      rec_score: typeof paper.rec_score === 'number' ? paper.rec_score : null,
      rec_reason: paper.rec_reason || ''
    }));
  } else {
    return Object.values(raw).map(paper => ({
      title: paper.title,
      summary: paper.summary,
      published: paper.published,
      authors: paper.authors,
      url: paper.arxiv_abstract_url,
      pdf: paper.arxiv_pdf_url,
      alphaxiv_url: paper.alphaxiv_url,
      categories: paper.keywords || [],
      category: paper.llm_cls_result || [],
      id: paper.id,
      cls_reason: paper.cls_reason || '',
      rec_score: typeof paper.rec_score === 'number' ? paper.rec_score : null,
      rec_reason: paper.rec_reason || ''
    }));
  }
}

function renderScore(score) {
  if (score == null) return '<span class="score-na">N/A</span>';
  const full = Math.floor(score);
  const half = score - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return `<span class="score">${'★'.repeat(full)}${half? '☆' : ''}${'☆'.repeat(empty)} <span class="score-num">${score.toFixed(1)}/5</span></span>`;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function highlight(text, keyword) {
  if (!keyword) return escapeHtml(text);
  try {
    const re = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return escapeHtml(text).replace(re, '<mark>$1</mark>');
  } catch (_) {
    return escapeHtml(text);
  }
}

function renderPapers(papers, page = 1) {
  const container = document.getElementById('papers-container');
  if (!papers || papers.length === 0) {
    container.innerHTML = '<p>No results found.</p>';
    document.getElementById('pagination').innerHTML = '';
    return;
  }
  container.innerHTML = '';
  const startIdx = (page - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const pagePapers = papers.slice(startIdx, endIdx);

  const searchQuery = document.getElementById('search-input').value.trim();

  pagePapers.forEach(paper => {
    const pdfUrl = paper.pdf || '#';
    const alphaxivUrl = paper.alphaxiv_url;
    const isFavorited = favoritePapers.has(paper.id);
    const card = document.createElement('div');
    card.className = 'paper-card';
    card.innerHTML = `
      <div class="paper-title-row">
        <h2 class="paper-title"><a href="${paper.url}" target="_blank" rel="noopener">${highlight(paper.title, searchQuery)}</a></h2>
      </div>
      <div class="paper-meta">
        <span class="paper-date">${paper.published}</span>
        <span class="paper-category">${(paper.category || []).join(', ')}</span>
        <div class="paper-actions">
          ${alphaxivUrl ? `<a class="action-link" href="${alphaxivUrl}" target="_blank" rel="noopener" title="View on alphaxiv">alphaxiv</a>` : ''}
          <a class="action-link" href="${pdfUrl}" target="_blank" rel="noopener">PDF</a>
          <button class="favorite-btn ${isFavorited ? 'favorited' : ''}" data-id="${paper.id}">${isFavorited ? '★' : '☆'}</button>
        </div>
      </div>
      <div class="paper-authors">${highlight((paper.authors || []).join(', '), searchQuery)}</div>
      <div class="paper-summary">${highlight(paper.summary, searchQuery)}</div>
      <div class="paper-recommend">
        <div class="paper-score">${renderScore(paper.rec_score)}</div>
        ${paper.rec_reason ? `<div class="paper-rec-reason">${escapeHtml(paper.rec_reason)}</div>` : ''}
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', toggleFavorite);
  });
  if (window.MathJax && window.MathJax.typesetPromise) {
    window.MathJax.typesetPromise([container]);
  }
  renderPagination(papers.length, page);
}

function applySort(papers) {
  if (sortMode === 'score_desc') {
    return papers.slice().sort((a, b) => (b.rec_score ?? -1) - (a.rec_score ?? -1) || new Date(b.published) - new Date(a.published));
  } else if (sortMode === 'score_asc') {
    return papers.slice().sort((a, b) => (a.rec_score ?? 999) - (b.rec_score ?? 999) || new Date(b.published) - new Date(a.published));
  }
  // default: date_desc
  return papers.slice().sort((a, b) => new Date(b.published) - new Date(a.published));
}

async function ensureDateLoaded(dateStr) {
  if (!dateStr || loadedDates.has(dateStr)) return;
  if (!manifest || !manifest.by_date_base) return; // nothing we can do
  const url = `${manifest.by_date_base}${dateStr}.json?ts=${Date.now()}`;
  try {
    const resp = await fetch(url, { cache: 'force-cache' });
    if (!resp.ok) return;
    const arr = await resp.json(); // array
    const papers = adaptRawData(arr);
    for (const p of papers) {
      if (!loadedIds.has(p.id)) {
        loadedIds.add(p.id);
        allPapers.push(p);
      }
    }
    loadedDates.add(dateStr);
  } catch (e) {
    console.warn('Failed to load date file', dateStr, e);
  }
}

async function applyFilters() {
  const selectedDate = document.getElementById('date-select').value;
  const searchQuery = document.getElementById('search-input').value.toLowerCase();
  const selectedCategory = document.getElementById('category-select').value;

  // On-demand load for specific date if needed
  if (selectedDate) {
    await ensureDateLoaded(selectedDate);
  }

  let papersToFilter = allPapers;

  if (selectedDate) {
    papersToFilter = papersToFilter.filter(paper => {
      const paperDate = new Date(paper.published).toISOString().split('T')[0];
      return paperDate === selectedDate;
    });
  }

  updateCategoryCounts(papersToFilter);

  if (selectedCategory === 'ALL') {
    filteredPapers = papersToFilter.filter(paper => Array.isArray(paper.category) && !paper.category.includes('Other'));
  } else if (selectedCategory === 'FAVORITES') {
    filteredPapers = papersToFilter.filter(paper => favoritePapers.has(paper.id));
  } else {
    filteredPapers = papersToFilter.filter(paper => Array.isArray(paper.category) && paper.category.includes(selectedCategory));
  }

  if (searchQuery) {
    filteredPapers = filteredPapers.filter(paper => 
      paper.title.toLowerCase().includes(searchQuery) ||
      paper.summary.toLowerCase().includes(searchQuery) ||
      (paper.authors && paper.authors.join(', ').toLowerCase().includes(searchQuery))
    );
  }

  // sort by selected mode
  filteredPapers = applySort(filteredPapers);

  currentPage = 1;
  renderPapers(filteredPapers, currentPage);
  updateLastUpdated();
}

async function loadAllPapers() {
  const container = document.getElementById('papers-container');
  container.innerHTML = '<p>Loading papers...</p>';
  try {
    const ts = Date.now();
    // Load manifest
    const manifestResp = await fetch(`web/manifest.json?ts=${ts}`, { cache: 'no-store' });
    if (!manifestResp.ok) throw new Error('Failed to load manifest');
    manifest = await manifestResp.json();

    // Load recent list only
    const recentResp = await fetch(`web/recent.json?ts=${ts}`, { cache: 'no-store' });
    if (!recentResp.ok) throw new Error('Failed to load recent papers');
    const recentRaw = await recentResp.json();

    const papersList = recentRaw; // array
    const adapted = adaptRawData(papersList);
    allPapers = [];
    loadedIds.clear();
    for (const p of adapted) {
      if (!loadedIds.has(p.id)) {
        loadedIds.add(p.id);
        allPapers.push(p);
      }
    }

    // 保存全局统计信息
    updateTimeGlobal = manifest.current_update_time || '';
    countNewPapers = manifest.count_new_papers || {};
    countAllPapers = manifest.count_all_papers || {};

  } catch (err) {
    console.warn('Fast-path data missing, falling back to all_papers.json', err);
    // Fallback to legacy all_papers.json for compatibility/local preview
    try {
      const ts = Date.now();
      const response = await fetch(`web/all_papers.json?ts=${ts}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load papers data');
      const raw = await response.json();
      // 适配新的数据结构
      const papersList = raw.all_papers_list || raw;
      const adapted = adaptRawData(papersList);
      allPapers = [];
      loadedIds.clear();
      for (const p of adapted) {
        if (!loadedIds.has(p.id)) {
          loadedIds.add(p.id);
          allPapers.push(p);
        }
      }
      updateTimeGlobal = raw.current_update_time || '';
      countNewPapers = raw.count_new_papers || {};
      countAllPapers = raw.count_all_papers || {};
      // Construct a minimal manifest to keep UI consistent
      manifest = {
        current_update_time: updateTimeGlobal,
        count_new_papers: countNewPapers,
        count_all_papers: countAllPapers,
        recent_days: 10,
        dates: [],
        by_date_base: 'web/by_date/'
      };
    } catch (e2) {
      container.innerHTML = `<p style="color:red;">${e2.message}</p>`;
      document.getElementById('pagination').innerHTML = '';
    }
  }
}

function updateLastUpdated() {
  const lastUpdatedSpan = document.getElementById('last-updated');
  const totalNew = countNewPapers['All'] || 0;
  const totalPapers = countAllPapers['All'] || 0;
  const recentDays = manifest && manifest.recent_days ? manifest.recent_days : 10;
  lastUpdatedSpan.innerHTML = `Updated: ${updateTimeGlobal} | New: ${totalNew} | Total: ${totalPapers} | Showing last ${recentDays} days by default`;
}

function loadFavorites() {
  const savedFavorites = localStorage.getItem('favoritePapers');
  if (savedFavorites) {
    favoritePapers = new Set(JSON.parse(savedFavorites));
  }
}

function saveFavorites() {
  localStorage.setItem('favoritePapers', JSON.stringify(Array.from(favoritePapers)));
}

function toggleFavorite(event) {
  const paperId = event.target.dataset.id;
  if (favoritePapers.has(paperId)) {
    favoritePapers.delete(paperId);
  } else {
    favoritePapers.add(paperId);
  }
  saveFavorites();
  applyFilters(); // Re-render to update favorite buttons and counts
}

function renderPagination(total, page) {
  const pageCount = Math.ceil(total / pageSize);
  const bar = document.getElementById('pagination');
  if (pageCount <= 1) {
    bar.innerHTML = '';
    return;
  }
  let html = '';

  // Page info
  html += `<span class="page-info">Page ${page} of ${pageCount}</span>`;

  // Buttons
  html += '<div class="page-buttons">';
  if (page > 1) {
    html += `<button class="page-btn" data-page="1">First</button>`;
    html += `<button class="page-btn" data-page="${page - 1}">Prev</button>`;
  }

  let start = Math.max(1, page - 2);
  let end = Math.min(pageCount, page + 2);

  if (page < 4) {
    end = Math.min(pageCount, 5);
  }
  if (page > pageCount - 3) {
    start = Math.max(1, pageCount - 4);
  }

  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`;
  }

  if (page < pageCount) {
    html += `<button class="page-btn" data-page="${page + 1}">Next</button>`;
    html += `<button class="page-btn" data-page="${pageCount}">Last</button>`;
  }
  html += '</div>';
  bar.innerHTML = html;
  Array.from(bar.querySelectorAll('.page-btn')).forEach(btn => {
    btn.onclick = function() {
      const p = parseInt(this.getAttribute('data-page'));
      currentPage = p;
      renderPapers(filteredPapers, currentPage);
      window.scrollTo({top: 0, behavior: 'smooth'});
    };
  });
}

function updateCategoryCounts(papers) {
  const select = document.getElementById('category-select');
  const previousCategory = select.value;

  const categoryCounts = {};
  papers.forEach(p => {
    (p.category || []).forEach(cat => {
      if (cat) {
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
    });
  });

  const categories = Object.keys(categoryCounts).sort((a,b)=>categoryCounts[b]-categoryCounts[a]);
  const favCount = papers.filter(p => favoritePapers.has(p.id)).length;
  let html = '';
  html += `<option value="ALL">All Categories</option>`;
  html += `<option value="FAVORITES">⭐ Favorites${favCount ? ` (${favCount})` : ''}</option>`;
  for (const cat of categories) {
    html += `<option value="${cat}">${cat} (${categoryCounts[cat]})</option>`;
  }
  select.innerHTML = html;

  if (previousCategory && (previousCategory === 'ALL' || previousCategory === 'FAVORITES' || categories.includes(previousCategory))) {
    select.value = previousCategory;
  } else {
    select.value = 'ALL';
  }
}

async function init() {
  loadFavorites();
  await loadAllPapers();
  updateLastUpdated();

  document.getElementById('category-select').addEventListener('change', () => { applyFilters(); });

  // On date change, ensure that date data is loaded then filter
  document.getElementById('date-select').addEventListener('change', async (e) => {
    const d = e.target.value;
    await ensureDateLoaded(d);
    applyFilters();
  });

  document.getElementById('search-input').addEventListener('input', () => { applyFilters(); });
  const sortSel = document.getElementById('sort-select');
  if (sortSel) {
    sortSel.addEventListener('change', (e) => {
      sortMode = e.target.value;
      applyFilters();
    });
  }

  document.getElementById('date-select').value = '';
  applyFilters();
}

// Kick off

document.addEventListener('DOMContentLoaded', init);