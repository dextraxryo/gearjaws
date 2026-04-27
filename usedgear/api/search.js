// ============================================================
// GearJaws — /api/search.js
// Vercel Serverless Function  (Session A + D / v0.3〜v1.0)
//
// 役割: 各プラットフォームのAPIを呼び出し、
//       共通スキーマに正規化して返す。
// 現在対応: Reverb.com（公式API）/ eBay Finding API（v1.0）
// 将来対応: ヤフオク(v1.5), etc.
// ============================================================

// ── 定数 ─────────────────────────────────────────────────────
const USD_RATE_FALLBACK = 150; // OXR 取得失敗時のフォールバック

// ── 全プラットフォーム共通・関連性フィルター ──────────────────
const NOISE_EXCLUDE = [
  'software', 'plugin', 'plug-in', 'license', 'licence', 'ilok',
  'download', 'activation', 'subscription', 'serial key', 'usb key',
  't-shirt', 'tshirt', 'shirt', 'hoodie', 'hat', 'apparel',
  'cable', 'patch cable', 'power supply', 'rack screw', 'rack ear',
  'service manual', 'user manual', 'owner manual', 'book', 'dvd', 'course',
];

function isRelevantTitle(title, query) {
  const t = (title || '').toLowerCase();
  const q = (query || '').toLowerCase();
  if (!t) return false;
  if (NOISE_EXCLUDE.some(w => t.includes(w))) return false;
  const tokens = q.match(/[a-z0-9]{2,}/g) || [];
  if (!tokens.length) return true;
  const modelTokens = tokens.filter(tok => /\d/.test(tok));
  if (modelTokens.length > 0) {
    const tAlnum = t.replace(/[^a-z0-9]/g, '');
    const hasModel = modelTokens.some(m =>
      t.includes(m) || tAlnum.includes(m.replace(/[^a-z0-9]/g, ''))
    );
    if (!hasModel) return false;
  }
  const matchCount = tokens.filter(tok => t.includes(tok)).length;
  return (matchCount / tokens.length) >= (modelTokens.length > 0 ? 0.5 : 1.0);
}
const REVERB_BASE = 'https://api.reverb.com/api';
const EBAY_FINDING_BASE = 'https://svcs.ebay.com/services/search/FindingService/v1';
const PER_PAGE = 50;

// ════════════════════════════════════════════════════════════
// REVERB
// ════════════════════════════════════════════════════════════

const REVERB_CONDITION_MAP = {
  'Brand New':      '新品同様',
  'Mint':           '新品同様',
  'Near Mint':      '新品同様',
  'Excellent Plus': '良好',
  'Excellent':      '良好',
  'Very Good Plus': '良好',
  'Very Good':      '良好',
  'Good':           '普通',
  'Fair':           '普通',
  'Poor':           'ジャンク',
  'Non Functioning':'ジャンク',
  'B-Stock':        '普通',
};

function normalizeReverbCondition(displayName) {
  if (!displayName) return '普通';
  return REVERB_CONDITION_MAP[displayName] || '普通';
}

function normalizeReverbStatus(stateSlug) {
  if (stateSlug === 'sold') return 'sold';
  if (stateSlug === 'live') return 'listing';
  return 'ended';
}

function normalizeReverbListing(listing, usdRate = USD_RATE_FALLBACK) {
  const rawPrice = parseFloat(listing.price?.amount ?? 0);
  const currency = (listing.price?.currency ?? 'USD').toUpperCase();

  const priceJPY = currency === 'USD'
    ? Math.round(rawPrice * usdRate)
    : Math.round(rawPrice);
  const priceUSD = currency === 'USD'
    ? rawPrice
    : Math.round(rawPrice / usdRate);

  const rawDate = listing.published_at ?? listing.created_at ?? '';
  const date = rawDate ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const url = listing._links?.web?.href ?? (listing.slug
    ? `https://reverb.com/item/${listing.id}-${listing.slug}`
    : 'https://reverb.com');

  return {
    platform:  'Reverb',
    title:     listing.title ?? '',
    price:     currency === 'USD' ? rawPrice : null,
    currency,
    priceJPY,
    priceUSD,
    condition: normalizeReverbCondition(listing.condition?.display_name),
    status:    normalizeReverbStatus(listing.state?.slug),
    date,
    url,
    source:    'reverb_api',
  };
}

async function searchReverb(query, apiKey, usdRate = USD_RATE_FALLBACK) {
  const params = new URLSearchParams({ query, per_page: String(PER_PAGE) });
  const headers = {
    'Authorization':  `Bearer ${apiKey}`,
    'Accept':         'application/hal+json',
    'Accept-Version': '3.0',
    'Content-Type':   'application/hal+json',
  };

  const [soldRes, liveRes] = await Promise.all([
    fetch(`${REVERB_BASE}/listings/all?${params}&state[]=sold`, { headers }),
    fetch(`${REVERB_BASE}/listings/all?${params}&state[]=live`, { headers }),
  ]);

  const results = [];
  if (soldRes.ok) {
    const d = await soldRes.json();
    results.push(...(d.listings ?? []).map(l => normalizeReverbListing(l, usdRate)));
  }
  if (liveRes.ok) {
    const d = await liveRes.json();
    results.push(...(d.listings ?? []).map(l => normalizeReverbListing(l, usdRate)));
  }
  return results;
}

// ════════════════════════════════════════════════════════════
// EBAY Finding API
// ════════════════════════════════════════════════════════════

// eBay conditionId → 内部スキーマ
const EBAY_CONDITION_MAP = {
  '1000': '新品同様', // New
  '1500': '新品同様', // New other
  '2000': '良好',    // Manufacturer refurbished
  '2500': '良好',    // Seller refurbished
  '3000': '良好',    // Used
  '4000': '良好',    // Very Good
  '5000': '普通',    // Good
  '6000': '普通',    // Acceptable
  '7000': 'ジャンク', // For parts or not working
};

function normalizeEbayCondition(conditionId) {
  return EBAY_CONDITION_MAP[String(conditionId)] || '普通';
}

// eBay の item オブジェクト → 共通スキーマ
function normalizeEbayItem(item, status, usdRate = USD_RATE_FALLBACK) {
  // eBay の JSON レスポンスは配列でラップされている
  const title    = (item.title?.[0] ?? '').trim();
  const currency = item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] ?? 'USD';
  const rawPrice = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] ?? 0);

  const priceJPY = currency === 'USD'
    ? Math.round(rawPrice * usdRate)
    : Math.round(rawPrice);
  const priceUSD = currency === 'USD'
    ? rawPrice
    : Math.round(rawPrice / usdRate);

  // 日付: 成約済みは endTime、出品中は startTime
  const rawDate = status === 'sold'
    ? (item.listingInfo?.[0]?.endTime?.[0] ?? '')
    : (item.listingInfo?.[0]?.startTime?.[0] ?? '');
  const date = rawDate ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const conditionId = item.condition?.[0]?.conditionId?.[0] ?? '3000';
  const url = item.viewItemURL?.[0] ?? 'https://www.ebay.com';

  return {
    platform:  'eBay',
    title,
    price:     currency === 'USD' ? rawPrice : null,
    currency,
    priceJPY,
    priceUSD,
    condition: normalizeEbayCondition(conditionId),
    status,
    date,
    url,
    source:    'ebay_api',
  };
}

// eBay Finding API を呼び出す共通関数
async function ebayFindingRequest(operation, query, appId) {
  // sortOrder: findCompletedItems は EndTimeSoonest、findItemsAdvanced は StartTimeNewest
  const sortOrder = operation === 'findCompletedItems'
    ? 'EndTimeSoonest'
    : 'StartTimeNewest';

  // FixedPrice フィルターを外す → オークション・固定価格の両方を取得
  // （ビンテージ機材はオークション出品が多いため必須）
  const url = `${EBAY_FINDING_BASE}` +
    `?OPERATION-NAME=${operation}` +
    `&SERVICE-VERSION=1.0.0` +
    `&SECURITY-APPNAME=${encodeURIComponent(appId)}` +
    `&RESPONSE-DATA-FORMAT=JSON` +
    `&keywords=${encodeURIComponent(query)}` +
    `&paginationInput.entriesPerPage=${PER_PAGE}` +
    `&sortOrder=${sortOrder}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay API ${operation} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function searchEbay(query, appId, usdRate = USD_RATE_FALLBACK) {
  // v1.0: findCompletedItems のみ（成約済み）
  // API コール数を節約するため出品中(findItemsAdvanced)は省略
  // 価格相場調査には成約済みデータが最重要
  const soldData = await ebayFindingRequest('findCompletedItems', query, appId).catch(e => {
    console.warn('[eBay] findCompletedItems error:', e.message);
    return null;
  });

  const results = [];

  if (soldData) {
    const items = soldData.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item ?? [];
    for (const item of items) {
      const state = item.sellingStatus?.[0]?.sellingState?.[0] ?? '';
      const status = state === 'EndedWithSales' ? 'sold' : 'ended';
      results.push(normalizeEbayItem(item, status, usdRate));
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════
// スクレイピング内部呼び出しヘルパー
// ════════════════════════════════════════════════════════════

// 同一 Vercel デプロイの別 API エンドポイントを呼び出す
async function scrapeInternal(path, req) {
  // ホスト名を動的に解決（ローカル / 本番 両対応）
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'gearjaws.vercel.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}${path}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const json = await res.json();
  return json.listings || [];
}

// ════════════════════════════════════════════════════════════
// 為替レート取得（OXR 直呼び + Lambda 内メモリキャッシュ）
// ════════════════════════════════════════════════════════════
// ※ /api/exchange-rate 経由だと Lambda 間 HTTP でコールドスタート時に
//    タイムアウトする問題があったため、OXR を直接呼び出す方式に変更。
//    /api/exchange-rate エンドポイントはフロントエンド直接利用のために残す。

let _usdRateCache = null; // { rate: number, ts: number }
const USD_RATE_CACHE_TTL = 60 * 60 * 1000; // 1時間

async function fetchUsdRate() {
  // ① メモリキャッシュヒット（同一ウォームインスタンス内）
  if (_usdRateCache && (Date.now() - _usdRateCache.ts) < USD_RATE_CACHE_TTL) {
    return _usdRateCache.rate;
  }

  const appId = process.env.OPEN_EXCHANGE_RATES_APP_ID;
  if (!appId) return USD_RATE_FALLBACK;

  try {
    const res = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${appId}&symbols=JPY`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      console.warn('[fetchUsdRate] OXR HTTP error:', res.status);
      return USD_RATE_FALLBACK;
    }
    const data = await res.json();
    const raw  = data?.rates?.JPY;
    if (!raw || raw < 50 || raw > 500) return USD_RATE_FALLBACK;
    const rate = Math.round(raw * 100) / 100;
    _usdRateCache = { rate, ts: Date.now() };
    return rate;
  } catch (e) {
    console.warn('[fetchUsdRate] fallback:', e.message);
    return USD_RATE_FALLBACK;
  }
}

// USD 価格を持つスクレイパー結果のレートを再計算
// （各スクレイパーはハードコードレートで priceJPY を計算済みのため上書き）
function applyUsdRate(items, usdRate) {
  if (usdRate === USD_RATE_FALLBACK) return items; // レートが変わらなければスキップ
  return items.map(item => {
    if (item.currency === 'USD' && item.priceUSD > 0) {
      return { ...item, priceJPY: Math.round(item.priceUSD * usdRate) };
    }
    return item;
  });
}

// ════════════════════════════════════════════════════════════
// メインハンドラ
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const query = (req.query.q ?? '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const reverbKey = process.env.REVERB_API_KEY;
  const ebayAppId = process.env.EBAY_APP_ID;

  if (!reverbKey && !ebayAppId) {
    return res.status(200).json({
      source: 'no_api_key', query, total: 0, listings: [],
      platforms_searched: [],
      warning: 'No API keys configured.',
    });
  }

  try {
    // 為替レートと各プラットフォーム検索を並列実行
    const [
      usdRate,
      reverbResults,
      ebayResults,
      digimartResults,
      vintagekingResults,
      yahooResults,
      fivegResults,
    ] = await Promise.all([
      // ① 為替レート取得（OXR 直呼び・メモリキャッシュあり）
      fetchUsdRate(),
      // ② 各プラットフォーム検索
      reverbKey
        ? searchReverb(query, reverbKey).catch(e => {
            console.error('[Reverb] error:', e.message); return [];
          })
        : Promise.resolve([]),
      ebayAppId
        ? searchEbay(query, ebayAppId).catch(e => {
            console.error('[eBay] error:', e.message); return [];
          })
        : Promise.resolve([]),
      // Digimart スクレイピング
      scrapeInternal(`/api/scrape-digimart?q=${encodeURIComponent(query)}`, req).catch(e => {
        console.error('[Digimart] error:', e.message); return [];
      }),
      // Vintage King スクレイピング（USD 価格）
      scrapeInternal(`/api/scrape-vintageking?q=${encodeURIComponent(query)}`, req).catch(e => {
        console.error('[VintageKing] error:', e.message); return [];
      }),
      // Yahoo!オークション スクレイピング
      scrapeInternal(`/api/scrape-yahooauctions?q=${encodeURIComponent(query)}`, req).catch(e => {
        console.error('[YahooAuctions] error:', e.message); return [];
      }),
      // Five G Music Technology スクレイピング
      scrapeInternal(`/api/scrape-fiveg?q=${encodeURIComponent(query)}`, req).catch(e => {
        console.error('[FiveG] error:', e.message); return [];
      }),
    ]);

    // Reverb/eBay はすでに動的レートで正規化済み
    // スクレイパー結果（Vintage King 等 USD 価格あり）を動的レートで再計算
    const listings = [
      ...reverbResults,
      ...ebayResults,
      ...digimartResults,
      ...applyUsdRate(vintagekingResults, usdRate),
      ...yahooResults,
      ...fivegResults,
    ].filter(l => isRelevantTitle(l.title, query));

    // 日付降順でソート
    listings.sort((a, b) => new Date(b.date) - new Date(a.date));

    const platformsSearched = [
      ...(reverbKey                      ? ['Reverb']       : []),
      ...(ebayAppId                      ? ['eBay']          : []),
      ...(digimartResults.length > 0     ? ['Digimart']      : []),
      ...(vintagekingResults.length > 0  ? ['Vintage King']  : []),
      ...(yahooResults.length > 0        ? ['ヤフオク']      : []),
      ...(fivegResults.length > 0        ? ['Five G']        : []),
    ];

    return res.status(200).json({
      source: 'multi_api',
      query,
      total: listings.length,
      listings,
      platforms_searched: platformsSearched,
      usd_rate: usdRate, // フロントエンド表示用
    });

  } catch (err) {
    console.error('Search handler error:', err.message);
    return res.status(500).json({
      error: 'Search failed', message: err.message,
      listings: [], platforms_searched: [],
    });
  }
};
