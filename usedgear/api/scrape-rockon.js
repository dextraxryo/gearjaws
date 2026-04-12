/**
 * /api/scrape-rockon.js  —  GearJaws v1.0 Session E
 * Rock oN Company 中古機材ページのスクレイピング
 *
 * GET /api/scrape-rockon?q=neve+1073&debug=1
 *
 * 注意: robots.txt / ToS の範囲内で、低頻度（Cron週1）での利用を想定
 */

const cheerio = require('cheerio');
const USD_RATE = 150;

// Rock oN Company の中古品検索 URL候補（複数試す）
function buildRockOnUrls(query) {
  const q = encodeURIComponent(query);
  return [
    `https://www.rock-on.jp/ec/products?keyword=${q}&stock_status=used`,
    `https://www.rock-on.jp/products?keyword=${q}&is_used=1`,
    `https://www.rock-on.jp/shop/goods/search.aspx?keyword=${q}&used=1`,
    `https://www.rock-on.jp/search?q=${q}&type=used`,
  ];
}

// 価格文字列（「¥198,000」「198,000円」等）→ 数値
function parseJpyPrice(str) {
  if (!str) return null;
  const num = parseInt(str.replace(/[^0-9]/g, ''), 10);
  return isNaN(num) ? null : num;
}

// cheerio で Rock oN ページをパース
async function parseRockOn(html, cheerio, query, debug) {
  const $ = cheerio.load(html);
  const results = [];
  const debugInfo = { selectors_tried: [] };

  // ── セレクター候補（実際のHTMLを見て調整が必要な場合あり） ──
  const ITEM_SELECTORS = [
    '.product-item',
    '.product_item',
    '.goods-item',
    'li.item',
    '.c-item',
    '[class*="product"][class*="item"]',
  ];
  const TITLE_SELECTORS  = ['.product-name a', '.item-name a', '.name a', 'h2 a', 'h3 a', '.title a'];
  const PRICE_SELECTORS  = ['.price', '.item-price', '.selling-price', '[class*="price"]'];
  const STATUS_SELECTORS = ['.condition', '.stock', '.status', '[class*="condition"]', '[class*="used"]'];

  // どのセレクターが実際に機能するか試す
  let itemSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const count = $(sel).length;
    debugInfo.selectors_tried.push({ selector: sel, count });
    if (count > 0 && !itemSelector) itemSelector = sel;
  }

  if (debug) {
    // デバッグモード: ページのHTML構造を返す
    debugInfo.page_title     = $('title').text();
    debugInfo.h1_texts       = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.html_snippet   = html.slice(0, 2000);
    debugInfo.item_count     = itemSelector ? $(itemSelector).length : 0;
    debugInfo.all_classes    = [...new Set(
      $('[class]').map((_, el) => $(el).attr('class')?.split(' ')[0]).get()
    )].filter(Boolean).slice(0, 30);
    return { results: [], debug: debugInfo };
  }

  if (!itemSelector) return { results: [], debug: debugInfo };

  $(itemSelector).each((_, el) => {
    let title = null;
    for (const sel of TITLE_SELECTORS) {
      const t = $(el).find(sel).first().text().trim();
      if (t) { title = t; break; }
    }
    if (!title) title = $(el).find('a').first().text().trim();
    if (!title) return;

    // クエリと関係ない商品は除外
    if (!title.toLowerCase().includes(query.toLowerCase().split(' ')[0])) return;

    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); break; }
    }

    let url = $(el).find('a').first().attr('href') || '';
    if (url && !url.startsWith('http')) url = 'https://www.rock-on.jp' + url;

    let condition = '普通';
    for (const sel of STATUS_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }

    results.push({
      platform:  'Rock oN',
      title,
      price:     null,
      currency:  'JPY',
      priceJPY:  priceJPY || 0,
      priceUSD:  priceJPY ? Math.round(priceJPY / USD_RATE) : 0,
      condition,
      status:    'listing',
      date:      new Date().toISOString().slice(0, 10),
      url:       url || 'https://www.rock-on.jp',
      source:    'rockon_scrape',
    });
  });

  return { results, debug: debugInfo };
}

function mapCondition(str) {
  const s = str.toLowerCase();
  if (s.includes('new') || s.includes('新品') || s.includes('未使用')) return '新品同様';
  if (s.includes('excellent') || s.includes('良好') || s.includes('美品')) return '良好';
  if (s.includes('junk') || s.includes('ジャンク') || s.includes('故障')) return 'ジャンク';
  return '普通';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const query = (req.query.q ?? '').trim();
  const debug = req.query.debug === '1';
  if (!query) return res.status(400).json({ error: 'q is required' });

  try {
    const urls = buildRockOnUrls(query);
    const urlResults = [];

    // 複数 URL を順番に試す
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ja,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(7000),
          redirect: 'follow',
        });

        urlResults.push({ url, status: response.status });

        if (!response.ok) continue;

        const html = await response.text();
        const { results, debug: debugInfo } = await parseRockOn(html, cheerio, query, debug);

        return res.status(200).json({
          source:   'rockon_scrape',
          url,
          total:    results.length,
          listings: results,
          ...(debug ? { debug: { ...debugInfo, urls_tried: urlResults } } : {}),
        });

      } catch (fetchErr) {
        urlResults.push({ url, error: fetchErr.message });
      }
    }

    // 全 URL 失敗
    return res.status(200).json({
      source: 'rockon_scrape',
      error: 'All URLs failed',
      urls_tried: urlResults,
      listings: [],
    });

  } catch (err) {
    console.error('[scrape-rockon] error:', err.message);
    return res.status(200).json({
      source: 'rockon_scrape', error: err.message, listings: [],
    });
  }
};
