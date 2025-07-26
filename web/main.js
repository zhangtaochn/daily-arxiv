// main.js

let allPapers = [];
let filteredPapers = [];
let currentPage = 1;
const pageSize = 20;

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
    container.innerHTML = '<p>No data</p>';
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
    const card = document.createElement('div');
    card.className = 'paper-card';
    card.innerHTML = `
      <div class="paper-title-row">
        <h2 class="paper-title"><a href="${paper.url}" target="_blank" rel="noopener">${paper.title}</a></h2>
        ${alphaxivUrl ? `<a class="alphaxiv-btn" href="${alphaxivUrl}" target="_blank" rel="noopener" title="View on alphaxiv" style="display:inline-block;margin-right:0.3em;padding:0.18em 1.1em;background:#eaf1fb;color:#2d3a4e;font-size:0.92em;border-radius:7px;text-decoration:none;font-weight:600;box-shadow:0 1px 8px #e0e6ef33;transition:background 0.15s,color 0.15s,box-shadow 0.15s;border:1px solid #d3d8e2;letter-spacing:0.5px;vertical-align:middle;">alphaxiv</a>` : ''}
        <a class="pdf-btn" href="${pdfUrl}" target="_blank" rel="noopener">PDF</a>
      </div>
      <div class="paper-meta">
        <span class="paper-date">${paper.published}</span>
        <span class="paper-category">${(paper.category || []).join(', ')}</span>
      </div>
      <div class="paper-authors">${(paper.authors || []).join(', ')}</div>
      <div class="paper-summary">${paper.summary}</div>
    `;
    container.appendChild(card);
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

function fillCategorySelect(papers) {
  const select = document.getElementById('category-select');
  const categories = Array.from(new Set(papers.flatMap(p => Array.isArray(p.category) ? p.category : []).filter(Boolean)));
  select.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = 'ALL';
  optAll.textContent = 'All Categories';
  select.appendChild(optAll);
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });
}

function applyFilters() {
  const cat = document.getElementById('category-select').value;
  if (cat === 'ALL') {
    filteredPapers = allPapers;
  } else {
    filteredPapers = allPapers.filter(paper => Array.isArray(paper.category) && paper.category.includes(cat));
  }
  currentPage = 1;
  renderPapers(filteredPapers, currentPage);
}

async function loadAllPapers() {
  const container = document.getElementById('papers-container');
  container.innerHTML = '<p>Loading all papers...</p>';
  try {
    const response = await fetch('web/all_papers.json');
    if (!response.ok) throw new Error('Failed to load papers data');
    const raw = await response.json();
    allPapers = adaptRawData(raw);
    filteredPapers = allPapers;
    fillCategorySelect(allPapers);
    currentPage = 1;
    renderPapers(filteredPapers, currentPage);
    document.getElementById('last-updated').textContent = `Total ${allPapers.length} papers`;
  } catch (err) {
    container.innerHTML = `<p style=\"color:red;\">${err.message}</p>`;
    document.getElementById('pagination').innerHTML = '';
  }
}

async function init() {
  await loadAllPapers();
  document.getElementById('category-select').addEventListener('change', applyFilters);
}

document.addEventListener('DOMContentLoaded', init); 