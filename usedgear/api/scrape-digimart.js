/**
 * /api/scrape-digimart.js  —  GearJaws v1.2 T-08
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
 *   - 商品URL形式: /cat{N}/shop{N}/{ID}/ (相対パス → 絶対URL変換必須)
 *   - 商品ID形式: DS######## / DI######## (DS=新品/ショップ, DI=中古)
 *   - コンディションランク: S/A/B/C/D (S=最高) — .state クラスに格納
 *   - Rock oN Company は shopId=4727 で出店
 *
 * 確認済み DOM 構造 (v1.1 debug 実機):
 *   <div class="itemSearchBox">
 *     <ul class="itemDateInfo">
 *       <li>商品ID：DS10453401</li>
 *       <li>登録：2026/04/24</li>
 *     </ul>
 *     <p class="ttl"><a href="/cat18/shop5396/DS10453401/">商品名</a></p>
 *     <p>説明テキスト</p>
 *     <p class="itemShopInfo"><a href="/search?shopNo=5396">ショップ名</a></p>
 *     <!-- 価格・コンディションは itemSearchBoxLeft に存在すると推定 -->
 *     <!-- .fixedPrice, .state クラスが all_classes に確認済み -->
 *   </div>
 *
 * 変更履歴:
 *   v1.0 (T-08): 新規作成 — Rock oN の SPA 問題の代替として Digimart を採用
 *   v1.1 (T-08): debug 強化 — itemSearchBox 20件確認、DOM 構造判明
 *   v1.2 (T-08): 本実装 — 確認済みセレクター適用、価格なし商品も URL 付きで返す
 */

const cheerio = require('cheerio');

const USD_RATE = 150;
const BASE_URL = 'https://www.digimart.net';

/** 検索URL構築
 *  instrumentType=2 で中古品のみ絞り込み (v1.3 追加・実機確認済み要検証)
 *  商品ID プレフィックス: DS=新品ショップ在庫, DI=中古品
 */
function buildSearchUrl(query, shopId) {
  const params = new URLSearchParams({
    keyword: query,
    instrumentType: '2',   // 2=中古品のみ (1=新品) — 未確認のためフォールバックあり
  });
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
  if (s === 'B' || s.includes('良好') || s.includes('良い'))       return '良好';
  if (s === 'C' || s.includes('普通'))                             return '普通';
  if (s === 'D' || s.includes('ジャンク') || s.includes('難あり')) return 'ジャンク';
  const low = s.toLowerCase();
  if (low.includes('mint') || low.includes('near mint'))           return '新品同様';
  if (low.includes('very good'))                                   return '良好';
  if (low.includes('junk') || low.includes('parts'))               return 'ジャンク';
  return '普通';
}

/** 相対 URL → 絶対 URL */
function toAbsoluteUrl(href) {
  if (!href) return BASE_URL;
  if (href.startsWith('http')) return href;
  return `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** ul.itemDateInfo の2番目 li から日付を抽出
 *  "登録：2026/04/24" → "2026-04-24"
 */
function extractDate($el) {
  const text = $el.find('ul.itemDateInfo li').eq(1).text().trim();
  const m = text.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
}

// ── セレクター群 (v1.2 — 実機確認済み) ──────────────────────────────────────

// ✅ 実機確認: .itemSearchBox が 20件マッチ
const ITEM_SELECTOR = '.itemSearchBox';

// ✅ 実機確認: p.ttl a がタイトル + リンク要素
const TITLE_SELECTORS = [
  'p.ttl a',       // ✅ 確認済み
  '.ttl a',
  'h3 a', 'h2 a',
];

// 価格: .fixedPrice が all_classes に存在 — 実機確認待ち
// 価格なしアイテムも priceJPY:0 で返す（URL は有効）
const PRICE_SELECTORS = [
  '.fixedPrice',           // ✅ all_classes に確認済み (値は実機確認待ち)
  '.price',
  'em.price',
  '[class*="price"]:not(option)',
  '.shopsaleLinkWide',     // 価格リンクに金額が含まれる可能性
];

// コンディション: .state が all_classes に存在
const CONDITION_SELECTORS = [
  '.itemState .state',     // ✅ all_classes に state / itemState 確認済み
  '.state',
  '.itemState',
  '[class*="rank"]',
  '[class*="condition"]',
];

// ── HTML パーサー ────────────────────────────────────────────────────────────
function parseDigimart(html, query, shopId, debug) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const results = [];
  const debugInfo = {};

  const itemCount = $(ITEM_SELECTOR).length;

  if (debug) {
    debugInfo.page_title  = $('title').text().trim().slice(0, 120);
    debugInfo.h1_texts    = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count  = itemCount;
    debugInfo.item_selector = ITEM_SELECTOR;

    // 商品ID プレフィックス集計 (DS=新品, DI=中古)
    let dsCount = 0, diCount = 0, otherCount = 0;
    $(ITEM_SELECTOR).each((_, el) => {
      const t = $(el).find('ul.itemDateInfo li').first().text().replace('商品ID：','').trim();
      if (t.startsWith('DS')) dsCount++;
      else if (t.startsWith('DI')) diCount++;
      else otherCount++;
    });
    debugInfo.item_id_stats = { DS_新品: dsCount, DI_中古: diCount, other: otherCount };

    // 最初の3件の HTML を表示（価格・コンディション要素の位置を確認）
    const sampleItems = [];
    $(ITEM_SELECTOR).each((i, el) => {
      if (i >= 3) return false;
      sampleItems.push($.html(el).slice(0, 2500));
    });
    debugInfo.sample_items_html = sampleItems;

    // 価格セレクター候補を全アイテムで試す
    const priceStats = {};
    for (const sel of PRICE_SELECTORS) {
      let found = 0;
      let sample = '';
      $(ITEM_SELECTOR).each((_, el) => {
        const t = $(el).find(sel).first().text().trim();
        if (t) { found++; if (!sample) sample = t.slice(0, 40); }
      });
      if (found > 0) priceStats[sel] = { found, sample };
    }
    debugInfo.price_selector_stats = priceStats;

    // コンディションセレクター候補
    const condStats = {};
    for (const sel of CONDITION_SELECTORS) {
      let found = 0;
      let sample = '';
      $(ITEM_SELECTOR).each((_, el) => {
        const t = $(el).find(sel).first().text().trim();
        if (t) { found++; if (!sample) sample = t.slice(0, 20); }
      });
      if (found > 0) condStats[sel] = { found, sample };
    }
    debugInfo.condition_selector_stats = condStats;

    return { results: [], debug: debugInfo };
  }

  if (!itemCount) return { results: [], debug: debugInfo };

  $(ITEM_SELECTOR).each((_, el) => {
    // ── 商品ID チェック — DS=新品, DI=中古 ──────────────────────────────────
    // instrumentType=2 が効かない場合のフォールバックフィルタ
    const itemIdText = $(el).find('ul.itemDateInfo li').first().text().trim();
    const itemId = itemIdText.replace('商品ID：', '').trim();
    if (itemId.startsWith('DS')) return; // 新品ショップ在庫はスキップ

    // ── タイトル + URL ─────────────────────────────────────────────────────
    let title = null, titleHref = '';
    for (const sel of TITLE_SELECTORS) {
      const node = $(el).find(sel).first();
      const t = node.text().replace(/\u00a0/g, ' ').trim(); // &nbsp; → space
      if (t) { title = t; titleHref = node.attr('href') || ''; break; }
    }
    if (!title || title.length < 3) return;

    // ── URL ─────────────────────────────────────────────────────────────────
    const url = toAbsoluteUrl(titleHref);

    // ── 日付 ────────────────────────────────────────────────────────────────
    const date = extractDate($(el));

    // ── 価格 ────────────────────────────────────────────────────────────────
    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); if (priceJPY) break; }
    }
    // 価格が取れなくても URL 付きでリストに含める（Digimart ページで確認可能）

    // ── コンディション ───────────────────────────────────────────────────────
    let condition = mapCondition('');
    for (const sel of CONDITION_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }
    // タイトルから [Aランク] / 【B】 形式のランク推定
    if (condition === '普通') {
      const rankMatch = title.match(/[[\[【]([SABCD])[ランク\]】]?/i);
      if (rankMatch) condition = mapCondition(rankMatch[1]);
    }

    // ── ショップ名 ───────────────────────────────────────────────────────────
    const shopName = $(el).find('p.itemShopInfo a').first()
      .text().replace(/\u00a0/g, ' ').trim();

    results.push({
      platform:  'Digimart',
      title,
      price:     null,
      currency:  'JPY',
      priceJPY:  priceJPY || 0,
      priceUSD:  priceJPY ? Math.round(priceJPY / USD_RATE) : 0,
      condition,
      status:    'listing',
      date,
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
