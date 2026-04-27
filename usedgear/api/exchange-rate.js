/**
 * /api/exchange-rate.js  —  GearJaws
 * USD/JPY 為替レートを Open Exchange Rates API から取得して返す
 *
 * GET /api/exchange-rate
 * Response: { rate: 153.4, source: "oxr"|"cache"|"fallback", timestamp: 1234567890 }
 *
 * キャッシュ戦略（2層）:
 *   1. Vercel エッジキャッシュ  — s-maxage=3600 (1時間)
 *   2. Lambda 内メモリキャッシュ — 同じウォームインスタンスなら OXR を再呼び出しせず
 *
 * OXR 無料プラン: 1000 req/月 → 1時間キャッシュで ~24req/日 に抑制
 *
 * 環境変数:
 *   OPEN_EXCHANGE_RATES_APP_ID  — OXR の App ID（未設定時は fallback 150 を返す）
 */

const FALLBACK_RATE = 150;
const CACHE_TTL_MS  = 60 * 60 * 1000; // 1時間

// ── Lambda 内メモリキャッシュ ──────────────────────────────────────────────
let _cache = null; // { rate: number, ts: number }

module.exports = async function handler(req, res) {
  // Vercel エッジキャッシュヘッダー
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // ① Lambda 内メモリキャッシュヒット
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL_MS) {
    return res.status(200).json({
      rate:      _cache.rate,
      source:    'cache',
      cached:    true,
      timestamp: Math.floor(_cache.ts / 1000),
    });
  }

  const appId = process.env.OPEN_EXCHANGE_RATES_APP_ID;

  // ② App ID 未設定 → フォールバック
  if (!appId) {
    return res.status(200).json({
      rate:   FALLBACK_RATE,
      source: 'fallback',
      note:   'OPEN_EXCHANGE_RATES_APP_ID not set',
    });
  }

  // ③ Open Exchange Rates API 呼び出し
  try {
    const url = `https://openexchangerates.org/api/latest.json?app_id=${appId}&symbols=JPY`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[exchange-rate] OXR error:', response.status, text.slice(0, 200));
      return res.status(200).json({ rate: FALLBACK_RATE, source: 'fallback', error: `HTTP ${response.status}` });
    }

    const data = await response.json();
    const rawRate = data?.rates?.JPY;

    // 異常値チェック（50〜500 の範囲外はフォールバック）
    if (!rawRate || rawRate < 50 || rawRate > 500) {
      console.error('[exchange-rate] Unexpected rate:', rawRate);
      return res.status(200).json({ rate: FALLBACK_RATE, source: 'fallback', error: 'unexpected_rate' });
    }

    const rate = Math.round(rawRate * 100) / 100; // 小数点以下2桁に丸め

    // メモリキャッシュ更新
    _cache = { rate, ts: Date.now() };

    return res.status(200).json({
      rate,
      source:    'oxr',
      timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    });

  } catch (err) {
    console.error('[exchange-rate] fetch error:', err.message);
    return res.status(200).json({ rate: FALLBACK_RATE, source: 'fallback', error: err.message });
  }
};
