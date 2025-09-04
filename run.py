import os
import json
import yaml
import requests
import time 
import traceback 
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import xml.etree.ElementTree as ET
from collections import defaultdict
from openai import OpenAI
import fire 


API_KEY = os.environ.get("API_KEY")
BASE_URL = os.environ.get("BASE_URL")
MODEL = os.environ.get("MODEL")
TOP_N = int(os.environ.get("TOP_N", -1))
KEYWORDS = os.environ.get("KEYWORDS", "all")
client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
DATA_DIR = 'data'

ARXIV_API_URL = 'http://export.arxiv.org/api/query'
MAX_WORKERS = 20  # 并发数

def search_arxiv_papers(search_query, max_results=1000):
    """Search arXiv papers using the API"""
    # Calculate date 6 months ago
    date_from = (datetime.now() - timedelta(days=10)).strftime('%Y%m%d%H%M%S0000')
    date_to = datetime.now().strftime('%Y%m%d%H%M%S0000')
    
    params = {
        'search_query': f'{search_query} AND submittedDate:[{date_from} TO {date_to}]',
        'start': 0,
        'max_results': max_results if TOP_N == -1 else TOP_N,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending'
    }
    
    response = requests.get(ARXIV_API_URL, params=params)
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

        paper["arxiv_abstract_url"] = f"http://arxiv.org/abs/{paper['id']}"
        paper["arxiv_pdf_url"] = f"http://arxiv.org/pdf/{paper['id']}.pdf"
        paper["alphaxiv_url"] = f"http://alphaxiv.org/abs/{paper['id']}"
        papers.append(paper)
    
    return papers

def fetch_papers_by_keywords(keywords):
    """Fetch papers for each keyword category"""
    all_papers = {}
    for category, config in keywords['keywords'].items():
        print(f"Searching for papers in category: {category}")
        print(f"Search terms: {config['search_query']}")
        
        try:
            papers = search_arxiv_papers(config['search_query'], max_results=1000)
            all_papers[category] = {
                'papers': papers
            }
            print(f"Found {len(papers)} papers for {category}")
        except Exception as e:
            print(f"Error fetching papers for {category}: {e}")
            all_papers[category] = {
                'papers': []
            }
    return all_papers


def filter_papers(papers_by_category):
    all_papers_id = set()
    # Load all paper IDs from the web/all_papers.json
    if os.path.exists('web/all_papers.json'):
        with open('web/all_papers.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
            if isinstance(data, dict) and 'all_papers_list' in data:
                for paper in data['all_papers_list']:
                    all_papers_id.add(paper['id'])

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


def classify_paper(paper, categories, retry=3):
    title = paper["title"]
    summary = paper["summary"]

    system_prompt = f"""
# Rule
You are a paper classification assistant. Based on the title and abstract below, select the core relevant topics that this paper belongs to from the given topic list (no more than 3). 
If none of the topics are relevant, please set category_list to ["Other"].
# Topic list:
- {categories}
# Answer format
Please provide your answer as a json with two fields: reason (str), category_list (list).
"""

    prompt = f"""
# Title: 
- {title}
# Abstract: 
- {summary}
"""

    for _ in range(retry):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ]
            )
            js = None 
            try:
                js = json.loads(response.choices[0].message.content)
            except:
                js = json.loads(response.choices[0].message.content[7:-3])
            
            reason = js["reason"]
            category_list = js["category_list"]
            break 
        except:
            print(f"Retry {_} failed")
            traceback.print_exc()
            reason = "" 
            category_list = ["Classification Failed"]
            time.sleep(1)

    paper["cls_reason"] = reason
    paper["llm_cls_result"] = category_list
    return paper

def paper_cls(papers, keywords):
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_idx = {executor.submit(classify_paper, paper, keywords) for paper in papers.values()}
        for future in as_completed(future_to_idx):
            paper = future.result()
            papers[paper["id"]] = paper 
    return papers


def merge_papers(new_papers_file):
    paper_ids = set()
    all_papers_list = []
    # Load existing papers to avoid duplicates
    if os.path.exists('web/all_papers.json'):
        with open('web/all_papers.json', 'r', encoding='utf-8') as f:
            existing_data = json.load(f)
            all_papers_list = existing_data.get('all_papers_list', [])
            paper_ids = {p['id'] for p in all_papers_list}

    new_papers = []
    with open(new_papers_file, 'r', encoding='utf-8') as f:
        papers = json.load(f)
        for paper_id, paper in papers.items():
            if paper_id not in paper_ids:
                paper["published_date"] = paper["published"][0:10]
                all_papers_list.append(paper)
                new_papers.append(paper)
                paper_ids.add(paper_id)

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
    all_papers_list.sort(key=lambda i: i["updated"], reverse=True)

    output = {
        "current_update_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        "count_new_papers": count_new_papers,
        "count_all_papers": total_count_papers,
        "all_papers_list": all_papers_list
    }

    with open('web/all_papers.json', 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Added {len(new_papers)} new papers.")
    print(f"Total papers: {len(all_papers_list)}.")

def run_pipeline():
    keywords = yaml.safe_load(KEYWORDS)
    papers_by_category = fetch_papers_by_keywords(keywords)
    papers_filtered = filter_papers(papers_by_category)
    papers_classified = paper_cls(papers_filtered, keywords)
    filename = datetime.now().strftime('%Y%m%d%H%M%S')
    output_path = os.path.join(DATA_DIR, f'{filename}.json')

    json.dump(papers_classified, open(output_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    merge_papers(output_path)
    print(f"Saved {len(papers_classified)} papers to {output_path}")

def run_server(port=8000):
    """Starts a simple HTTP server for the web interface."""
    import http.server
    import socketserver

    os.chdir('web')
    Handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("", port), Handler) as httpd:
        print(f"Serving at port {port}")
        httpd.serve_forever()

if __name__ == "__main__":
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR)
    fire.Fire({
        'run_pipeline': run_pipeline,
        'run_server': run_server,
    })
