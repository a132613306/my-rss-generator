// index.js
/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev index.js` to start a development server
 * - Run `wrangler deploy index.js` to publish your worker
 * - Run `wrangler dev --local` to start a local worker
 * - Run `wrangler publish --name my-worker` to publish your worker on the edge
 * - Run `wrangler whoami` to get your account details
 * - Run `wrangler tail my-worker` to tail logs from your published worker
 */

export default {
    async fetch(request, env, ctx) {
        // --- 1. 导入 Pyodide 运行时 ---
        const pyodide_script_url = 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js';

        // --- 2. 构建 HTML 响应，其中包含 Pyodide 和 Python 代码 ---
        const html_response = `
<!DOCTYPE html>
<html>
<head>
    <title>Universal RSS Generator</title>
</head>
<body>
    <h1>Universal RSS Generator</h1>
    <p>Processing your request...</p>
    <div id="output"></div>
    <script src="${pyodide_script_url}"></script>
    <script>
        async function main() {
            try {
                let outputDiv = document.getElementById('output');
                outputDiv.innerText = 'Loading Pyodide runtime...';

                // --- 加载 Pyodide ---
                let pyodide = await loadPyodide();
                outputDiv.innerText = 'Installing Python dependencies...';
                
                // --- 安装 Python 依赖 ---
                await pyodide.loadPackage("micropip");
                const micropip = pyodide.pyimport("micropip");
                await micropip.install(['beautifulsoup4==4.12.2', 'feedgen==0.9.0']);

                // --- 获取查询参数 ---
                const urlParams = new URLSearchParams(window.location.search);
                const target_url = urlParams.get('url');
                const max_items = urlParams.get('max_items') || '20';

                if (!target_url) {
                    outputDiv.innerText = "Error: Missing required 'url' parameter. Usage: ?url=https://example.com";
                    return;
                }

                outputDiv.innerText = 'Generating RSS...';

                // --- 定义 Python 代码 ---
                const pythonCode = \`
import logging
from pyodide.http import pyfetch
from urllib.parse import urljoin, urlparse
from datetime import datetime, timezone
import micropip
# Packages are installed above

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Default config
DEFAULT_CONFIG = {
    'title_selector': 'h1, h2, h3, .title, .post-title',
    'link_selector': 'a[href]',
    'description_selector': 'p, .excerpt, .summary',
    'container_selector': '.post, .article, .entry, main .content'
}

def is_valid_url(url):
    try:
        result = urlparse(url)
        return all([result.scheme, result.netloc])
    except:
        return False

async def scrape_and_generate_rss(url, max_items=20, config=DEFAULT_CONFIG):
    if not is_valid_url(url):
        logger.error(f"Invalid URL provided: {url}")
        from feedgen.feed import FeedGenerator
        error_fg = FeedGenerator()
        error_fg.id("invalid_url")
        error_fg.title("Invalid URL")
        error_fg.description(f"The provided URL '{url}' is not valid.")
        return error_fg.rss_str(pretty=True).decode('utf-8')

    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
        }
        logger.info(f"Fetching URL: {url}")
        response = await pyfetch(url, headers=headers)
        if not response.ok:
             raise Exception(f"HTTP Error {response.status}: {response.statusText}")
        
        content_text = await response.text()
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(content_text, 'html.parser')

        from feedgen.feed import FeedGenerator
        feed_title_tag = soup.find('title')
        feed_title = feed_title_tag.get_text() if feed_title_tag else f"RSS for {urlparse(url).netloc}"
        feed_description = f"Generated RSS feed for {url}"

        fg = FeedGenerator()
        fg.id(url)
        fg.title(feed_title)
        fg.author({'name': 'Universal RSS Generator'})
        fg.link(href=url, rel='alternate')
        fg.description(feed_description)

        items_added = 0
        potential_items = []

        container_selector = config.get('container_selector')
        if container_selector:
            containers = soup.select(container_selector)
            logger.info(f"Found {len(containers)} containers using selector '{container_selector}'")
            for container in containers[:int(max_items) * 2]:
                links_in_container = container.select(config['link_selector'])
                for link_tag in links_in_container:
                    potential_items.append((link_tag, container))
        else:
            all_links = soup.select(config['link_selector'])
            logger.info(f"Found {len(all_links)} links using selector '{config['link_selector']}'")
            for link_tag in all_links:
                parent = link_tag.find_parent()
                potential_items.append((link_tag, parent if parent else link_tag))

        logger.info(f"Processing {len(potential_items)} potential items...")

        for link_tag, context_element in potential_items:
            if items_added >= int(max_items):
                break

            link_href = link_tag.get('href')
            if not link_href:
                continue

            full_link = urljoin(url, link_href)

            if not is_valid_url(full_link):
                logger.debug(f"Skipping invalid generated link: {full_link}")
                continue

            item_title = ""
            item_title = link_tag.get('title') or link_tag.get_text(strip=True)

            if not item_title or len(item_title) < 3:
                title_tag = context_element.select_one(config['title_selector']) if context_element != link_tag else None
                if title_tag and title_tag != link_tag:
                    item_title = title_tag.get_text(strip=True)

            if not item_title:
                logger.debug(f"Skipping item, no title found for link: {full_link}")
                continue

            item_description = ""
            desc_tag = context_element.select_one(config['description_selector']) if context_element != link_tag else None
