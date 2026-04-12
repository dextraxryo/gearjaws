/**
 * /api/cron-collect.js  —  GearJaws v1.0 Session F
 * 毎日 02:00 UTC に全収録機材の価格スナップショットを取得・Supabase に保存
 *
 * Vercel Cron schedule: 0 2 * * *
 * 保護: Vercel が Authorization: Bearer $CRON_SECRET を自動付与
 *
 * GET /api/cron-collect  （手動実行 + Vercel Cron）
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;  // Vercel が自動設定

// ── Supabase REST ヘルパー ────────────────────────────────
function sbHeaders(extra = {}) {
  return {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    ...extra,
  };
}

async function sbFetch(path, method = 'GET', body = null, extra = {}) {
  const url  = `${SUPABASE_URL}/rest/v1${path}`;
  const opts = { method, headers: sbHeaders(extra), signal: AbortSignal.timeout(12000) };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ── 統計計算 ──────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function aggregateByPlatform(listings, productId, query) {
  const today = new Date().toISOString().slice(0, 10);
  const map   = {};

  for (const l of listings) {
    const p     = (l.platform || 'Unknown').trim();
    const price = l.priceJPY || l.price_jpy;
    if (!price || price <= 0) continue;
    if (!map[p]) map[p] = [];
    map[p].push(price);
  }

  const rows = [];

  for (const [platform, prices] of Object.entries(map)) {
    rows.push({
      product_id:    productId,
      query,
      platform,
      snapshot_date: today,
      listing_count: prices.length,
      avg_price_jpy: Math.round(prices.reduce((a, b) => a + b) / prices.length),
      min_price_jpy: Math.min(...prices),
      med_price_jpy: median(prices),
      max_price_jpy: Math.max(...prices),
    });
  }

  // 全プラットフォーム合算
  const all = Object.values(map).flat();
  if (all.length > 0) {
    rows.push({
      product_id:    productId,
      query,
      platform:      'all',
      snapshot_date: today,
      listing_count: all.length,
      avg_price_jpy: Math.round(all.reduce((a, b) => a + b) / all.length),
      min_price_jpy: Math.min(...all),
      med_price_jpy: median(all),
      max_price_jpy: Math.max(...all),
    });
  }

  return rows;
}

// ── メインハンドラ ────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Vercel Cron 認証チェック（本番のみ）
  const authHeader = req.headers['authorization'];
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env not configured' });
  }

  const startedAt = Date.now();
  const log       = [];

  try {
    // 収録機材一覧を取得（active=true のみ）
    const products = await sbFetch('/products?active=eq.true&select=id,name');
    log.push({ step: 'products_loaded', count: products.length });

    // リクエスト元ホストから内部 search API の URL を構築
    const host  = req.headers['x-forwarded-host'] || req.headers.host || 'gearjaws.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';

    for (const product of products) {
      try {
        // 内部 /api/search を呼び出し（キャッシュを無効化してフレッシュ取得）
        const searchUrl = `${proto}://${host}/api/search?q=${encodeURIComponent(product.name)}&nocache=${Date.now()}`;
        const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });

        if (!searchRes.ok) {
          const errBody = await searchRes.text();
          throw new Error(`search HTTP ${searchRes.status}: ${errBody.slice(0, 300)}`);
        }

        const rawText = await searchRes.text();
        if (!rawText || rawText.trim() === '') {
          throw new Error(`search API empty body (url: ${searchUrl})`);
        }

        let json;
        try {
          json = JSON.parse(rawText);
        } catch (e) {
          throw new Error(`search JSON parse failed: ${rawText.slice(0, 300)}`);
        }

        const listings = json.listings || [];
        const rows = aggregateByPlatform(listings, product.id, product.name.toLowerCase());

        if (rows.length > 0) {
          // UPSERT（同日・同 product・同 platform は上書き）
          // on_conflict を URL パラメータで明示しないと 409 になる
          await sbFetch(
            '/price_snapshots?on_conflict=product_id,platform,snapshot_date',
            'POST',
            rows,
            { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
          );
        }

        log.push({ product: product.name, listings: listings.length, snapshots: rows.length, ok: true });
      } catch (err) {
        log.push({ product: product.name, ok: false, error: err.message });
      }
    }

    return res.status(200).json({
      ok:         true,
      elapsed_ms: Date.now() - startedAt,
      processed:  products.length,
      log,
    });

  } catch (err) {
    console.error('[cron-collect] fatal:', err.message);
    return res.status(500).json({ ok: false, error: err.message, log });
  }
};
