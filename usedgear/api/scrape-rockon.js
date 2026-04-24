/**
 * /api/scrape-rockon.js  —  GearJaws v1.1 T-07
 * Rock oN Company (store.miroc.co.jp) 中古機材スクレイピング
 *
 * GET /api/scrape-rockon?q=neve+1073&debug=1
 *
 * 変更履歴:
 *   v1.0 (Session E): rock-on.jp を対象（URLパターン不明で全失敗）
 *   v1.1 (T-07):      store.miroc.co.jp に移行済みのため URL 修正
 *
 * 注意: robots.txt / ToS の範囲内で低頻度（Cron週1）での利用を想定
 */

const cheerio = require('cheerio');

const USD_RATE = 150;
const BASE = 'https://store.miroc.co.jp';

/**
 * 検索 URL 生成
 * criteria.keyword: 検索キーワード
 * criteria.used=1: 中古のみ
 * criteria.limitCriteria.max=50: 最大50件
 */
function buildSearchUrl(query) {
  const q = encodeURIComponent(query);
  return [
    `${BASE}/p/search/search?criteria.keyword=${q}&criteria.used=1&criteria.limitCriteria.max=50`,
    `${BASE}/p/search/search?criteria.keyword=${q}&criteria.limitCriteria.max=50&criteria.used=1`,
    // フォールバック: used フィルタなしで全在庫から中古を探す
    `${BASE}/p/search/search?criteria.keyword=${q}+used&criteria.limitCriteria.max=50`,
  ];
}

function parseJpyPrice(str) {
  if (!str) return null;
  const num = parseInt((str || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(num) || num <= 0 ? null : num;
}

function mapCondition(str) {
  const s = (str || '').toLowerCase();
  if (s.includes('new') || s.includes('新品') || s.includes('未使用') || s.includes('未開封')) return '新品同様';
  if (s.includes('excellent') || s.includes('良好') || s.includes('美品') || s.includes('very good')) return '良好';
  if (s.includes('junk') || s.includes('ジャンク') || s.includes('故障') || s.includes('broken')) return 'ジャンク';
  return '普通';
}

// ── セレクター群 (miroc.co.jp / 汎用EC フォールバック付き) ──────────────
// store.miroc.co.jp は Spring Boot ベースのカスタム EC と推測
// 実際の DOM を確認次第 debug=1 で絞り込む
const ITEM_SELECTORS = [
  // miroc 固有 (推測)
  '.product-list-item',
  '.product-item',
  '.c-item',
  '.search-item',
  // 汎用
  'li.item',
  '.item',
  'article.product',
  '.goods-item',
  '.item-box',
  '[class*="product-list"] li',
  '[class*="product"][class*="item"]',
  'ul.products li',
];

const TITLE_SELECTORS = [
  '.product-name a', '.product-title a', '.item-name a',
  '.c-item__name a', '.name a', 'h2 a', 'h3 a', 'h4 a',
  '.item__name a', '.goods-name a', '.title a', 'a[class*="name"]',
];

const PRICE_SELECTORS = [
  '.price--sale', '.selling-price', '.item-price', '.product-price',
  '.c-item__price', '.price', '[class*="price"]',
  'span.num',
];

const CONDITION_SELECTORS = [
  '.condition', '.status', '.grade', '[class*="condition"]',
  '[class*="grade"]', '[class*="rank"]',
];

async function parseMiroc(html, query, debug) {
  const $ = cheerio.load(html);
  const results = [];
  const debugInfo = { selectors_tried: [] };

  let itemSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const count = $(sel).length;
    debugInfo.selectors_tried.push({ selector: sel, count });
    if (count > 0 && !itemSelector) itemSelector = sel;
  }

  if (debug) {
    debugInfo.page_title   = $('title').text().trim().slice(0, 100);
    debugInfo.h1_texts     = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count   = itemSelector ? $(itemSelector).length : 0;
    debugInfo.html_snippet = $.html().slice(0, 3000);
    debugInfo.all_classes  = [...new Set(
      $('[class]').map((_, el) => ($(el).attr('class') || '').split(/\s+/)[0]).get()
    )].filter(Boolean).slice(0, 40);
    return { results: [], debug: debugInfo };
  }

  if (!itemSelector) return { results: [], debug: debugInfo };

  const today = new Date().toISOString().slice(0, 10);

  $(itemSelector).each((_, el) => {
    let title = null;
    for (const sel of TITLE_SELECTORS) {
      const t = $(el).find(sel).first().text().trim();
      if (t) { title = t; break; }
    }
    if (!title) title = $(el).find('a').first().text().trim();
    if (!title) return;

    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); if (priceJPY) break; }
    }

    let url = '';
    for (const sel of TITLE_SELECTORS) {
      const href = $(el).find(sel).first().attr('href');
      if (href) { url = href; break; }
    }
    if (!url) url = $(el).find('a').first().attr('href') || '';
    if (url && !url.startsWith('http')) url = BASE + url;

    let condition = '普通';
    for (const sel of CONDITION_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }
    if (condition === '普通') condition = mapCondition(title);

    results.push({
      platform: 'Rock oN',
      title,
      price:    null,
      currency: 'JPY',
      priceJPY: priceJPY || 0,
      priceUSD: priceJPY ? Math.round(priceJPY / USD_RATE) : 0,
      condition,
      status:   'listing',
      date:     today,
      url:      url || BASE,
      source:   'rockon_scrape',
    });
  });

  return { results, debug: debugInfo };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const query = (req.query.q ?? '').trim();
  const debug = req.query.debug === '1';
  if (!query) return res.status(400).json({ error: 'q is required' });

  const fetchOpts = {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control':   'no-cache',
      'Referer':         'https://store.miroc.co.jp/',
    },
    signal: AbortSignal.timeout(9000),
    redirect: 'follow',
  };

  const urls = buildSearchUrl(query);
  const urlResults = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, fetchOpts);
      urlResults.push({ url, status: response.status });

      if (!response.ok) continue;

      const html = await response.text();

      // JSON API が返ってきた場合に対応
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        // JSON の場合は items 配列を直接パース
        const json = JSON.parse(html);
        const items = json.items || json.products || json.results || [];
        const listings = items.map(item => ({
          platform: 'Rock oN',
          title:    item.name || item.title || '',
          price:    null,
          currency: 'JPY',
          priceJPY: parseInt((item.price || '0').toString().replace(/[^0-9]/g, ''), 10) || 0,
          priceUSD: 0,
          condition: mapCondition(item.condition || item.grade || ''),
          status:   'listing',
          date:     new Date().toISOString().slice(0, 10),
          url:      item.url || item.link || BASE,
          source:   'rockon_scrape',
        })).filter(l => l.priceJPY > 0 || debug);
        listings.forEach(l => { if (l.priceJPY) l.priceUSD = Math.round(l.priceJPY / USD_RATE); });
        return res.status(200).json({ source: 'rockon_scrape', url, total: listings.length, listings });
      }

      const { results, debug: debugInfo } = await parseMiroc(html, query, debug);

      return res.status(200).json({
        source:   'rockon_scrape',
        url,
        total:    results.length,
        listings: results,
        ...(debug ? { debug: { ...debugInfo, urls_tried: urlResults, html_length: html.length } } : {}),
      });

    } catch (fetchErr) {
      urlResults.push({ url, error: fetchErr.message });
    }
  }

  return res.status(200).json({
    source:     'rockon_scrape',
    error:      'All URLs failed',
    urls_tried: urlResults,
    listings:   [],
  });
};
