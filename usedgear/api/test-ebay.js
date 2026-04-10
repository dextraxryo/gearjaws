/**
 * /api/test-ebay.js  —  eBay API デバッグ用（本番では削除予定）
 * GET /api/test-ebay?q=neve+1073
 * eBay Finding API の生レスポンスを返す
 */
const EBAY_FINDING_BASE = 'https://svcs.ebay.com/services/search/FindingService/v1';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const query  = (req.query.q ?? 'neve 1073').trim();
  const appId  = process.env.EBAY_APP_ID;

  if (!appId) return res.status(200).json({ error: 'EBAY_APP_ID not set' });

  const results = {};

  for (const op of ['findCompletedItems', 'findItemsAdvanced']) {
    const sortOrder = op === 'findCompletedItems' ? 'EndTimeSoonest' : 'StartTimeNewest';
    const url = `${EBAY_FINDING_BASE}` +
      `?OPERATION-NAME=${op}` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${encodeURIComponent(appId)}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&keywords=${encodeURIComponent(query)}` +
      `&paginationInput.entriesPerPage=3` +
      `&sortOrder=${sortOrder}`;

    try {
      const r = await fetch(url);
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }

      const respKey = op === 'findCompletedItems'
        ? 'findCompletedItemsResponse'
        : 'findItemsAdvancedResponse';

      results[op] = {
        status: r.status,
        itemCount: json?.[respKey]?.[0]?.searchResult?.[0]?.['@count'] ?? 'N/A',
        ack: json?.[respKey]?.[0]?.ack?.[0] ?? 'N/A',
        errorMessage: json?.[respKey]?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0] ?? null,
        firstTitle: json?.[respKey]?.[0]?.searchResult?.[0]?.item?.[0]?.title?.[0] ?? null,
      };
    } catch (e) {
      results[op] = { error: e.message };
    }
  }

  return res.status(200).json({ query, appIdPrefix: appId.slice(0, 15) + '...', results });
};
