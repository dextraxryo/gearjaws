/**
 * /api/scrape-fiveg.js  —  GearJaws v1.1 T-07
 * Five G Music Technology (fiveg.net) スクレイピング
 *
 * GET /api/scrape-fiveg?q=neve+1073&debug=1
 *
 * Five G は カラーミーショップ (GMO) ベースの EC サイト
 * 検索URL: https://fiveg.net/?mode=srh&sort=n&cid=&keyword=neve
 *
 * ColorMe デフォルトテンプレートのセレクター構造:
 *   商品リスト: ul#item_list, ul.item_list, #item_list_content
 *   商品1件: li.item_box, .item_box, li.clearfix
 *   タイトル: p.item_name a, .item_name a
 *   価格:     p.item_price, .item_price, .price
 *
 * 注意: robots.txt / ToS の範囲内で低頻度（Cron週1）での利用を想定
 */

const cheerio = require('cheerio');

const USD_RATE = 150;
const BASE_URL = 'https://fiveg.net';

function buildSearchUrl(query) {
  const q = encodeURIComponent(query);
  return `${BASE_URL}/?mode=srh&sort=n&cid=&keyword=${q}`;
}

function parseJpyPrice(str) {
  if (!str) return null;
  const num = parseInt((str || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(num) || num <= 0 ? null : num;
}

function mapCondition(str) {
  const s = (str || '').toLowerCase();
  if (s.includes('new') || s.includes('新品') || s.includes('未使用') || s.includes('未開封')) return '新品同様';
  if (s.includes('mint') || s.includes('美品') || s.includes('excellent') || s.includes('良品')) return '新品同様';
  if (s.includes('良好') || s.includes('good') || s.includes('良い')) return '良好';
  if (s.includes('junk') || s.includes('ジャンク') || s.includes('故障') || s.includes('難あり')) return 'ジャンク';
  return '普通';
}

// ── カラーミーショップ セレクター (複数テンプレート対応) ──────────────────
const ITEM_SELECTORS = [
  // ColorMe デフォルト / 標準テンプレート
  'li.item_box',
  '.item_box',
  // ColorMe 新デザインテンプレート
  '.product-list__unit',
  '.product-list-unit',
  'li.clearfix',
  // 汎用フォールバック
  '#item_list li',
  '#item_list_content li',
  'ul.item_list li',
  '.item_list li',
  '.item',
  'li.item',
  '[class*="item_box"]',
];

const TITLE_SELECTORS = [
  // ColorMe 標準
  'p.item_name a',
  '.item_name a',
  'span.item_name a',
  'div.item_name a',
  // ColorMe 新テンプレート
  '.product-list__name a',
  '.product-list-name a',
  // 汎用
  'h3 a', 'h2 a', '.name a',
  '.item_title a',
  'a.item_link',
];

const PRICE_SELECTORS = [
  // ColorMe 標準
  'p.item_price',
  '.item_price',
  'span.price',
  // ColorMe 新テンプレート
  '.product-list__price',
  '.product-price',
  // 汎用
  '.price',
  '[class*="price"]',
  'em.price',
];

const CONDITION_SELECTORS = [
  '.item_status', '.condition', '.grade', '.rank',
  '[class*="condition"]', '[class*="grade"]', '[class*="rank"]',
  '[class*="status"]',
];

async function parseFiveG(html, query, debug) {
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
    debugInfo.page_title     = $('title').text().trim().slice(0, 100);
    debugInfo.h1_texts       = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count     = itemSelector ? $(itemSelector).length : 0;
    debugInfo.result_count_text = $('#result_count, .result_count, .search_result_count').first().text().trim();
    debugInfo.html_snippet   = $.html().slice(0, 3000);
    debugInfo.all_classes    = [...new Set(
      $('[class]').map((_, el) => ($(el).attr('class') || '').split(/\s+/)[0]).get()
    )].filter(Boolean).slice(0, 40);
    if (itemSelector) {
      debugInfo.first_item_html = $.html($(itemSelector).first()).slice(0, 800);
    }
    return { results: [], debug: debugInfo };
  }

  if (!itemSelector) return { results: [], debug: debugInfo };

  const today = new Date().toISOString().slice(0, 10);

  $(itemSelector).each((_, el) => {
    // タイトル
    let title = null;
    let titleHref = '';
    for (const sel of TITLE_SELECTORS) {
      const el2 = $(el).find(sel).first();
      const t = el2.text().trim();
      if (t) { title = t; titleHref = el2.attr('href') || ''; break; }
    }
    if (!title) {
      const a = $(el).find('a').first();
      title = a.text().trim();
      titleHref = a.attr('href') || '';
    }
    if (!title) return;

    // 価格
    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); if (priceJPY) break; }
    }
    if (!priceJPY) return; // 価格不明はスキップ

    // URL
    let url = titleHref;
    if (!url) url = $(el).find(`a[href*="${BASE_URL}"]`).first().attr('href') || '';
    if (!url) url = $(el).find('a').first().attr('href') || '';
    if (url && !url.startsWith('http')) url = BASE_URL + url;

    // 状態 (ColorMe は状態フィールドを持たないことが多いので title から推測)
    let condition = '普通';
    for (const sel of CONDITION_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }
    if (condition === '普通') condition = mapCondition(title);

    results.push({
      platform: 'Five G',
      title,
      price:    null,
      currency: 'JPY',
      priceJPY,
      priceUSD: Math.round(priceJPY / USD_RATE),
      condition,
      status:   'listing',
      date:     today,
      url:      url || BASE_URL,
      source:   'fiveg_scrape',
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

  const url = buildSearchUrl(query);

  const fetchOpts = {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control':   'no-cache',
      'Referer':         BASE_URL + '/',
    },
    signal: AbortSignal.timeout(9000),
    redirect: 'follow',
  };

  try {
    const response = await fetch(url, fetchOpts);

    if (!response.ok) {
      return res.status(200).json({
        source:   'fiveg_scrape',
        error:    `HTTP ${response.status}`,
        url,
        listings: [],
      });
    }

    const html = await response.text();
    const { results, debug: debugInfo } = await parseFiveG(html, query, debug);

    return res.status(200).json({
      source:   'fiveg_scrape',
      url,
      total:    results.length,
      listings: results,
      ...(debug ? { debug: { ...debugInfo, html_length: html.length } } : {}),
    });

  } catch (err) {
    console.error('[scrape-fiveg] error:', err.message);
    return res.status(200).json({
      source: 'fiveg_scrape', error: err.message, url, listings: [],
    });
  }
};
