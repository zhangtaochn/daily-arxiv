import os
import json
import yaml
import requests
import time 
import traceback 
from datetime import datetime, timedelta, date
from concurrent.futures import ThreadPoolExecutor, as_completed
import xml.etree.ElementTree as ET
from collections import defaultdict
from openai import OpenAI
import fire 
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import random


API_KEY = os.environ.get("API_KEY")
BASE_URL = os.environ.get("BASE_URL")
MODEL = os.environ.get("MODEL")
TOP_N = int(os.environ.get("TOP_N", -1))
KEYWORDS = os.environ.get("KEYWORDS", "all")
KEYWORDS_FILE = os.environ.get("KEYWORDS_FILE", "")
# Lazy init client to avoid requiring API_KEY when only serving static files
_client = None

# Recent window for web/recent.json (days)
RECENT_DAYS = int(os.environ.get("RECENT_DAYS", 10))
# Data retention policy: keep papers from last N days (default 90 days = 3 months)
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", 90))

# Test mode settings
TEST_MODE = os.environ.get("TEST_MODE", "").lower() in ("1", "true", "yes")
TEST_MAX_RESULTS = int(os.environ.get("TEST_MAX_RESULTS", 10))
TEST_MAX_CATEGORIES = int(os.environ.get("TEST_MAX_CATEGORIES", 0))  # 0 = all


def get_openai_client():
    global _client
    if _client is None:
        if not API_KEY:
            raise RuntimeError("API_KEY is not set; cannot initialize OpenAI client.")
        _client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
    return _client

DATA_DIR = 'data'

ARXIV_API_URL = 'https://export.arxiv.org/api/query'
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", 12))  # 并发数（可通过环境变量覆盖）

# requests 会话 + 重试与 UA
session = requests.Session()
retries = Retry(total=5, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504])
adapter = HTTPAdapter(max_retries=retries, pool_connections=50, pool_maxsize=50)
session.mount('http://', adapter)
session.mount('https://', adapter)
session.headers.update({
    'User-Agent': 'daily-arxiv-bot/1.0 (+https://github.com/zhangtaochn/daily-arxiv)'
})

def search_arxiv_papers(search_query, max_results=1000):
    """Search arXiv papers using the API (最近10天增量)"""
    # 最近 10 天窗口
    date_from = (datetime.now() - timedelta(days=10)).strftime('%Y%m%d')
    date_to = datetime.now().strftime('%Y%m%d')
    
    params = {
        'search_query': f'{search_query} AND submittedDate:[{date_from} TO {date_to}]',
        'start': 0,
        'max_results': max_results if TOP_N == -1 else TOP_N,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending'
    }
    
    response = session.get(ARXIV_API_URL, params=params, timeout=120)
    response.raise_for_status()
    root = ET.fromstring(response.content)

    
    papers = []
    for entry in root.findall('.//{http://www.w3.org/2005/Atom}entry'):
        paper = {
            'title': entry.find('.//{http://www.w3.org/2005/Atom}title').text.strip(),
            'summary': entry.find('.//{http://www.w3.org/2005/Atom}summary').text.strip(),
            'published': entry.find('.//{http://www.w3.org/2005/Atom}published').text,
            'updated': entry.find('.//{http://www.w3.org/2005/Atom}updated').text,
            'id': entry.find('.//{http://www.w3.org/2005/Atom}id').text.split("abs/")[1],
            'authors': []
        }        
        # Extract authors
        for author in entry.findall('.//{http://www.w3.org/2005/Atom}author'):
            name = author.find('.//{http://www.w3.org/2005/Atom}name').text
            paper['authors'].append(name)

        paper["arxiv_abstract_url"] = f"https://arxiv.org/abs/{paper['id']}"
        paper["arxiv_pdf_url"] = f"https://arxiv.org/pdf/{paper['id']}.pdf"
        paper["alphaxiv_url"] = f"https://alphaxiv.org/abs/{paper['id']}"
        papers.append(paper)
    
    return papers


def fetch_papers_by_keywords(keywords):
    """Fetch papers for each keyword category"""
    all_papers = {}
    categories = list(keywords['keywords'].items())

    # Test mode: limit number of categories
    if TEST_MODE and TEST_MAX_CATEGORIES > 0:
        categories = categories[:TEST_MAX_CATEGORIES]
        print(f"[TEST MODE] Only processing {TEST_MAX_CATEGORIES} categories")

    for category, config in categories:
        print(f"Searching for papers in category: {category}")
        print(f"Search terms: {config['search_query']}")

        max_results = TEST_MAX_RESULTS if TEST_MODE else 1000

        for _ in range(10):
            try:
                papers = search_arxiv_papers(config['search_query'], max_results=max_results)
                all_papers[category] = {
                    'papers': papers
                }
                print(f"Found {len(papers)} papers for {category}")
                break
            except Exception as e:
                print(f"Error fetching papers for {category}: {e}")
                all_papers[category] = {
                    'papers': []
                }
    return all_papers


def _safe_json_load_file(path: str):
    """Load JSON from a file safely. If decoding fails, return {} and warn.
    This prevents pipeline crash when an old web/all_papers.json is corrupted (e.g., bad merge).
    """
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: failed to parse JSON from {path}: {e}. Will rebuild it.")
        return {}


def filter_papers(papers_by_category):
    all_papers_id = set()
    # Load all paper IDs from the web/all_papers.json
    if os.path.exists('web/all_papers.json'):
        data = _safe_json_load_file('web/all_papers.json')
        if isinstance(data, dict) and 'all_papers_list' in data:
            for paper in data.get('all_papers_list', []) or []:
                try:
                    all_papers_id.add(paper['id'])
                except Exception:
                    continue

    all_papers = dict()
    for category, data in papers_by_category.items():
        for paper in data.get("papers", []):
            if paper["id"] not in all_papers_id:
                if paper["id"] not in all_papers:
                    paper["keywords"] = [category]
                    all_papers[paper["id"]] = paper
                else:
                    all_papers[paper["id"]]["keywords"].append(category)
    return all_papers


def _safe_json_extract(text: str):
    """Try to extract a JSON object from arbitrary text."""
    if not text:
        return None
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        snippet = text[start:end+1]
        try:
            return json.loads(snippet)
        except Exception:
            pass
    # fallback: try parse the whole
    try:
        return json.loads(text)
    except Exception:
        return None


def classify_paper(paper, topics_list, retry=3):
    title = paper.get("title", "")[:4000]
    summary = paper.get("summary", "")[:8000]

    topics_str = "\n- ".join(topics_list)

    system_prompt = f"""
# Rule
You are a paper classification and recommendation assistant. Based on the title and abstract below, do two things:

1) Select the core relevant topics from the topic list (no more than 3). If none applies, set category_list to ["Other"].

2) Provide a composite recommendation score in [0,5] (allow 0.5 increments). Compute it as a weighted combination of:
- Relevance to the provided topics / user intent: 40%
- Novelty and originality (new ideas, non-incremental/SOTA contributions): 30%
- Evidence and rigor (empirical results, ablations, theory, reproducibility): 20%
- Clarity and practicality (applicability for applied ML/AI engineers): 10%

Also provide a short recommendation_reason (1–2 sentences) that succinctly justifies the score.

# Topic list:
- {topics_str}

# Answer format (strict JSON, output ONLY the JSON object):
{{"reason": "string", "category_list": ["string"], "recommend_score": 0.0, "recommend_reason": "string"}}
"""

    prompt = f"""
# Title: 
- {title}
# Abstract: 
- {summary}
"""

    backoff_base = 1.0
    last_reason = ""
    last_categories = ["Classification Failed"]
    last_rec_score = None
    last_rec_reason = ""

    for attempt in range(retry):
        try:
            client = get_openai_client()
            response = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ]
            )
            content = response.choices[0].message.content
            js = _safe_json_extract(content)
            if js and isinstance(js, dict):
                reason = str(js.get("reason", ""))
                category_list = js.get("category_list", None)
                if not isinstance(category_list, list):
                    category_list = ["Other"]
                category_list = [str(c) for c in category_list][:3]

                rec_reason = str(js.get("recommend_reason", "")).strip()
                rec_score_raw = js.get("recommend_score", None)
                rec_score = None
                if rec_score_raw is not None:
                    try:
                        rec_score = float(rec_score_raw)
                        # clamp to [0,5] and round to nearest 0.5
                        rec_score = max(0.0, min(5.0, rec_score))
                        rec_score = round(rec_score * 2) / 2.0
                    except Exception:
                        rec_score = None

                last_reason, last_categories = reason, category_list
                last_rec_reason = rec_reason or last_rec_reason
                last_rec_score = rec_score if rec_score is not None else last_rec_score
                break
            else:
                raise ValueError("LLM returned non-JSON or invalid format")
        except Exception:
            print(f"Classification attempt {attempt+1}/{retry} failed for {paper.get('id')}")
            traceback.print_exc()
            delay = backoff_base * (2 ** attempt) + random.uniform(0, 0.5)
            time.sleep(delay)
    else:
        reason = last_reason
        category_list = last_categories
        rec_reason = last_rec_reason
        rec_score = last_rec_score

    paper["cls_reason"] = reason
    paper["llm_cls_result"] = category_list
    if rec_score is not None:
        paper["rec_score"] = rec_score
    if rec_reason:
        paper["rec_reason"] = rec_reason
    return paper


def paper_cls(papers, keywords):
    # derive topics list from keywords config
    topics_list = list(keywords.get('keywords', {}).keys())

    # Test mode: only classify a small subset
    if TEST_MODE:
        paper_items = list(papers.items())[:TEST_MAX_RESULTS]
        print(f"[TEST MODE] Only classifying {len(paper_items)} papers")
        papers_to_process = dict(paper_items)
    else:
        papers_to_process = papers

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(classify_paper, paper, topics_list): pid for pid, paper in papers_to_process.items()}
        for future in as_completed(futures):
            paper = future.result()
            papers[paper["id"]] = paper
    return papers


def cleanup_old_by_date_files(keep_dates: list):
    """Remove by_date files that are not in keep_dates list."""
    by_date_dir = os.path.join('web', 'by_date')
    if not os.path.exists(by_date_dir):
        return

    removed_count = 0
    for filename in os.listdir(by_date_dir):
        if filename.endswith('.json'):
            date_str = filename[:-5]  # remove .json
            if date_str not in keep_dates:
                try:
                    os.remove(os.path.join(by_date_dir, filename))
                    removed_count += 1
                except Exception as e:
                    print(f"Warning: could not remove {filename}: {e}")
    if removed_count > 0:
        print(f"Cleaned up {removed_count} old by_date files.")


def cleanup_old_data_files(retention_days: int = RETENTION_DAYS):
    """Remove data archive files older than retention_days."""
    if not os.path.exists(DATA_DIR):
        return

    cutoff_date = datetime.now() - timedelta(days=retention_days)
    removed_count = 0

    for filename in os.listdir(DATA_DIR):
        if filename.endswith('.json'):
            try:
                # Parse timestamp from filename (YYYYMMDDHHMMSS.json)
                file_datetime = datetime.strptime(filename[:14], '%Y%m%d%H%M%S')
                if file_datetime < cutoff_date:
                    os.remove(os.path.join(DATA_DIR, filename))
                    removed_count += 1
            except (ValueError, IndexError):
                # Skip files with invalid naming
                continue
            except Exception as e:
                print(f"Warning: could not remove {filename}: {e}")

    if removed_count > 0:
        print(f"Cleaned up {removed_count} old data archive files.")


def merge_papers(new_papers_file):
    paper_ids = set()
    all_papers_list = []
    # Load existing papers to avoid duplicates
    if os.path.exists('web/all_papers.json'):
        existing_data = _safe_json_load_file('web/all_papers.json')
        if isinstance(existing_data, dict):
            lst = existing_data.get('all_papers_list', [])
            if isinstance(lst, list):
                all_papers_list = lst
                try:
                    paper_ids = {p['id'] for p in all_papers_list if isinstance(p, dict) and 'id' in p}
                except Exception:
                    paper_ids = set()

    new_papers = []
    with open(new_papers_file, 'r', encoding='utf-8') as f:
        papers = json.load(f)
        for paper_id, paper in papers.items():
            if paper_id not in paper_ids:
                paper["published_date"] = paper.get("published", "")[:10]
                all_papers_list.append(paper)
                new_papers.append(paper)
                paper_ids.add(paper_id)

    # Apply data retention policy: filter out papers older than RETENTION_DAYS
    cutoff_date = datetime.now().date() - timedelta(days=RETENTION_DAYS)
    filtered_papers = []
    removed_count = 0

    for paper in all_papers_list:
        pub_date_str = paper.get('published_date') or (paper.get('published', '')[:10])
        pub_date = _date_from_str(pub_date_str)
        if pub_date and pub_date >= cutoff_date:
            filtered_papers.append(paper)
        else:
            removed_count += 1

    all_papers_list = filtered_papers
    if removed_count > 0:
        print(f"Applied retention policy: removed {removed_count} papers older than {RETENTION_DAYS} days.")

    count_new_papers = defaultdict(int)
    count_new_papers["All"] = len(new_papers)
    for paper in new_papers:
        for category in paper.get("llm_cls_result", []):
            count_new_papers[category] += 1

    total_count_papers = defaultdict(int)
    for paper in all_papers_list:
        total_count_papers["All"] += 1
        for category in paper.get("llm_cls_result", []):
            total_count_papers[category] += 1

    # Sort all papers by update date
    all_papers_list.sort(key=lambda i: i.get("updated", ""), reverse=True)

    output = {
        "current_update_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "count_new_papers": count_new_papers,
        "count_all_papers": total_count_papers,
        "all_papers_list": all_papers_list
    }

    # Ensure web directory exists
    os.makedirs('web', exist_ok=True)

    with open('web/all_papers.json', 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Added {len(new_papers)} new papers.")
    print(f"Total papers after retention: {len(all_papers_list)}.")

    return output


def _date_from_str(s: str) -> date:
    try:
        return datetime.strptime(s, '%Y-%m-%d').date()
    except Exception:
        return None


def build_split_outputs(all_papers_list, count_new_papers, count_all_papers, current_update_time, recent_days: int = RECENT_DAYS):
    """Build lightweight outputs for faster frontend loading:
    - web/by_date/YYYY-MM-DD.json (array of papers for that date)
    - web/recent.json (array of last N days)
    - web/manifest.json (global stats, dates list, recent_days)
    """
    os.makedirs('web/by_date', exist_ok=True)

    by_date_map = defaultdict(list)
    for p in all_papers_list:
        d = p.get('published_date') or (p.get('published') or '')[:10]
        p['published_date'] = d
        if d:
            by_date_map[d].append(p)

    # Write per-date files (minified)
    for d, lst in by_date_map.items():
        lst.sort(key=lambda i: i.get('updated', ''), reverse=True)
        with open(os.path.join('web', 'by_date', f'{d}.json'), 'w', encoding='utf-8') as f:
            json.dump(lst, f, ensure_ascii=False, separators=(',', ':'))

    # Clean up old by_date files that are no longer in our dataset
    cleanup_old_by_date_files(list(by_date_map.keys()))

    # Clean up old data archive files
    cleanup_old_data_files()

    # Build recent window
    today = datetime.now().date()
    start_date = today - timedelta(days=max(1, recent_days) - 1)
    recent_list = []
    for p in all_papers_list:
        d = _date_from_str(p.get('published_date') or (p.get('published') or '')[:10])
        if d and d >= start_date:
            recent_list.append(p)
    # Keep same order as all_papers_list (already sorted desc by updated)

    with open(os.path.join('web', 'recent.json'), 'w', encoding='utf-8') as f:
        json.dump(recent_list, f, ensure_ascii=False, separators=(',', ':'))

    # Manifest
    dates = sorted(by_date_map.keys(), reverse=True)
    manifest = {
        'current_update_time': current_update_time,
        'count_new_papers': count_new_papers,
        'count_all_papers': count_all_papers,
        'recent_days': recent_days,
        'dates': dates,
        'by_date_base': 'web/by_date/'
    }
    with open(os.path.join('web', 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def run_pipeline():
    # Load keywords - from KEYWORDS_FILE if provided, otherwise from KEYWORDS
    if KEYWORDS_FILE and os.path.exists(KEYWORDS_FILE):
        print(f"Loading keywords from file: {KEYWORDS_FILE}")
        with open(KEYWORDS_FILE, 'r', encoding='utf-8') as f:
            keywords = yaml.safe_load(f)
    else:
        keywords = yaml.safe_load(KEYWORDS)

    papers_by_category = fetch_papers_by_keywords(keywords)
    papers_filtered = filter_papers(papers_by_category)
    papers_classified = paper_cls(papers_filtered, keywords)
    filename = datetime.now().strftime('%Y%m%d%H%M%S')
    output_path = os.path.join(DATA_DIR, f'{filename}.json')

    json.dump(papers_classified, open(output_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    merged = merge_papers(output_path)

    # Build manifest/recent/by_date for frontend fast loading
    build_split_outputs(
        all_papers_list=merged['all_papers_list'],
        count_new_papers=merged['count_new_papers'],
        count_all_papers=merged['count_all_papers'],
        current_update_time=merged['current_update_time'],
        recent_days=RECENT_DAYS,
    )

    print(f"Saved {len(papers_classified)} papers to {output_path}")


def run_server(port=8000):
    """Starts a simple HTTP server for the web interface (serve from project root)."""
    import http.server
    import socketserver

    Handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("", port), Handler) as httpd:
        print(f"Serving at port {port}. Open http://localhost:{port}/")
        httpd.serve_forever()

if __name__ == "__main__":
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR)
    fire.Fire({
        'run_pipeline': run_pipeline,
        'run_server': run_server,
    })
