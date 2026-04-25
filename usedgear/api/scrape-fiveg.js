/**
 * /api/scrape-fiveg.js  —  GearJaws v1.2 T-07
 * Five G Music Technology (fiveg.net) スクレイピング
 *
 * GET /api/scrape-fiveg?q=neve+1073&debug=1
 *
 * 技術メモ:
 *   - fiveg.net は カラーミーショップ (GMO shop-pro) ベースの EC サイト
 *   - 検索URL: https://fiveg.net/?mode=srh&sort=n&cid=&keyword=neve
 *   - ページは EUC-JP エンコーディング → iconv-lite でデコード必須
 *   - 商品セレクター: li.product-list__unit (v1.2 で確認)
 *   - タイトル: a.product-list__name (a タグ自体がタイトル要素)
 *   - 価格: p.product-list__prices 内のテキスト
 *   - URL: 相対パス ?pid=XXXXX → https://fiveg.net/?pid=XXXXX に補完
 *
 * 変更履歴:
 *   v1.0 (T-07):      新規作成 (ColorMe デフォルトセレクターで試行)
 *   v1.2 (T-07 fix):  EUC-JP デコード + 正確なセレクター + URL補完
 */

const cheerio = require('cheerio');
const iconv   = require('iconv-lite');

const USD_RATE = 150;
const BASE_URL = 'https://fiveg.net';

function buildSearchUrl(query) {
  return `${BASE_URL}/?mode=srh&sort=n&cid=&keyword=${encodeURIComponent(query)}`;
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

/** 相対 URL を絶対 URL に変換 */
function toAbsoluteUrl(href) {
  if (!href) return BASE_URL;
  if (href.startsWith('http')) return href;
  // ?pid=XXXXX 形式 (クエリのみ)
  if (href.startsWith('?')) return `${BASE_URL}/${href}`;
  // /path 形式
  return `${BASE_URL}${href}`;
}

// ── セレクター (fiveg.net 実機確認済み, v1.2) ─────────────────────────────
const ITEM_SELECTORS = [
  // ✅ v1.2 実機確認: li.product-list__unit (53件マッチ)
  '.product-list__unit',
  'li.product-list__unit',
  // フォールバック (テンプレート変更時)
  'li.item_box',
  '.item_box',
  'li.clearfix',
  '#item_list li',
  '.item_list li',
  '.item',
];

// ── タイトルセレクター ────────────────────────────────────────────────────
// ✅ v1.2 確認: <a class="product-list__name product-list__text"> が直接タイトル要素
// ※ .product-list__name a (a の中の a) ではなく a.product-list__name (a 自体) が正しい
const TITLE_SELECTORS = [
  'a.product-list__name',           // ✅ 実機確認済み
  '.product-list__name',            // a でない場合のフォールバック
  'a[class*="product-list__name"]', // クラス名が変わった場合
  // ColorMe 旧テンプレート
  'p.item_name a', '.item_name a',
  // 汎用
  'h3 a', 'h2 a', '.name a',
];

// ── 価格セレクター ────────────────────────────────────────────────────────
// v1.2 確認: <p class="product-list__prices"> が価格コンテナ
const PRICE_SELECTORS = [
  'p.product-list__prices',            // ✅ 実機確認済み
  '.product-list__prices',
  '.product-list__price',
  'span.product-list__price',
  // ColorMe 旧テンプレート
  'p.item_price', '.item_price',
  '.price', 'span.price', '[class*="price"]',
];

// ── 状態セレクター ────────────────────────────────────────────────────────
const CONDITION_SELECTORS = [
  '.product-list__status', '.product-list__condition',
  '.item_status', '.condition', '.grade',
  '[class*="condition"]', '[class*="grade"]', '[class*="status"]',
];

// ── HTML パーサー ─────────────────────────────────────────────────────────
function parseFiveG(html, query, debug) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const results = [];
  const debugInfo = { selectors_tried: [] };

  let itemSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const count = $(sel).length;
    if (count > 0) {
      debugInfo.selectors_tried.push({ selector: sel, count });
      if (!itemSelector) itemSelector = sel;
    }
  }

  if (debug) {
    debugInfo.page_title        = $('title').text().trim().slice(0, 100);
    debugInfo.h1_texts          = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count        = itemSelector ? $(itemSelector).length : 0;
    debugInfo.encoding_note     = 'iconv-lite (euc-jp) でデコード済み';
    debugInfo.all_classes       = [...new Set(
      $('[class]').map((_, el) => ($(el).attr('class') || '').split(/\s+/)[0]).get()
    )].filter(Boolean).slice(0, 50);

    if (itemSelector) {
      debugInfo.first_item_html = $.html($(itemSelector).first()).slice(0, 1000);
      // タイトル・価格の抽出確認
      const firstItem = $(itemSelector).first();
      const sampleTitle = firstItem.find('a.product-list__name').first().text().trim()
        || firstItem.find('.product-list__name').first().text().trim();
      const samplePrice = firstItem.find('p.product-list__prices').first().text().trim()
        || firstItem.find('.product-list__prices').first().text().trim();
      debugInfo.sample_title = sampleTitle;
      debugInfo.sample_price = samplePrice;
    }
    return { results: [], debug: debugInfo };
  }

  if (!itemSelector) return { results: [], debug: debugInfo };

  const today = new Date().toISOString().slice(0, 10);

  $(itemSelector).each((_, el) => {
    // ── タイトル ──
    let title = null, titleHref = '';
    for (const sel of TITLE_SELECTORS) {
      const el2 = $(el).find(sel).first();
      if (!el2.length) {
        // セレクター自体が要素の場合（a.product-list__name が el の直接チルド）
        const self = $(el).filter(sel);
        if (self.length) {
          title = self.text().trim();
          titleHref = self.attr('href') || '';
          break;
        }
        continue;
      }
      const t = el2.text().trim();
      if (t) { title = t; titleHref = el2.attr('href') || ''; break; }
    }
    // フォールバック: テキストを持つ最初の a タグ
    if (!title) {
      $(el).find('a').each((_, a) => {
        const t = $(a).text().trim();
        if (t && t.length > 3) { title = t; titleHref = $(a).attr('href') || ''; return false; }
      });
    }
    if (!title || title.length < 3) return;

    // ── 価格 ──
    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceJPY = parseJpyPrice(p); if (priceJPY) break; }
    }
    if (!priceJPY) return; // 価格不明はスキップ

    // ── URL ──
    const url = toAbsoluteUrl(titleHref || $(el).find('a').first().attr('href') || '');

    // ── 状態 ──
    let condition = mapCondition(title);
    for (const sel of CONDITION_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }

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
      url,
      source:   'fiveg_scrape',
    });
  });

  return { results, debug: debugInfo };
}

// ── メインハンドラ ─────────────────────────────────────────────────────────
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
      // EUC-JP サイトのため gzip/br は避ける（文字化けのリスク）
      'Accept-Encoding': 'identity',
      'Cache-Control':   'no-cache',
      'Referer':         `${BASE_URL}/`,
    },
    signal: AbortSignal.timeout(10000),
    redirect: 'follow',
  };

  try {
    const response = await fetch(url, fetchOpts);

    if (!response.ok) {
      return res.status(200).json({
        source: 'fiveg_scrape', error: `HTTP ${response.status}`, url, listings: [],
      });
    }

    // ── EUC-JP デコード ──────────────────────────────────────────────────
    // fiveg.net は EUC-JP 固定。response.text() は UTF-8 として扱うため文字化けする。
    // ArrayBuffer → iconv-lite で正しくデコードする。
    const buf  = await response.arrayBuffer();
    const html = iconv.decode(Buffer.from(buf), 'euc-jp');

    const { results, debug: debugInfo } = parseFiveG(html, query, debug);

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
