/**
 * /api/log-search.js  -  GearJaws v0.3 Session C
 * 検索ログを Supabase の search_logs テーブルに記録する Vercel Serverless Function
 *
 * POST /api/log-search
 * Body (JSON): {
 *   query: string,         // 検索キーワード（原文）
 *   resultCount: number,   // 結果件数
 *   dataSource: string,    // 'reverb_api' | 'mock_db' | 'no_match'
 *   lang: string,          // 'ja' | 'en'
 *   platformsSearched: string[]
 * }
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// クエリを正規化（小文字・全角スペース除去・前後トリム）
function normalizeQuery(q) {
  return q.toLowerCase().replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
}

// SHA-256 風の簡易ハッシュ（User-Agent の個人特定防止用 / 外部依存なし）
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(2).slice(0, 16);
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Supabase 未設定の場合は静かに成功を返す（フロントエンドをブロックしない）
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_supabase_config' });
  }

  const {
    query          = '',
    resultCount    = 0,
    dataSource     = 'unknown',
    lang           = 'ja',
    platformsSearched = [],
  } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query is required' });
  }

  // ── メタ情報を収集 ──────────────────────────────────────
  const userAgentRaw = req.headers['user-agent'] || '';
  const userAgentHash = hashString(userAgentRaw).slice(0, 16);

  // CloudFlare 経由の国コード（Vercel でも利用可能）
  const ipCountry = (req.headers['cf-ipcountry'] || '').slice(0, 2).toUpperCase() || null;

  // ── Supabase REST API に INSERT ────────────────────────
  const payload = {
    query,
    normalized_query:   normalizeQuery(query),
    result_count:       resultCount,
    data_source:        dataSource,
    platforms_searched: platformsSearched,
    lang,
    ip_country:         ipCountry || null,
    user_agent_hash:    userAgentHash,
  };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/search_logs`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer':        'return=minimal',  // 挿入結果を返さない（高速化）
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[log-search] Supabase error:', response.status, errText);
      // ログ失敗はフロントに影響させない → 200 を返す
      return res.status(200).json({ ok: false, error: errText });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[log-search] fetch error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
