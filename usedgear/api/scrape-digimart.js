/**
 * /api/scrape-digimart.js  —  GearJaws v1.0 T-08
 * Digimart (digimart.net) 中古機材スクレイピング
 *
 * GET /api/scrape-digimart?q=neve+1073
 * GET /api/scrape-digimart?q=neve+1073&debug=1
 * GET /api/scrape-digimart?q=neve+1073&shopId=4727   ← Rock oN 絞り込み
 *
 * 技術メモ:
 *   - digimart.net はサーバーサイドレンダリング (SSR) — fetch+cheerio で取得可能
 *   - 文字コード: UTF-8
 *   - 検索URL: https://www.digimart.net/search?keyword=neve&shopId=XXXX
 *   - 商品URL形式: https://www.digimart.net/cat/<category>/DI<id>.html
 *   - コンディションランク: S/A/B/C/D (S=最高)
 *   - Rock oN Company は shopId=4727 で出店
 *
 * 変更履歴:
 *   v1.0 (T-08): 新規作成 — Rock oN の SPA 問題の代替として Digimart を採用
 */

const cheerio = require('cheerio');

const USD_RATE = 150;
const BASE_URL = 'https://www.digimart.net';

/** 検索URL構築 */
function buildSearchUrl(query, shopId) {
  const params = new URLSearchParams({ keyword: query });
  if (shopId) params.set('shopId', String(shopId));
  return `${BASE_URL}/search?${params}`;
}

/** JPY 価格パース — 最初の価格のみ取得 */
function parseJpyPrice(str) {
  if (!str) return null;
  const match = str.match(/[¥￥]?\s*([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d+)/);
  if (match) {
    const num = parseInt(match[1].replace(/,/g, ''), 10);
    return (isNaN(num) || num < 1000 || num > 100_000_000) ? null : num;
  }
  return null;
}

/**
 * Digimart コンディションランク → 内部スキーマ
 *   S: 未使用/新品同様
 *   A: 非常に良好
 *   B: 良好
 *   C: 普通
 *   D: やや難あり / ジャンク扱い
 */
function mapCondition(str) {
  const s = (str || '').trim().toUpperCase();
  if (s === 'S' || s.includes('未使用') || s.includes('新品'))     return '新品同様';
  if (s === 'A' || s.includes('非常に良好') || s.includes('美品')) return '新品同様';
  if (s === 'B' || s.includes('良好') || s.includes('excellent'))  return '良好';
  if (s === 'C' || s.includes('普通') || s.includes('good'))       return '普通';
  if (s === 'D' || s.includes('ジャンク') || s.includes('難あり')) return 'ジャンク';
  // フォールバック: テキストに英語コンディションが入る場合
  const low = s.toLowerCase();
  if (low.includes('mint') || low.includes('near mint'))            return '新品同様';
  if (low.includes('very good'))                                    return '良好';
  if (low.includes('junk') || low.includes('parts'))                return 'ジャンク';
  return '普通';
}

/** 相対 URL → 絶対 URL */
function toAbsoluteUrl(href) {
  if (!href) return BASE_URL;
  if (href.startsWith('http')) return href;
  return `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
}

// ── セレクター群 (Digimart の DOM 構造に合わせたフォールバック付き) ────────

/**
 * 商品アイテムセレクター
 * Digimart は Next.js / SSR ハイブリッド構成と推定。
 * 実際の DOM は debug=1 で確認後に絞り込む。
 */
const ITEM_SELECTORS = [
  // Digimart 現行 (推定・実機確認前)
  '.instrument_list li',
  '.instrumentList__item',
  'li.instrument-item',
  'li.js-instrument-item',
  '.search-result-list li',
  '.search-result-item',
  '.c-itemCard',
  '.itemCard',
  // 旧テンプレート系
  '.item_list li',
  'li.item_box',
  '.item-box',
  // 汎用フォールバック
  '[data-instrument-id]',
  '[data-item-id]',
  'ul.products li',
  'article.product',
];

const TITLE_SELECTORS = [
  '.instrument_name a',
  '.instrumentItem__name a',
  '.instrument-item__name a',
  '.c-itemCard__name a',
  '.itemCard__name a',
  '.item_name a',
  '.name a',
  'h3 a', 'h2 a',
  'a[class*="name"]',
  // タイトル要素自体がリンクの場合
  'a.instrument_name',
  'a.item_name',
];

const PRICE_SELECTORS = [
  // 税込価格を優先
  '.instrument_price .price',
  '.instrumentItem__price',
  '.instrument-item__price',
  '.c-itemCard__price',
  '.itemCard__price',
  '.item_price',
  '[class*="price--tax"]',
  '[class*="taxIn"]',
  'em.price', 'span.price', '.price',
  '[class*="price"]',
];

const CONDITION_SELECTORS = [
  // Digimart コンディションランク (S/A/B/C/D)
  '.instrument_rank',
  '.instrumentItem__rank',
  '.instrument-item__rank',
  '.c-itemCard__rank',
  '.itemCard__rank',
  '.rank', '.condition', '.grade',
  '[class*="rank"]',
  '[class*="condition"]',
  '[class*="grade"]',
];

// ── HTML パーサー ────────────────────────────────────────────────────────────
function parseDigimart(html, query, shopId, debug) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const results = [];
  const debugInfo = { selectors_tried: [] };

  // アイテムセレクターの候補を総当たり
  let itemSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const count = $(sel).length;
    if (count > 0) {
      debugInfo.selectors_tried.push({ selector: sel, count });
      if (!itemSelector) itemSelector = sel;
    }
  }

  if (debug) {
    debugInfo.page_title  = $('title').text().trim().slice(0, 120);
    debugInfo.h1_texts    = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count  = itemSelector ? $(itemSelector).length : 0;
    debugInfo.all_classes = [...new Set(
      $('[class]').map((_, el) => ($(el).attr('class') || '').split(/\s+/)[0]).get()
    )].filter(Boolean).slice(0, 60);

    if (itemSelector) {
      debugInfo.first_item_html = $.html($(itemSelector).first()).slice(0, 1500);
      const firstItem = $(itemSelector).first();
      // タイトル・価格・ランクのサンプル抽出
      let sampleTitle = '';
      for (const sel of TITLE_SELECTORS) {
        const t = firstItem.find(sel).first().text().trim();
        if (t) { sampleTitle = t; break; }
      }
      let samplePrice = '';
      for (const sel of PRICE_SELECTORS) {
        const p = firstItem.find(sel).first().text().trim();
        if (p) { samplePrice = p; break; }
      }
      let sampleRank = '';
      for (const sel of CONDITION_SELECTORS) {
        const r = firstItem.find(sel).first().text().trim();
        if (r) { sampleRank = r; break; }
      }
      debugInfo.sample_title = sampleTitle;
      debugInfo.sample_price = samplePrice;
      debugInfo.sample_rank  = sampleRank;
    }

    // <script> 内 JSON-LD / __NEXT_DATA__ を確認 (SSR データ埋め込みを探す)
    const scriptContents = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      if (i >= 3) return false;
      scriptContents.push($(el).html()?.slice(0, 600) ?? '');
    });
    // __NEXT_DATA__ は Next.js のサーバーサイドデータ
    $('script#__NEXT_DATA__').each((_, el) => {
      scriptContents.push(('[__NEXT_DATA__] ' + ($(el).html()?.slice(0, 800) ?? '')));
    });
    if (scriptContents.length) debugInfo.json_scripts = scriptContents;

    // data-* 属性チェック
    debugInfo.data_attrs = [];
    $('[data-instrument-id],[data-item-id],[data-product-id],[data-sku]').each((i, el) => {
      if (i >= 5) return false;
      debugInfo.data_attrs.push({
        tag:  el.name,
        cls:  $(el).attr('class'),
        data: Object.fromEntries(
          Object.entries(el.attribs).filter(([k]) => k.startsWith('data-'))
        ),
        text: $(el).text().trim().slice(0, 100),
      });
    });

    return { results: [], debug: debugInfo };
  }

  // ── 商品なし ────────────────────────────────────────────────────────────
  if (!itemSelector) return { results: [], debug: debugInfo };

  const today = new Date().toISOString().slice(0, 10);

  $(itemSelector).each((_, el) => {
    // ── タイトル + URL ─────────────────────────────────────────────────────
    let title = null, titleHref = '';
    for (const sel of TITLE_SELECTORS) {
      const node = $(el).find(sel).first();
      if (!node.length) continue;
      const t = node.text().trim();
      if (t) { title = t; titleHref = node.attr('href') || ''; break; }
    }
    // フォールバック: テキストを持つ最初の <a>
    if (!title) {
      $(el).find('a').each((_, a) => {
        const t = $(a).text().trim();
        if (t && t.length > 3) {
          title = t; titleHref = $(a).attr('href') || ''; return false;
        }
      });
    }
    if (!title || title.length < 3) return;

    // ── 価格 ────────────────────────────────────────────────────────────────
    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); if (priceJPY) break; }
    }
    if (!priceJPY) return; // 価格不明はスキップ

    // ── URL ─────────────────────────────────────────────────────────────────
    const url = toAbsoluteUrl(titleHref || $(el).find('a').first().attr('href') || '');

    // ── コンディション ───────────────────────────────────────────────────────
    let condition = mapCondition('');
    for (const sel of CONDITION_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }
    // タイトルからもランク推定（例: "[Aランク]" 等の表記）
    if (condition === '普通') {
      const rankMatch = title.match(/[[\[【]([SABCD])[ランク\]】]?/i);
      if (rankMatch) condition = mapCondition(rankMatch[1]);
    }

    // ── ショップ名 ───────────────────────────────────────────────────────────
    const shopName = $(el).find('.shop_name, .shopName, .seller, [class*="shop"]').first().text().trim();

    results.push({
      platform: 'Digimart',
      title,
      price:     null,
      currency:  'JPY',
      priceJPY,
      priceUSD:  Math.round(priceJPY / USD_RATE),
      condition,
      status:    'listing',
      date:      today,
      url,
      source:    'digimart_scrape',
      ...(shopName ? { shop: shopName } : {}),
    });
  });

  return { results, debug: debugInfo };
}

// ── メインハンドラ ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const query  = (req.query.q      ?? '').trim();
  const shopId = (req.query.shopId ?? '').trim();
  const debug  = req.query.debug === '1';
  if (!query) return res.status(400).json({ error: 'q is required' });

  const url = buildSearchUrl(query, shopId || null);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control':   'no-cache',
        'Referer':         `${BASE_URL}/`,
      },
      signal:   AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(200).json({
        source: 'digimart_scrape', error: `HTTP ${response.status}`, url, listings: [],
      });
    }

    const html = await response.text();
    const { results, debug: debugInfo } = parseDigimart(html, query, shopId, debug);

    return res.status(200).json({
      source:   'digimart_scrape',
      url,
      total:    results.length,
      listings: results,
      ...(debug ? { debug: { ...debugInfo, html_length: html.length } } : {}),
    });

  } catch (err) {
    console.error('[scrape-digimart] error:', err.message);
    return res.status(200).json({
      source: 'digimart_scrape', error: err.message, url, listings: [],
    });
  }
};
