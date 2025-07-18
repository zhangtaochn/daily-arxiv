// main.js

let allPapers = [];
let filteredPapers = [];
let currentPage = 1;
const pageSize = 20;

// 获取最新的已分类数据文件名（data/xxxx-xx-xx-classified.json）
async function getLatestClassifiedFile() {
  // 读取 data/index.json，获取最新的文件名
  try {
    const resp = await fetch('data/index.json');
    if (!resp.ok) throw new Error('Failed to load index.json');
    const files = await resp.json();
    const classifiedFiles = Array.isArray(files) ? files.filter(f => f.endsWith('-classified.json')) : [];
    if (classifiedFiles.length === 0) throw new Error('No classified data files found');
    classifiedFiles.sort().reverse(); // 日期降序
    return 'data/' + classifiedFiles[0];
  } catch (e) {
    // 兜底：返回原本写死的文件名
    return 'data/2025-07-17-classified.json';
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
  // 分页
  const startIdx = (page - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const pagePapers = papers.slice(startIdx, endIdx);
  pagePapers.forEach(paper => {
    let arxivId = '';
    if (paper.url) {
      const match = paper.url.match(/abs\/(.+)$/);
      if (match) arxivId = match[1];
    }
    const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '#';
    const card = document.createElement('div');
    card.className = 'paper-card';
    card.innerHTML = `
      <div class="paper-title-row">
        <h2 class="paper-title"><a href="${paper.url}" target="_blank" rel="noopener">${paper.title}</a></h2>
        <a class="pdf-btn" href="${pdfUrl}" target="_blank" rel="noopener">PDF</a>
      </div>
      <div class="paper-meta">
        <span class="paper-date">${paper.published}</span>
        <span class="paper-category">${paper.primary_category}</span>
      </div>
      <div class="paper-authors">${(paper.authors || []).join(', ')}</div>
      <div class="paper-summary">${paper.summary}</div>
      <div class="paper-tags">
        ${(paper.categories || []).map(cat => `<span class="tag">${cat}</span>`).join(' ')}
        ${(Array.isArray(paper.category) ? paper.category : []).map(cat => `<span class="tag category">${cat}</span>`).join(' ')}
      </div>
    `;
    container.appendChild(card);
  });
  // 渲染 LaTeX 公式
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
  // 页码显示（最多显示7个，当前页居中）
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
  // 事件绑定
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
  // 收集所有 category，扁平化、去重、去空
  const categories = Array.from(new Set(papers.flatMap(p => Array.isArray(p.category) ? p.category : []).filter(Boolean)));
  // 'Other' 单独处理
  const mainCategories = categories.filter(c => c !== 'Other');
  const hasOther = categories.includes('Other');
  select.innerHTML = '';
  // 默认选项：不含 Other
  const optAll = document.createElement('option');
  optAll.value = 'ALL';
  optAll.textContent = 'All Categories';
  select.appendChild(optAll);
  // 新增选项：包含 Other
  if (hasOther) {
    const optAllWithOther = document.createElement('option');
    optAllWithOther.value = 'ALL_WITH_OTHER';
    optAllWithOther.textContent = 'All (with Other)';
    select.appendChild(optAllWithOther);
  }
  mainCategories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });
  if (hasOther) {
    const optOther = document.createElement('option');
    optOther.value = 'Other';
    optOther.textContent = 'Other';
    select.appendChild(optOther);
  }
}

function applyFilters() {
  const cat = document.getElementById('category-select').value;
  if (cat === 'ALL') {
    // 不显示 Other
    filteredPapers = allPapers.filter(paper => Array.isArray(paper.category) && !paper.category.includes('Other'));
  } else if (cat === 'ALL_WITH_OTHER') {
    // 显示所有
    filteredPapers = allPapers;
  } else {
    filteredPapers = allPapers.filter(paper => Array.isArray(paper.category) && paper.category.includes(cat));
  }
  currentPage = 1;
  renderPapers(filteredPapers, currentPage);
}

async function loadPapers() {
  const container = document.getElementById('papers-container');
  container.innerHTML = '<p>Loading data...</p>';

  const dataFile = await getLatestClassifiedFile();

  let lastUpdated = '';

  try {
    const response = await fetch(dataFile);
    if (!response.ok) throw new Error('Failed to load data');
    const data = await response.json();
    let papers = data;
    if ('papers' in data) {
      papers = data.papers;
      lastUpdated = data.last_updated || '';
    }
    if (!Array.isArray(papers)) throw new Error('Invalid data format');
    allPapers = papers;
    filteredPapers = papers;
    fillCategorySelect(papers);
    currentPage = 1;
    renderPapers(filteredPapers, currentPage);
    // 设置更新时间
    if (lastUpdated) {
      document.getElementById('last-updated').textContent = `Last updated: ${lastUpdated}`;
    } else {
      const match = dataFile.match(/(\d{4}-\d{2}-\d{2})/);
      if (match) {
        document.getElementById('last-updated').textContent = `Last updated: ${match[1]}`;
      } else {
        document.getElementById('last-updated').textContent = '';
      }
    }
  } catch (err) {
    container.innerHTML = `<p style="color:red;">${err.message}</p>`;
    document.getElementById('pagination').innerHTML = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadPapers();
  document.getElementById('category-select').addEventListener('change', applyFilters);
}); 