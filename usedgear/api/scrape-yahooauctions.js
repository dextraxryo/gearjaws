/**
 * /api/scrape-yahooauctions.js  —  GearJaws v1.0 Session G
 * Yahoo!オークション 中古機材スクレイピング
 *
 * GET /api/scrape-yahooauctions?q=neve+1073&debug=1
 *
 * スクレイピング対象:
 *   出品中:  https://auctions.yahoo.co.jp/search/search?p=...&va=...&mode=1&s1=end&o1=d
 *   終了済み: https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=...&va=...&mode=1&s1=end&o1=d
 */

const cheerio = require('cheerio');

const JPY_PER_USD = 150; // 参考レート（固定）

// ── ヤフオクの HTML セレクター ────────────────────────────
// PC版・スマホ版・2024年以降の刷新版に対応（複数フォールバック）
const ITEM_SELECTORS = [
  'li.Product',
  '.Product',
  'li[data-auction-id]',
  '.SearchResult__list li',
  '.Auction',
  'li.auction',
  '.acItem',
];

const TITLE_SELECTORS = [
  '.Product__titleLink',
  '.Product__title a',
  'h3.Product__title a',
  'a.Product__titleLink',
  '[class*="Product__title"] a',
  'a[data-auction-id]',
  '.itemTtl a',
  '.title a',
  'h3 a',
];

const PRICE_SELECTORS = [
  '.Product__price',
  '.Product__priceValue',
  '.Price',
  '.price',
  '.Product__priceNumber',
  '[class*="price"]',
  '.acPrice',
  '.aucPrice',
];

const IMAGE_SELECTORS = [
  '.Product__imageData',
  '.Product__image img',
  'img.Product__image',
];

// ── ノイズ除外ワード ──────────────────────────────────────
const EXCLUDE_WORDS = [
  'software', 'plugin', 'plug-in', 'plug in', 'license', 'licence',
  'ilok', 'download', 'activation', 'subscription', 'serial key', 'usb key',
  't-shirt', 'tshirt', 'shirt', 'hoodie', 'hat', 'cap', 'apparel',
  'cable', 'patch cable', 'patchbay', 'patch bay', 'power supply',
  'rack screw', 'rack ear', 'rack kit', 'rack mount kit',
  'service manual', 'user manual', 'user guide', 'owner manual',
  'book', 'dvd', 'blu-ray', 'online course',
];

/**
 * 関連性チェック
 * - ノイズワード除外
 * - 型番トークン（数字含む）が存在する場合、タイトルに含まれなければ除外
 * - 全トークンのマッチ率チェック
 */
function isRelevant(title, query) {
  const t = (title || '').toLowerCase();
  const q = (query || '').toLowerCase();
  if (!t) return false;
  if (EXCLUDE_WORDS.some(w => t.includes(w))) return false;

  const tokens = q.match(/[a-z0-9]{2,}/g) || [];
  if (!tokens.length) return true;

  const modelTokens = tokens.filter(tok => /\d/.test(tok));
  if (modelTokens.length > 0) {
    const tAlnum = t.replace(/[^a-z0-9]/g, '');
    const hasModel = modelTokens.some(m => {
      const mc = m.replace(/[^a-z0-9]/g, '');
      return t.includes(m) || tAlnum.includes(mc);
    });
    if (!hasModel) return false;
  }

  const matchCount = tokens.filter(tok => t.includes(tok)).length;
  const threshold  = modelTokens.length > 0 ? 0.5 : 1.0;
  return (matchCount / tokens.length) >= threshold;
}

/**
 * 価格文字列 → 整数 (JPY)
 * "1,234円" / "¥1,234" / "1234" など
 */
function parseJpyPrice(str) {
  if (!str) return null;
  const clean = str.replace(/[^0-9]/g, '');
  const n = parseInt(clean, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

/**
 * 状態文字列の正規化
 * ヤフオクは状態記載がない場合が多いので '良好' をデフォルトとする
 */
function mapCondition(str) {
  if (!str) return '良好';
  const s = str.toLowerCase();
  if (s.includes('新品') || s.includes('未使用') || s.includes('new'))     return '新品同様';
  if (s.includes('未開封'))                                                   return '新品同様';
  if (s.includes('ほぼ') || s.includes('美品') || s.includes('mint'))       return '新品同様';
  if (s.includes('良い') || s.includes('良好') || s.includes('good'))       return '良好';
  if (s.includes('普通') || s.includes('使用感'))                            return '普通';
  if (s.includes('ジャンク') || s.includes('部品取り') || s.includes('broken')) return 'ジャンク';
  return '良好';
}

/**
 * 日付文字列の正規化 → YYYY-MM-DD
 * ヤフオクの表示: "4月17日" / "2024.03.15" / ISO 文字列
 */
function normalizeDate(str) {
  if (!str) return new Date().toISOString().slice(0, 10);
  const now = new Date();

  // ISO or YYYY-MM-DD
  const iso = str.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
  }
  // "4月17日" 形式（年なし → 今年）
  const jp = str.match(/(\d{1,2})月(\d{1,2})日/);
  if (jp) {
    return `${now.getFullYear()}-${jp[1].padStart(2,'0')}-${jp[2].padStart(2,'0')}`;
  }
  return now.toISOString().slice(0, 10);
}

// ── HTML パーサー ─────────────────────────────────────────
async function parseYahooAuctions(html, query, status, debug) {
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
    debugInfo.page_title  = $('title').text().slice(0, 80);
    debugInfo.h1_texts    = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count  = itemSelector ? $(itemSelector).length : 0;

    const allTitles = [];
    if (itemSelector) {
      $(itemSelector).each((_, el) => {
        let title = null;
        for (const sel of TITLE_SELECTORS) {
          const t = $(el).find(sel).first().text().trim();
          if (t) { title = t; break; }
        }
        if (!title) title = $(el).find('a').first().text().trim();
        if (title) allTitles.push({ title, relevant: isRelevant(title, query) });
      });
    }
    debugInfo.titles_with_relevance = allTitles.slice(0, 30);
    debugInfo.relevant_count   = allTitles.filter(x => x.relevant).length;
    debugInfo.irrelevant_count = allTitles.filter(x => !x.relevant).length;
    debugInfo.first_item_html  = itemSelector
      ? $.html($(itemSelector).first()).slice(0, 1000)
      : 'no items found';
    return { results: [], debug: debugInfo };
  }

  if (!itemSelector) return { results: [], debug: debugInfo };

  const today = new Date().toISOString().slice(0, 10);

  $(itemSelector).each((_, el) => {
    // タイトル
    let title = null;
    for (const sel of TITLE_SELECTORS) {
      const t = $(el).find(sel).first().text().trim();
      if (t) { title = t; break; }
    }
    if (!title) title = $(el).find('a').first().text().trim();
    if (!title) return;

    // 関連性フィルタ
    if (!isRelevant(title, query)) return;

    // 価格
    let priceJPY = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) {
        priceJPY = parseJpyPrice(p);
        if (priceJPY) break;
      }
    }
    if (!priceJPY) return; // 価格不明はスキップ

    // URL
    let url = '';
    for (const sel of TITLE_SELECTORS) {
      const a = $(el).find(sel).first();
      const href = a.attr('href');
      if (href) { url = href; break; }
    }
    if (!url) {
      url = $(el).find('a[href*="auctions.yahoo.co.jp"]').first().attr('href') || '';
    }
    if (!url) {
      url = $(el).find('a').first().attr('href') || '';
    }
    if (url && !url.startsWith('http')) {
      url = 'https://auctions.yahoo.co.jp' + url;
    }

    // 日付（終了日時 or 開始日時）
    const timeEl = $(el).find('[class*="time"], [class*="Time"], .Product__time, time').first();
    const rawDate = timeEl.attr('datetime') || timeEl.text().trim() || today;
    const date = normalizeDate(rawDate);

    // 状態
    const condEl = $(el).find('[class*="condition"], [class*="Condition"], [class*="status"], [class*="Status"]').first();
    const condition = mapCondition(condEl.text().trim() || title);

    results.push({
      platform:  'ヤフオク',
      title,
      price:     null,        // JPYのみ
      currency:  'JPY',
      priceJPY,
      priceUSD:  Math.round(priceJPY / JPY_PER_USD),
      condition,
      status,
      date,
      url:       url || 'https://auctions.yahoo.co.jp',
      source:    'yahooauctions_scrape',
    });
  });

  return { results, debug: debugInfo };
}

// ── URL ビルダー ─────────────────────────────────────────
function buildSearchUrl(query, ended) {
  const encoded = encodeURIComponent(query);
  if (ended) {
    // 終了済みオークション（落札相場調査に最重要）
    return `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${encoded}&va=${encoded}&mode=1&s1=end&o1=d&auccat=0`;
  }
  // 出品中（最新順）
  return `https://auctions.yahoo.co.jp/search/search?p=${encoded}&va=${encoded}&mode=1&s1=bids&o1=d&auccat=0`;
}

// ── メインハンドラ ────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const query = (req.query.q ?? '').trim();
  const debug = req.query.debug === '1';
  if (!query) return res.status(400).json({ error: 'q is required' });

  const fetchOpts = {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control':   'no-cache',
    },
    signal: AbortSignal.timeout(9000),
  };

  try {
    const [soldRes, liveRes] = await Promise.all([
      fetch(buildSearchUrl(query, true),  fetchOpts).catch(e => ({ ok: false, _err: e.message })),
      fetch(buildSearchUrl(query, false), fetchOpts).catch(e => ({ ok: false, _err: e.message })),
    ]);

    if (debug) {
      // デバッグモードは一方だけ詳細返却（終了済みを優先）
      const targetRes = soldRes.ok ? soldRes : liveRes;
      const html = targetRes.ok ? await targetRes.text() : '';
      const { results, debug: debugInfo } = await parseYahooAuctions(html, query, 'sold', true);
      return res.status(200).json({
        source: 'yahooauctions_scrape',
        url: buildSearchUrl(query, true),
        soldStatus:  soldRes.ok  ? 'ok'  : (soldRes._err || 'error'),
        liveStatus:  liveRes.ok  ? 'ok'  : (liveRes._err || 'error'),
        html_length: html.length,
        debug: debugInfo,
        listings: [],
      });
    }

    const allResults = [];

    if (soldRes.ok) {
      const html = await soldRes.text();
      const { results } = await parseYahooAuctions(html, query, 'sold', false);
      allResults.push(...results);
    }
    if (liveRes.ok) {
      const html = await liveRes.text();
      const { results } = await parseYahooAuctions(html, query, 'listing', false);
      allResults.push(...results);
    }

    // 重複除去（同タイトル+同価格）
    const seen = new Set();
    const deduped = allResults.filter(r => {
      const key = `${r.title}|${r.priceJPY}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({
      source:   'yahooauctions_scrape',
      query,
      total:    deduped.length,
      listings: deduped,
    });

  } catch (err) {
    console.error('[scrape-yahooauctions] error:', err.message);
    return res.status(200).json({
      source: 'yahooauctions_scrape', error: err.message, listings: [],
    });
  }
};
