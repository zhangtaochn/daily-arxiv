import os
import json
import requests
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

API_KEY = os.environ.get("API_KEY")
BASE_URL = os.environ.get("BASE_URL")
MODEL = os.environ.get("MODEL")
TOP_N = int(os.environ.get("TOP_N", -1))

DATA_DIR = "data"
CATEGORIES_FILE = "categories.txt"
MAX_WORKERS = 20  # 并发数

def get_latest_data_file():
    files = [f for f in os.listdir(DATA_DIR) if f.endswith(".json") and not f.endswith("-classified.json")]
    files.sort(reverse=True)
    return os.path.join(DATA_DIR, files[0]) if files else None

def read_categories():
    with open(CATEGORIES_FILE, "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]

def classify_paper(paper, categories):
    title = paper["title"]
    summary = paper["summary"]
    prompt = (
        "You are a paper classification assistant. Based on the title and abstract below, select up to 3 most relevant topics from the given topic list. "
        "If none of the topics are relevant, please answer only 'Other'. Do not include 'Other' if you have selected any other topic.\n"
        f"Topic list:\n- " + "\n- ".join(categories) + "\n\n"
        f"Title: {title}\nAbstract: {summary}\n\n"
        "Please output a comma-separated list of topic names, e.g.: LLM Architecture, MoE, VLA."
    )
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    data = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are a paper classification assistant."},
            {"role": "user", "content": prompt}
        ]
    }
    try:
        resp = requests.post(f"{BASE_URL}/chat/completions", headers=headers, json=data, timeout=60)
        resp.raise_for_status()
        content = resp.json()['choices'][0]['message']['content'].strip()
        # 解析为 list，支持逗号分隔或换行分隔
        if '\n' in content and ',' not in content:
            cats = [c.strip() for c in content.split('\n') if c.strip()]
        else:
            cats = [c.strip() for c in content.replace('\n', ',').split(',') if c.strip()]
        # 去重、去空，最多3个
        seen = set()
        category_list = []
        for c in cats:
            if c and c not in seen:
                seen.add(c)
                category_list.append(c)
            if len(category_list) == 3:
                break
        # 优化：如果有主类别（非 'Other'），则移除 'Other'，只在没有主类别时保留 'Other'
        main_categories = [c for c in category_list if c.lower() != 'other']
        if main_categories:
            category_list = main_categories[:3]
        else:
            category_list = ['Other']
    except Exception as e:
        print(f"API error: {e}")
        category_list = ["Classification Failed"]
    paper["category"] = category_list
    return paper

def main():
    data_file = get_latest_data_file()
    if not data_file:
        print("未找到数据文件")
        return
    with open(data_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "papers" in data:
        papers = data["papers"]
    elif isinstance(data, list):
        papers = data
    else:
        print("数据文件格式不正确")
        return
    categories = read_categories()
    # 只处理前40篇论文（测试阶段）
    papers = papers[:TOP_N] if TOP_N > 0 else papers
    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_paper = {executor.submit(classify_paper, paper, categories): paper for paper in papers}
        for future in as_completed(future_to_paper):
            paper = future.result()
            results.append(paper)
            print(f"{paper['title'][:30]}... => {paper['category']}")
    # 保存分类结果
    today = datetime.now().strftime('%Y-%m-%d')
    out_path = os.path.join(DATA_DIR, f"{today}-classified.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"papers": results}, f, ensure_ascii=False, indent=2)
    print(f"分类结果已保存到 {out_path}")

if __name__ == "__main__":
    main() 