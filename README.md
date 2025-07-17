# Arxiv Assistant

## 功能说明

本项目每天自动拉取 arXiv 计算机科学（cs）大类下的所有最新论文，并保存为 json 文件，供后续处理和前端展示。

github page: https://zhangtaochn.github.io/daily-arxiv/

## 依赖

- Python 3.7+
- arxiv
- requests

安装依赖：
```bash
pip install -r requirements.txt
```

## 数据抓取

运行：
```bash
python scripts/fetch_arxiv.py
```

会自动抓取 arXiv cs 大类下的最新论文，生成的数据文件可直接用于后续分类和前端展示。


