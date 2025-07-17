import os
import json
from datetime import datetime
import arxiv

DATA_DIR = 'data'


def fetch_cs_papers(max_results=200):
    search = arxiv.Search(
        query="cat:cs.*",
        max_results=max_results,
        sort_by=arxiv.SortCriterion.SubmittedDate
    )
    results = []
    for result in search.results():
        results.append({
            'title': result.title,
            'authors': [a.name for a in result.authors],
            'summary': result.summary,
            'published': result.published.strftime('%Y-%m-%d'),
            'url': result.entry_id,
            'primary_category': result.primary_category,
            'categories': result.categories
        })
    return results

def save_papers(papers):
    today = datetime.now().strftime('%Y-%m-%d')
    now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, f'{today}.json')
    output = {
        'last_updated': now_str,
        'papers': papers
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f'Saved {len(papers)} papers to {out_path} (last_updated: {now_str})')

def main():
    papers = fetch_cs_papers()
    save_papers(papers)

if __name__ == '__main__':
    main() 