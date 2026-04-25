/**
 * /api/scrape-rockon.js  —  GearJaws v1.2 T-07
 * Rock oN Company (store.miroc.co.jp) 中古機材スクレイピング
 *
 * GET /api/scrape-rockon?q=neve+1073&debug=1
 *
 * 変更履歴:
 *   v1.0 (Session E): rock-on.jp を対象（URLパターン不明で全失敗）
 *   v1.1 (T-07):      store.miroc.co.jp に修正（AJAX/SPA構造のためHTML取得ゼロ）
 *   v1.2 (T-07 fix):  JSON API エンドポイント探索 + debug 強化
 *
 * 技術課題メモ:
 *   store.miroc.co.jp はミロク情報サービス「Zeta」EC プラットフォーム。
 *   商品データは zeta-filter-min.js / ebisu.js 経由でクライアントサイド AJAX 取得。
 *   fetch+cheerio では HTML シェルしか取得できないため、JSON API エンドポイントを探索。
 *   API が見つからない場合は T-08 (Digimart) で Rock oN 在庫を代替取得可能
 *   （Rock oN は Digimart 出店: https://www.digimart.net/shop/4727/ ）
 */

const cheerio = require('cheerio');

const USD_RATE = 150;
const BASE = 'https://store.miroc.co.jp';

// ── JSON API エンドポイント候補（Zeta/Miroc プラットフォーム推測） ──────────
function buildApiUrls(query) {
  const q = encodeURIComponent(query);
  return [
    // パターン1: criteria.* 形式 + JSON Accept ヘッダー（既存URLにJSONヘッダーで試行）
    { url: `${BASE}/p/search/search?criteria.keyword=${q}&criteria.used=1&criteria.limitCriteria.max=50`, acceptJson: true },
    // パターン2: 拡張子 .json
    { url: `${BASE}/p/search/search.json?criteria.keyword=${q}&criteria.used=1&criteria.limitCriteria.max=50`, acceptJson: false },
    // パターン3: /api/ プレフィックス（Spring REST Controller 推測）
    { url: `${BASE}/api/search?keyword=${q}&used=1&limit=50`, acceptJson: false },
    { url: `${BASE}/api/products?keyword=${q}&used=1&limit=50`, acceptJson: false },
    // パターン4: ebisu 推薦 API
    { url: `${BASE}/p/ebisu/search?keyword=${q}&used=1`, acceptJson: false },
    // パターン5: 全 USED 在庫（キーワードなし・client-side filter用）
    { url: `${BASE}/p/search/search?criteria.used=1&criteria.limitCriteria.max=100`, acceptJson: true },
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

// ── HTML セレクター群 ──────────────────────────────────────────────────────
// Zeta/Miroc プラットフォーム向けに拡張（v1.2）
const ITEM_SELECTORS = [
  // Zeta EC 推測クラス
  '.zeta-item', '.zeta-product', '.zeta-list-item',
  '.ec-item', '.ec-product', '.ec-goods',
  '.product-list-item', '.product-item', '.goods-item',
  // 汎用クラス
  '.c-item', '.search-item',
  'li.item', '.item',
  'article.product', '.item-box',
  // 属性ベース（データ属性があれば）
  '[data-item-id]', '[data-product-id]', '[data-goods-id]',
  // 広いマッチ
  '[class*="product-list"] li',
  '[class*="product"][class*="item"]',
  '[class*="goods"][class*="item"]',
  'ul.products li',
];

const TITLE_SELECTORS = [
  '.product-name a', '.product-title a', '.item-name a',
  '.goods-name a', '.c-item__name a', '.zeta-item__name a',
  '.name a', 'h2 a', 'h3 a', 'h4 a',
  '.item__name a', '.title a', 'a[class*="name"]',
  '.item-title a', '.product__name a',
];

const PRICE_SELECTORS = [
  '.price--sale', '.selling-price', '.item-price', '.product-price',
  '.c-item__price', '.goods-price', '.zeta-item__price',
  '.price', 'span.price', '[class*="price"]', 'em.price',
  '.sale-price', '.now-price',
];

// ── HTML パーサー ──────────────────────────────────────────────────────────
function parseMirocHtml(html, query, debug) {
  const $ = cheerio.load(html);
  const results = [];
  const debugInfo = { selectors_tried: [] };

  // すべてのセレクターを試してマッチ数を記録
  let itemSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const count = $(sel).length;
    if (count > 0) debugInfo.selectors_tried.push({ selector: sel, count });
    if (count > 0 && !itemSelector) itemSelector = sel;
  }

  if (debug) {
    debugInfo.page_title   = $('title').text().trim().slice(0, 120);
    debugInfo.h1_texts     = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count   = itemSelector ? $(itemSelector).length : 0;
    debugInfo.all_classes  = [...new Set(
      $('[class]').map((_, el) => ($(el).attr('class') || '').split(/\s+/)[0]).get()
    )].filter(Boolean).slice(0, 50);

    // 見つかったすべてのセレクターの最初のアイテムの HTML を表示
    const first_items = {};
    for (const { selector } of debugInfo.selectors_tried) {
      const firstHtml = $.html($(selector).first());
      if (firstHtml) first_items[selector] = firstHtml.slice(0, 600);
    }
    debugInfo.first_items = first_items;

    // data-* 属性を持つ要素を探す（商品IDが data 属性に入ることが多い）
    debugInfo.data_attrs = [];
    $('[data-item-id],[data-product-id],[data-goods-id],[data-sku],[data-id]').each((i, el) => {
      if (i >= 5) return false;
      debugInfo.data_attrs.push({
        tag: el.name,
        class: $(el).attr('class'),
        data: Object.fromEntries(
          Object.entries(el.attribs).filter(([k]) => k.startsWith('data-'))
        ),
        text: $(el).text().trim().slice(0, 100),
      });
    });

    // <script> タグ内の JSON-LD や商品データを探す
    const scriptContents = [];
    $('script[type="application/json"], script[type="application/ld+json"]').each((i, el) => {
      if (i >= 3) return false;
      scriptContents.push($(el).html().slice(0, 500));
    });
    if (scriptContents.length) debugInfo.json_scripts = scriptContents;

    // Ajax で使われる可能性のある URL パターンを script から抽出
    const ajaxUrls = [];
    $('script').each((_, el) => {
      const src = $(el).html() || '';
      const matches = src.match(/["'](\/api\/[^"']+|\/p\/[^"']*(?:search|product|goods)[^"']*?)["']/g) || [];
      matches.slice(0, 5).forEach(m => ajaxUrls.push(m.replace(/["']/g, '')));
    });
    if (ajaxUrls.length) debugInfo.ajax_url_hints = ajaxUrls;

    return { results: [], debug: debugInfo };
  }

  if (!itemSelector) return { results: [], debug: debugInfo };

  const today = new Date().toISOString().slice(0, 10);
  const queryTokens = query.toLowerCase().match(/[a-z0-9\u3040-\u9fff]+/g) || [];

  $(itemSelector).each((_, el) => {
    let title = null, titleHref = '';
    for (const sel of TITLE_SELECTORS) {
      const a = $(el).find(sel).first();
      const t = a.text().trim();
      if (t) { title = t; titleHref = a.attr('href') || ''; break; }
    }
    // フォールバック: 最初の a タグ
    if (!title) {
      const a = $(el).find('a').first();
      title = a.text().trim();
      titleHref = a.attr('href') || '';
    }
    if (!title || title.length < 3) return;

    // キーワード関連性チェック（クライアントサイドフィルター）
    const titleLow = title.toLowerCase();
    const relevant = queryTokens.length === 0 ||
      queryTokens.filter(t => titleLow.includes(t)).length / queryTokens.length >= 0.5;
    if (!relevant) return;

    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); if (priceJPY) break; }
    }

    let url = titleHref;
    if (!url) url = $(el).find('a').first().attr('href') || '';
    if (url && !url.startsWith('http')) url = BASE + url;

    let condition = mapCondition(title);
    for (const sel of ['.condition', '.grade', '[class*="condition"]', '[class*="grade"]', '[class*="rank"]']) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }

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

// ── JSON レスポンス処理 ────────────────────────────────────────────────────
function parseJsonResponse(json, today) {
  const candidates = [
    json.items, json.products, json.goods, json.results,
    json.data?.items, json.data?.products, json.content,
    json.searchResult?.items, json.searchResult?.products,
  ].filter(Array.isArray);

  if (!candidates.length) return null;
  const items = candidates[0];

  return items.map(item => {
    const priceJPY = parseJpyPrice(String(
      item.price ?? item.sellPrice ?? item.salePrice ?? item.taxInPrice ?? 0
    ));
    return {
      platform: 'Rock oN',
      title:    (item.name ?? item.title ?? item.itemName ?? '').trim(),
      price:    null,
      currency: 'JPY',
      priceJPY: priceJPY || 0,
      priceUSD: priceJPY ? Math.round(priceJPY / USD_RATE) : 0,
      condition: mapCondition(item.condition ?? item.grade ?? item.status ?? ''),
      status:   'listing',
      date:     today,
      url:      (item.url ?? item.link ?? item.detailUrl ?? '').startsWith('http')
        ? (item.url ?? item.link ?? item.detailUrl)
        : BASE + (item.url ?? item.link ?? item.detailUrl ?? ''),
      source:   'rockon_scrape',
    };
  }).filter(l => l.title);
}

// ── メインハンドラ ─────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const query = (req.query.q ?? '').trim();
  const debug = req.query.debug === '1';
  if (!query) return res.status(400).json({ error: 'q is required' });

  const today = new Date().toISOString().slice(0, 10);
  const urlConfigs = buildApiUrls(query);
  const urlResults = [];

  for (const { url, acceptJson } of urlConfigs) {
    const headers = {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          acceptJson
        ? 'application/json, text/html, */*; q=0.9'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Cache-Control':   'no-cache',
      'Referer':         `${BASE}/`,
      ...(acceptJson ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    };

    try {
      const response = await fetch(url, {
        headers,
        signal:   AbortSignal.timeout(9000),
        redirect: 'follow',
      });

      const status = response.status;
      const ct = response.headers.get('content-type') || '';
      urlResults.push({ url, status, content_type: ct.slice(0, 60) });

      if (!response.ok) continue;

      const body = await response.text();

      // ── JSON レスポンス ──
      if (ct.includes('application/json') || body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
        try {
          const json = JSON.parse(body);
          const listings = parseJsonResponse(json, today);
          if (listings !== null) {
            return res.status(200).json({
              source:   'rockon_scrape',
              url,
              method:   'json_api',
              total:    listings.length,
              listings,
              ...(debug ? { debug: { urls_tried: urlResults, json_keys: Object.keys(json) } } : {}),
            });
          }
        } catch (_) { /* JSONパース失敗 → HTML として処理 */ }
      }

      // ── HTML レスポンス ──
      const { results, debug: debugInfo } = parseMirocHtml(body, query, debug);

      if (debug) {
        return res.status(200).json({
          source:     'rockon_scrape',
          url,
          method:     'html_parse',
          total:      results.length,
          listings:   results,
          debug: {
            ...debugInfo,
            urls_tried:  urlResults,
            html_length: body.length,
            note: results.length === 0
              ? 'items found but no products parsed — likely SPA/AJAX. Check first_items and ajax_url_hints for correct API endpoint'
              : 'ok',
          },
        });
      }

      if (results.length > 0) {
        return res.status(200).json({
          source: 'rockon_scrape', url, total: results.length, listings: results,
        });
      }
      // 結果ゼロ → 次の URL を試す

    } catch (fetchErr) {
      urlResults.push({ url, error: fetchErr.message });
    }
  }

  // 全 URL 失敗 / 結果ゼロ
  return res.status(200).json({
    source:     'rockon_scrape',
    error:      'No products found — site uses client-side rendering. See T-08 (Digimart) for Rock oN inventory via https://www.digimart.net/shop/4727/',
    urls_tried: urlResults,
    listings:   [],
  });
};
