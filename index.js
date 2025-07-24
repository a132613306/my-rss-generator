// index.js
import { Feed } from 'feed';
import * as cheerio from 'cheerio';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetSiteUrl = url.searchParams.get('url');
    const maxItemsStr = url.searchParams.get('max_items');
    const maxItems = maxItemsStr ? parseInt(maxItemsStr, 10) : 20;

    if (!targetSiteUrl) {
      return new Response(
        "Error: Missing required 'url' parameter. Usage: ?url=https://example.com",
        { status: 400, headers: { 'Content-Type': 'text/plain' } }
      );
    }

    try {
      console.log(`Fetching URL: ${targetSiteUrl}`);
      const response = await fetch(targetSiteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }

      const htmlContent = await response.text();
      console.log(`Fetched ${htmlContent.length} characters of HTML.`);
      const $ = cheerio.load(htmlContent);

      const siteTitle = $('title').first().text() || `RSS for ${new URL(targetSiteUrl).hostname}`;
      const siteDescription = `Generated RSS feed for ${targetSiteUrl}`;

      const feed = new Feed({
        title: siteTitle,
        description: siteDescription,
        id: targetSiteUrl,
        link: targetSiteUrl,
        language: 'zh-CN',
        generator: 'Cloudflare Worker RSS Generator',
      });

      const rows = $('tr.default');
      console.log(`Found ${rows.length} potential items.`);

      let itemsAdded = 0;
      rows.each((i, row) => {
        if (itemsAdded >= maxItems) {
          return false;
        }

        const $row = $(row);
        const $magnetLink = $row.find('a[href^="magnet:?xt=urn:btih:"]').first();
        const magnetHref = $magnetLink.attr('href');
        if (!magnetHref) {
          console.debug(`Skipping row ${i}: No magnet link found.`);
          return;
        }

        let itemTitle = '';
        let titleLinkHref = '';
        const $titleTd = $row.find('td').eq(1);
        if ($titleTd.length > 0) {
            const $titleLink = $titleTd.find('a').first();
            if ($titleLink.length > 0) {
                itemTitle = $titleLink.text().trim();
                titleLinkHref = $titleLink.attr('href');
                if (titleLinkHref && !titleLinkHref.startsWith('http')) {
                    try {
                        titleLinkHref = new URL(titleLinkHref, targetSiteUrl).href;
                    } catch (e) {
                        console.warn(`Could not resolve relative URL: ${titleLinkHref}`);
                    }
                }
            } else {
                itemTitle = $titleTd.text().trim();
            }
        }

        if (!itemTitle) {
            console.debug(`Skipping row ${i}: No title found.`);
            return;
        }

        let pubDateString = '';
        const $timeTds = $row.find('td.text-center');
        if ($timeTds.length >= 4) {
            pubDateString = $timeTds.eq(3).text().trim();
        } else if ($timeTds.length >= 3) {
            pubDateString = $timeTds.eq(2).text().trim();
        }

        console.debug(`Found item ${itemsAdded + 1}: Title='${itemTitle}', Magnet='${magnetHref}', Time='${pubDateString}', Link='${titleLinkHref}'`);

        const itemOptions = {
          title: itemTitle,
          id: magnetHref,
          link: magnetHref,
          description: pubDateString ? `<b>Time:</b> ${pubDateString}` : 'No date available',
        };

        if (pubDateString) {
            const pubDate = new Date(pubDateString.replace(' ', 'T') + 'Z');
            if (!isNaN(pubDate.getTime())) {
                itemOptions.date = pubDate;
            } else {
                console.warn(`Could not parse date string: ${pubDateString}`);
            }
        }

        feed.addItem(itemOptions);
        itemsAdded++;
      });

      console.log(`Successfully added ${itemsAdded} items to RSS feed.`);
      const rssXml = feed.rss2();

      return new Response(rssXml, {
        status: 200,
        headers: {
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });

    } catch (error) {
      console.error('Error processing request:', error);
      const errorFeed = new Feed({
        title: 'Processing Error',
        description: `An error occurred processing ${targetSiteUrl}`,
        id: 'error',
        link: targetSiteUrl,
      });
      errorFeed.addItem({
        title: 'Error',
        description: error.message,
        link: targetSiteUrl,
        date: new Date(),
      });

      return new Response(errorFeed.rss2(), {
        status: 500,
        headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
      });
    }
  },
};
