/**
 * /api/price-history.js  —  GearJaws v1.0 Session F
 * price_snapshots から価格トレンドデータを返す
 *
 * GET /api/price-history?q=neve+1073&days=60&platform=all
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Supabase → ${res.status}: ${await res.text()}`);
  return res.json();
}

function dateBefore(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const query    = (req.query.q ?? '').trim().toLowerCase();
  const days     = Math.min(Math.max(parseInt(req.query.days ?? '60', 10), 7), 180);
  const platform = req.query.platform ?? 'all';

  if (!query) return res.status(400).json({ error: 'q required' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ history: [], message: 'Supabase not configured' });
  }

  try {
    // 対応 product を検索
    const qEnc     = encodeURIComponent(query);
    const products = await sbFetch(`/products?or=(name.ilike.*${qEnc}*,aliases.cs.%7B${qEnc}%7D)&select=id,name&limit=1`);
    const product  = products[0] ?? null;

    const since = dateBefore(days);

    let snapshotPath;
    if (product) {
      snapshotPath = `/price_snapshots`
        + `?product_id=eq.${product.id}`
        + `&platform=eq.${encodeURIComponent(platform)}`
        + `&snapshot_date=gte.${since}`
        + `&order=snapshot_date.asc`
        + `&select=snapshot_date,avg_price_jpy,min_price_jpy,max_price_jpy,med_price_jpy,listing_count`;
    } else {
      // products に登録がない機材はクエリ文字列で直接照合
      snapshotPath = `/price_snapshots`
        + `?query=ilike.*${qEnc}*`
        + `&platform=eq.${encodeURIComponent(platform)}`
        + `&snapshot_date=gte.${since}`
        + `&order=snapshot_date.asc`
        + `&select=snapshot_date,avg_price_jpy,min_price_jpy,max_price_jpy,med_price_jpy,listing_count`;
    }

    const history = await sbFetch(snapshotPath);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      query,
      platform,
      days,
      product_name:  product?.name ?? null,
      data_points:   history.length,
      history,
    });

  } catch (err) {
    console.error('[price-history] error:', err.message);
    return res.status(200).json({ history: [], error: err.message });
  }
};
