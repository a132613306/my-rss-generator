// index.js
/**
 * Universal RSS Generator for Cloudflare Workers using Pyodide
 * Optimized for specific torrent site structure
 */
export default {
    async fetch(request, env, ctx) {
        // --- 1. Pyodide CDN URL ---
        const pyodide_script_url = 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js';

        // --- 2. 构建 HTML 响应，其中包含 Pyodide 和 Python 代码 ---
        const html_response = `
<!DOCTYPE html>
<html>
<head>
    <title>Universal RSS Generator</title>
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        #output { white-space: pre-wrap; border: 1px solid #ccc; padding: 10px; margin-top: 10px; }
        a.download-link { display: inline-block; margin-top: 10px; padding: 10px 15px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; }
        a.download-link:hover { background-color: #0056b3; }
    </style>
</head>
<body>
    <h1>Universal RSS Generator</h1>
    <p>Processing your request...</p>
    <div id="output">Initializing...</div>
    <script src="${pyodide_script_url}"></script>
    <script>
        async function main() {
            try {
                let outputDiv = document.getElementById('output');
                outputDiv.innerText = 'Loading Pyodide runtime...';

                // --- 加载 Pyodide ---
                let pyodide = await loadPyodide();
                outputDiv.innerText = 'Installing Python dependencies (this may take a moment)...';
                
                // --- 安装 Python 依赖 ---
                // 修正：移除 feedgen 的版本号，避免找不到纯 Python wheel 的错误
                await pyodide.loadPackage("micropip");
                const micropip = pyodide.pyimport("micropip");
                await micropip.install(['beautifulsoup4', 'feedgen']);

                outputDiv.innerText = 'Dependencies installed. Preparing to scrape...';

                // --- 获取查询参数 ---
                const urlParams = new URLSearchParams(window.location.search);
                const target_url = urlParams.get('url');
                const max_items = urlParams.get('max_items') || '20';

                if (!target_url) {
                    outputDiv.innerText = "Error: Missing required 'url' parameter. Usage: ?url=https://example.com";
                    return;
                }

                outputDiv.innerText = 'Generating RSS for: ' + target_url + ' ...';

                // --- 定义 Python 代码 ---
                // 注意：在模板字符串中，需要转义反引号 (\`) 和美元符号(\\$)
                const pythonCode = \`
import logging
from pyodide.http import pyfetch
from urllib.parse import urljoin, urlparse
from datetime import datetime, timezone
import micropip
from js import document # 显式导入 js.document
# Packages are installed above

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def scrape_and_generate_rss(url, max_items=20):
    """
    针对特定网站结构抓取数据并生成 RSS。
    目标结构: 每个资源在一个 <tr> 标签内。
    - 名称: <tr> 内第二个 <td> 中的 <a> 标签文本。
    - 磁力链接: <tr> 内包含 magnet: 链接的 <a> 标签的 href。
    - 时间: <tr> 内第四个 <td> (class="text-center") 的文本。
    """
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
        
        # --- 针对性抓取逻辑 ---
        # 假设每个资源条目都在一个 <tr> 标签中
        rows = soup.select('tr')
        logger.info(f"Found {len(rows)} table rows.")

        for row in rows:
            if items_added >= int(max_items):
                break

            # 1. 提取磁力链接 (优先查找)
            magnet_link_tag = row.select_one('a[href^="magnet:?xt=urn:btih:"]')
            if not magnet_link_tag:
                logger.debug("Skipping row: No magnet link found.")
                continue
            
            magnet_href = magnet_link_tag.get('href')
            full_magnet_link = urljoin(url, magnet_href)

            # 2. 提取名称 (在磁力链接同级或附近查找名称链接)
            # 策略：查找同一行内其他 <a> 标签，排除磁力链接和下载链接
            all_links_in_row = row.select('a[href]')
            item_title = ""
            title_link_href = ""
            for link in all_links_in_row:
                href = link.get('href', '')
                # 排除磁力链接和 .torrent 下载链接
                if href.startswith('magnet:?xt=urn:btih:') or href.endswith('.torrent'):
                    continue
                # 假设第一个非磁力/非torrent链接是名称链接
                item_title = link.get_text(strip=True)
                title_link_href = href
                break
            
            # 如果没找到名称链接，尝试从其他 td 中获取文本
            if not item_title:
                 # 查找第二个 td (根据截图结构推测)
                 tds = row.select('td')
                 if len(tds) >= 2:
                     # 尝试从第二个 td 中的链接获取标题
                     title_link_in_td = tds[1].select_one('a')
                     if title_link_in_td:
                         item_title = title_link_in_td.get_text(strip=True)
                         title_link_href = title_link_in_td.get('href', '')
                     else:
                         # 如果第二个 td 没有链接，直接取其文本
                         item_title = tds[1].get_text(strip=True)
            
            # 如果还是没有标题，则跳过
            if not item_title:
                logger.debug("Skipping row: No title found.")
                continue

            # 构建标题链接的完整 URL (如果有的话)
            full_title_link = urljoin(url, title_link_href) if title_link_href else full_magnet_link

            # 3. 提取时间 (查找第四个 class="text-center" 的 td)
            time_text = ""
            time_tds = row.select('td.text-center')
            if len(time_tds) >= 4: # 确保有足够的 .text-center td
                # 通常第四个是时间 (索引 3)
                time_text = time_tds[3].get_text(strip=True) 
            
            # 如果没找到第四个，尝试找第三个
            if not time_text and len(time_tds) >= 3:
                 time_text = time_tds[2].get_text(strip=True)

            logger.debug(f"Found item: Title='{item_title}', Magnet='{full_magnet_link}', Time='{time_text}'")

            # --- 构造 RSS 条目描述 ---
            description_parts = []
            if time_text:
                description_parts.append(f"<b>Time:</b> {time_text}")
            # description_parts.append(f"<b>Magnet:</b> <a href=\\"{full_magnet_link}\\">{full_magnet_link}</a>")
            # 为了简洁，描述中可以只放时间，链接放在条目本身
            item_description = "<br/>".join(description_parts) if description_parts else "No description available."

            try:
                fe = fg.add_entry()
                fe.id(full_magnet_link) # 使用磁力链接作为唯一 ID
                fe.title(item_title)
                fe.link(href=full_magnet_link, rel='alternate') # 主链接设为磁力链接
                # 可以添加一个指向网页的链接
                # fe.link(href=full_title_link, rel='related') 
                fe.description(item_description)
                
                # --- 尝试解析时间并设置发布日期 ---
                if time_text:
                    # 假设时间格式是 'YYYY-MM-DD HH:MM:SS'
                    try:
                        pub_date = datetime.strptime(time_text, '%Y-%m-%d %H:%M:%S')
                        # PyRSS2Gen/Feedgen 通常期望 timezone-aware datetime
                        # 如果解析出的 datetime 是 naive 的，需要添加 timezone
                        if pub_date.tzinfo is None:
                            pub_date = pub_date.replace(tzinfo=timezone.utc)
                        fe.pubDate(pub_date)
                    except ValueError:
                        logger.warning(f"Could not parse date string: {time_text}. Using current time.")
                        fe.pubDate(datetime.now(timezone.utc))
                else:
                     fe.pubDate(datetime.now(timezone.utc))

                items_added += 1
                logger.info(f"Added item {items_added}: {item_title}")
            except Exception as e:
                logger.error(f"Failed to add item '{item_title}': {e}")

        logger.info(f"Successfully scraped and added {items_added} items to RSS.")
        return fg.rss_str(pretty=True).decode('utf-8')

    except Exception as e:
        logger.error(f"Error during scraping/generation for {url}: {e}", exc_info=True)
        from feedgen.feed import FeedGenerator
        error_fg = FeedGenerator()
        error_fg.id(url)
        error_fg.title("Processing Error")
        error_fg.description(f"An error occurred processing {url}: {str(e)}")
        # 修正：添加必需的 link 字段
        error_fg.link(href=url, rel='alternate')
        return error_fg.rss_str(pretty=True).decode('utf-8')

# --- Main Execution ---
import asyncio
target_url = '\${target_url}'
max_items = \${max_items}

logger.info(f"Starting scrape for URL: {target_url} with max_items: {max_items}")
result_str = await scrape_and_generate_rss(target_url, max_items)
logger.info("Scraping finished.")
# 将结果写入一个全局变量，供 JS 读取
document.rss_result = result_str # 使用显式导入的 document
\`;


                // --- 运行 Python 代码 ---
                await pyodide.runPythonAsync(pythonCode);
                
                // --- 获取结果并显示 ---
                // 使用显式导入的 document
                const rssResult = document.rss_result;
                if (rssResult) {
                    if (rssResult.startsWith("<?xml") || rssResult.includes("<rss")) {
                        // 如果结果看起来像 RSS XML
                        outputDiv.innerText = "RSS generation complete.";
                        // 创建下载链接
                        const blob = new Blob([rssResult], { type: 'application/rss+xml;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = 'feed.rss';
                        link.className = 'download-link';
                        link.textContent = 'Download RSS Feed';
                        outputDiv.appendChild(document.createElement('br'));
                        outputDiv.appendChild(link);
                        // 在 pre 标签中显示 XML 内容
                        const pre = document.createElement('pre');
                        pre.textContent = rssResult;
                        outputDiv.appendChild(pre);
                        
                    } else {
                        // 显示错误或非 XML 结果
                        outputDiv.innerText = rssResult;
                    }
                } else {
                     outputDiv.innerText = "No result returned from Python script.";
                }
                
            } catch (error) {
                console.error(error);
                document.getElementById('output').innerText = 'Error: ' + error.message + '\\n' + error.stack;
            }
        }

        main();
    </script>
</body>
</html>
`;

            // --- 3. 返回 HTML 响应 ---
            return new Response(html_response, {
                headers: { "Content-Type": "text/html;charset=UTF-8" },
            });
        },
    };
}
// <-- 文件在此处正确结束，没有多余的字符或括号
