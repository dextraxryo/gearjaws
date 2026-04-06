// ============================================================
// GearJaws — /api/search.js
// Vercel Serverless Function  (Session A / v0.3)
//
// 役割: 各プラットフォームのAPIを呼び出し、
//       共通スキーマに正規化して返す。
// 現在対応: Reverb.com（公式API）
// 将来対応: eBay(v1.0), ヤフオク(v1.5), etc.
// ============================================================

// ── 定数 ─────────────────────────────────────────────────────
const USD_RATE = 150; // 参考レート（v1.0でOpen Exchange Rates APIに切り替え予定）
const REVERB_BASE = 'https://api.reverb.com/api';
const PER_PAGE = 50; // Reverbの1リクエストあたり最大取得件数

// ── Reverb コンディション → 内部スキーマ変換 ─────────────────
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

function normalizeCondition(displayName) {
  if (!displayName) return '普通';
  return REVERB_CONDITION_MAP[displayName] || '普通';
}

// Reverb ステート → 内部スキーマ変換
function normalizeStatus(stateSlug) {
  if (stateSlug === 'sold')  return 'sold';
  if (stateSlug === 'live')  return 'listing';
  return 'ended';
}

// Reverb の listing オブジェクト → 共通スキーマ
function normalizeReverbListing(listing) {
  const rawPrice = parseFloat(listing.price?.amount ?? 0);
  const currency = (listing.price?.currency ?? 'USD').toUpperCase();

  const priceJPY = currency === 'USD'
    ? Math.round(rawPrice * USD_RATE)
    : Math.round(rawPrice);
  const priceUSD = currency === 'USD'
    ? rawPrice
    : Math.round(rawPrice / USD_RATE);

  // 出品日（ISO 8601 → YYYY-MM-DD）
  const rawDate = listing.published_at ?? listing.created_at ?? '';
  const date = rawDate ? rawDate.slice(0, 10) : new Date().toISOString().slice(0, 10);

  // URL（Reverb の商品ページ）
  const url = listing._links?.web?.href ?? listing.slug
    ? `https://reverb.com/item/${listing.id}-${listing.slug}`
    : 'https://reverb.com';

  return {
    platform:  'Reverb',
    title:     listing.title ?? '',
    price:     currency === 'USD' ? rawPrice : null,
    currency,
    priceJPY,
    priceUSD,
    condition: normalizeCondition(listing.condition?.display_name),
    status:    normalizeStatus(listing.state?.slug),
    date,
    url,
    source:    'reverb_api',
  };
}

// ── Reverb API 呼び出し ───────────────────────────────────────
async function searchReverb(query, apiKey) {
  const params = new URLSearchParams({
    query,
    per_page: String(PER_PAGE),
    // sold + live 両方を取得する（価格相場調査のため）
  });

  const headers = {
    'Authorization':  `Bearer ${apiKey}`,
    'Accept':         'application/hal+json',
    'Accept-Version': '3.0',
    'Content-Type':   'application/hal+json',
  };

  // ① 成約済み（sold）を取得
  const soldUrl  = `${REVERB_BASE}/listings/all?${params}&state[]=sold`;
  // ② 出品中（live）を取得
  const liveUrl  = `${REVERB_BASE}/listings/all?${params}&state[]=live`;

  const [soldRes, liveRes] = await Promise.all([
    fetch(soldUrl, { headers }),
    fetch(liveUrl, { headers }),
  ]);

  const results = [];

  if (soldRes.ok) {
    const soldData = await soldRes.json();
    const normalized = (soldData.listings ?? []).map(normalizeReverbListing);
    results.push(...normalized);
  } else {
    console.warn('Reverb sold fetch failed:', soldRes.status, soldRes.statusText);
  }

  if (liveRes.ok) {
    const liveData = await liveRes.json();
    const normalized = (liveData.listings ?? []).map(normalizeReverbListing);
    results.push(...normalized);
  } else {
    console.warn('Reverb live fetch failed:', liveRes.status, liveRes.statusText);
  }

  return results;
}

// ── メインハンドラ ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS（同一ドメインからも、ローカル開発時も動くように）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const query = (req.query.q ?? '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const apiKey = process.env.REVERB_API_KEY;

  // ── API Key 未設定の場合: 空結果を返す（フロントのフォールバックに委ねる）──
  if (!apiKey) {
    console.warn('REVERB_API_KEY is not set. Returning empty results.');
    return res.status(200).json({
      source:            'no_api_key',
      query,
      total:             0,
      listings:          [],
      platforms_searched: [],
      warning:           'REVERB_API_KEY environment variable is not configured.',
    });
  }

  try {
    const listings = await searchReverb(query, apiKey);

    // 日付降順でソート
    listings.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(200).json({
      source:            'reverb_api',
      query,
      total:             listings.length,
      listings,
      platforms_searched: ['Reverb'],
    });

  } catch (err) {
    console.error('Search handler error:', err.message);
    return res.status(500).json({
      error:             'Search failed',
      message:           err.message,
      listings:          [],
      platforms_searched: [],
    });
  }
};
