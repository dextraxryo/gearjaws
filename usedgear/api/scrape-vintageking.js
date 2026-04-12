/**
 * /api/scrape-vintageking.js  —  GearJaws v1.0 Session E
 * Vintage King 中古機材ページのスクレイピング（Magento 2ベース）
 *
 * GET /api/scrape-vintageking?q=neve+1073&debug=1
 */

const cheerio = require('cheerio');
const USD_RATE = 150;

function buildVintageKingUrl(query) {
  const q = encodeURIComponent(query);
  // Vintage King の中古品検索URL（Magento 2ベース）
  return `https://vintageking.com/catalogsearch/result/?q=${q}&used=1`;
}

function parseUsdPrice(str) {
  if (!str) return null;
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

// ── 関連性フィルタリング ──────────────────────────────────
// これらのキーワードを含むタイトルは除外
const EXCLUDE_WORDS = [
  // ソフトウェア / ライセンス
  'software', 'plugin', 'plug-in', 'plug in', 'license', 'licence',
  'ilok', 'download', 'activation', 'subscription', 'serial key', 'usb key',
  // アパレル
  't-shirt', 'tshirt', 'shirt', 'hoodie', 'hat', 'cap', 'apparel',
  // ケーブル・消耗品
  'cable', 'patch cable', 'patchbay', 'patch bay', 'power supply',
  'rack screw', 'rack ear', 'rack kit', 'rack mount kit',
  // 書籍 / メディア
  'service manual', 'user manual', 'user guide', 'owner manual',
  'book', 'dvd', 'blu-ray', 'online course',
];

/**
 * クエリとタイトルの関連性チェック
 *
 * ロジック:
 *  1. EXCLUDE_WORDS にヒットしたら即除外
 *  2. クエリを英数字トークン（2文字以上）に分割
 *  3. 型番トークン（数字を含む: "1073", "u87", "1176"）が存在する場合、
 *     タイトルにそのうち少なくとも1つが含まれなければ除外
 *  4. 全トークンのマッチ率チェック
 *     - 型番あり: 50%以上
 *     - 型番なし（ブランド名のみ等）: 100%（全トークン一致）
 *
 * @param {string} title  商品タイトル
 * @param {string} query  検索クエリ
 * @returns {boolean}
 */
function isRelevant(title, query) {
  const titleLow = title.toLowerCase();
  const queryLow = query.toLowerCase();

  // 1. ノイズキーワード除外
  if (EXCLUDE_WORDS.some(w => titleLow.includes(w))) return false;

  // 2. クエリトークン（英数字2文字以上）
  const tokens = queryLow.match(/[a-z0-9]{2,}/g) || [];
  if (!tokens.length) return true;

  // 3. 型番トークン（数字を含む）
  const modelTokens = tokens.filter(t => /\d/.test(t));
  if (modelTokens.length > 0) {
    // タイトルから記号を除いた文字列（"u-87" → "u87" のようなハイフン無視）
    const titleAlnum = titleLow.replace(/[^a-z0-9]/g, '');
    const hasModel = modelTokens.some(m => {
      const mClean = m.replace(/[^a-z0-9]/g, '');
      return titleLow.includes(m) || titleAlnum.includes(mClean);
    });
    // 型番がタイトルに一切含まれない → 除外
    if (!hasModel) return false;
  }

  // 4. マッチ率チェック
  const matchCount = tokens.filter(t => titleLow.includes(t)).length;
  const threshold  = modelTokens.length > 0 ? 0.5 : 1.0;
  return (matchCount / tokens.length) >= threshold;
}

function mapCondition(str) {
  const s = (str || '').toLowerCase();
  if (s.includes('mint') || s.includes('excellent') || s.includes('like new')) return '新品同様';
  if (s.includes('very good') || s.includes('good+'))  return '良好';
  if (s.includes('junk') || s.includes('parts'))       return 'ジャンク';
  if (s.includes('good') || s.includes('used'))        return '良好';
  return '普通';
}

async function parseVintageKing(html, cheerio, query, debug) {
  const $ = cheerio.load(html);
  const results = [];
  const debugInfo = { selectors_tried: [] };

  // Magento 2 の標準セレクター + Vintage King 固有のもの
  const ITEM_SELECTORS = [
    '.product-item',           // Magento 2 標準
    '.products-grid .item',
    '.product_list li',
    'li.item.product',
    '.product-items li',
    '[class*="product-item"]',
  ];
  const TITLE_SELECTORS  = [
    'a.product-item-link',     // Vintage King 実測セレクター
    '.product-item-name a',    // Magento 2 標準
    '.product-item-link',
    '.product-name a',
    'h2.product-name a',
    '.name a',
  ];
  const PRICE_SELECTORS  = [
    'span.price',              // Vintage King 実測セレクター
    '.price-box .price',       // Magento 2 標準
    '.special-price .price',
    '.regular-price .price',
    '[data-price-type="finalPrice"] .price',
    '.price',
  ];
  const CONDITION_SELECTORS = [
    '.condition',
    '[class*="condition"]',
    '.product-condition',
    '.used-condition',
  ];

  let itemSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const count = $(sel).length;
    debugInfo.selectors_tried.push({ selector: sel, count });
    if (count > 0 && !itemSelector) itemSelector = sel;
  }

  if (debug) {
    debugInfo.page_title   = $('title').text().slice(0, 80);
    debugInfo.h1_texts     = $('h1').map((_, el) => $(el).text().trim()).get().slice(0, 3);
    debugInfo.item_count   = itemSelector ? $(itemSelector).length : 0;
    // 全タイトルとフィルター結果を確認
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
      ? $.html($(itemSelector).first()).slice(0, 800)
      : 'no items found';
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

    // 関連性フィルタ: クエリと無関係な商品・ノイズを除外
    if (!isRelevant(title, query)) return;

    let priceUSD = null;
    for (const sel of PRICE_SELECTORS) {
      const p = $(el).find(sel).first().text().trim();
      if (p) { priceUSD = parseUsdPrice(p); break; }
    }

    // product-item-link が href を持つ → フォールバックで最初の a タグ
    let url = $(el).find('a.product-item-link').first().attr('href')
           || $(el).find('a.product photo').first().attr('href')
           || $(el).find('a').first().attr('href')
           || '';
    if (url && !url.startsWith('http')) url = 'https://vintageking.com' + url;

    let condition = '良好'; // Vintage King は中古品がメイン
    for (const sel of CONDITION_SELECTORS) {
      const c = $(el).find(sel).first().text().trim();
      if (c) { condition = mapCondition(c); break; }
    }

    const priceJPY = priceUSD ? Math.round(priceUSD * USD_RATE) : 0;

    results.push({
      platform:  'Vintage King',
      title,
      price:     priceUSD,
      currency:  'USD',
      priceJPY,
      priceUSD:  priceUSD || 0,
      condition,
      status:    'listing',
      date:      new Date().toISOString().slice(0, 10),
      url:       url || 'https://vintageking.com/used-gear',
      source:    'vintageking_scrape',
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

  try {
    const url = buildVintageKingUrl(query);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GearJaws/1.0; price-research-bot)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return res.status(200).json({
        source: 'vintageking_scrape',
        error: `HTTP ${response.status}`,
        url,
        listings: [],
      });
    }

    const html = await response.text();
    const { results, debug: debugInfo } = await parseVintageKing(html, cheerio, query, debug);

    return res.status(200).json({
      source:   'vintageking_scrape',
      url,
      total:    results.length,
      listings: results,
      ...(debug ? { debug: debugInfo } : {}),
    });

  } catch (err) {
    console.error('[scrape-vintageking] error:', err.message);
    return res.status(200).json({
      source: 'vintageking_scrape', error: err.message, listings: [],
    });
  }
};
