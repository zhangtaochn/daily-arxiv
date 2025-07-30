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
    }));
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
  pagePapers.forEach(paper => {
    const pdfUrl = paper.pdf || '#';
    const alphaxivUrl = paper.alphaxiv_url;
    const isFavorited = favoritePapers.has(paper.id);
    const card = document.createElement('div');
    card.className = 'paper-card';
    card.innerHTML = `
      <div class="paper-title-row">
        <h2 class="paper-title"><a href="${paper.url}" target="_blank" rel="noopener">${paper.title}</a></h2>
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
      <div class="paper-authors">${(paper.authors || []).join(', ')}</div>
      <div class="paper-summary">${paper.summary}</div>
    `;
    container.appendChild(card);
  });

  // Add event listeners for favorite buttons
  container.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', toggleFavorite);
  });
  if (window.MathJax && window.MathJax.typesetPromise) {
    window.MathJax.typesetPromise([container]);
  }
  renderPagination(papers.length, page);
}

function renderPagination(total, page) {
  const pageCount = Math.ceil(total / pageSize);
  const bar = document.getElementById('pagination');
  if (pageCount <= 1) {
    bar.innerHTML = '';
    return;
  }
  let html = '';
  if (page > 1) {
    html += `<button class="page-btn" data-page="${page - 1}">Prev</button>`;
  }
  let start = Math.max(1, page - 3);
  let end = Math.min(pageCount, page + 3);
  if (end - start < 6) {
    if (start === 1) end = Math.min(pageCount, start + 6);
    if (end === pageCount) start = Math.max(1, end - 6);
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`;
  }
  if (page < pageCount) {
    html += `<button class="page-btn" data-page="${page + 1}">Next</button>`;
  }
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

  const hasOther = 'Other' in categoryCounts;
  
  let categories = Object.keys(categoryCounts).filter(cat => cat !== 'Other').sort();
  
  select.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = 'ALL';
  optAll.textContent = 'All Categories';
  select.appendChild(optAll);

  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = `${cat} (${categoryCounts[cat]})`;
    select.appendChild(opt);
  });

  if (hasOther) {
    const optOther = document.createElement('option');
    optOther.value = 'Other';
    optOther.textContent = `Other (${categoryCounts['Other']})`;
    select.appendChild(optOther);
  }

  const optFav = document.createElement('option');
  optFav.value = 'FAVORITES';
  optFav.textContent = `Favorites (${favoritePapers.size})`;
  select.insertBefore(optFav, select.children[1]);

  // Restore previous selection if it exists, otherwise default to ALL
  if (Array.from(select.options).some(opt => opt.value === previousCategory)) {
    select.value = previousCategory;
  } else {
    select.value = 'ALL';
  }
}

function applyFilters() {
  const selectedDate = document.getElementById('date-select').value;
  const searchQuery = document.getElementById('search-input').value.toLowerCase();
  const selectedCategory = document.getElementById('category-select').value;

  let papersToFilter = allPapers;

  // Filter by date
  if (selectedDate) {
    papersToFilter = papersToFilter.filter(paper => {
      const paperDate = new Date(paper.published).toISOString().split('T')[0];
      return paperDate === selectedDate;
    });
  }

  // Update category counts based on date-filtered papers
  updateCategoryCounts(papersToFilter);

  // Filter by category
  if (selectedCategory === 'ALL') {
    filteredPapers = papersToFilter.filter(paper => Array.isArray(paper.category) && !paper.category.includes('Other'));
  } else if (selectedCategory === 'FAVORITES') {
    filteredPapers = papersToFilter.filter(paper => favoritePapers.has(paper.id));
  } else {
    filteredPapers = papersToFilter.filter(paper => Array.isArray(paper.category) && paper.category.includes(selectedCategory));
  }

  // Filter by search query
  if (searchQuery) {
    filteredPapers = filteredPapers.filter(paper => 
      paper.title.toLowerCase().includes(searchQuery) ||
      paper.summary.toLowerCase().includes(searchQuery) ||
      (paper.authors && paper.authors.join(', ').toLowerCase().includes(searchQuery))
    );
  }

  // Sort by date
  filteredPapers.sort((a, b) => new Date(b.published) - new Date(a.published));

  currentPage = 1;
  renderPapers(filteredPapers, currentPage);
  updateLastUpdated();
}

async function loadAllPapers() {
  const container = document.getElementById('papers-container');
  container.innerHTML = '<p>Loading all papers...</p>';
  try {
    const response = await fetch('web/all_papers.json');
    if (!response.ok) throw new Error('Failed to load papers data');
    const raw = await response.json();

    // 适配新的数据结构
    const papersList = raw.all_papers_list || raw;
    allPapers = adaptRawData(papersList);

    // 保存全局统计信息
    updateTimeGlobal = raw.current_update_time || '';
    countNewPapers = raw.count_new_papers || {};
    countAllPapers = raw.count_all_papers || {};

  } catch (err) {
    container.innerHTML = `<p style="color:red;">${err.message}</p>`;
    document.getElementById('pagination').innerHTML = '';
  }
}

function updateLastUpdated() {
  const lastUpdatedSpan = document.getElementById('last-updated');
  const totalNew = countNewPapers['All'] || 0;
  const totalPapers = countAllPapers['All'] || 0;
  lastUpdatedSpan.innerHTML = `Updated: ${updateTimeGlobal} | New: ${totalNew} | Total: ${totalPapers}`;
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

async function init() {
  loadFavorites();
  await loadAllPapers();
  updateLastUpdated();
  document.getElementById('category-select').addEventListener('change', applyFilters);
  document.getElementById('date-select').addEventListener('change', applyFilters);
  document.getElementById('search-input').addEventListener('input', applyFilters);
  document.getElementById('date-select').value = '';
  applyFilters();
}

document.addEventListener('DOMContentLoaded', init);