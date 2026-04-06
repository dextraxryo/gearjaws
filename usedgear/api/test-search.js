#!/usr/bin/env node
// ============================================================
// GearJaws — api/test-search.js
// ローカルで /api/search.js の動作確認をするスクリプト
//
// 使い方:
//   REVERB_API_KEY=your_token_here node api/test-search.js "neve 1073"
//
// または .env ファイルに書いた後:
//   node -r dotenv/config api/test-search.js "neve 1073"
// ============================================================

const query = process.argv[2] || 'neve 1073';
const apiKey = process.env.REVERB_API_KEY;

if (!apiKey) {
  console.error('❌ REVERB_API_KEY が設定されていません。');
  console.error('   実行例: REVERB_API_KEY=xxxxx node api/test-search.js "neve 1073"');
  process.exit(1);
}

const USD_RATE = 150;

const REVERB_CONDITION_MAP = {
  'Brand New': '新品同様', 'Mint': '新品同様', 'Near Mint': '新品同様',
  'Excellent Plus': '良好', 'Excellent': '良好',
  'Very Good Plus': '良好', 'Very Good': '良好',
  'Good': '普通', 'Fair': '普通',
  'Poor': 'ジャンク', 'Non Functioning': 'ジャンク', 'B-Stock': '普通',
};

function normalizeCondition(d) { return REVERB_CONDITION_MAP[d] || '普通'; }
function normalizeStatus(s)    { return s === 'sold' ? 'sold' : s === 'live' ? 'listing' : 'ended'; }

function normalizeListing(l) {
  const rawPrice = parseFloat(l.price?.amount ?? 0);
  const currency = (l.price?.currency ?? 'USD').toUpperCase();
  return {
    platform:  'Reverb',
    title:     l.title ?? '',
    currency,
    priceJPY:  currency === 'USD' ? Math.round(rawPrice * USD_RATE) : Math.round(rawPrice),
    priceUSD:  currency === 'USD' ? rawPrice : Math.round(rawPrice / USD_RATE),
    condition: normalizeCondition(l.condition?.display_name),
    status:    normalizeStatus(l.state?.slug),
    date:      (l.published_at ?? '').slice(0, 10),
    url:       l._links?.web?.href ?? '',
  };
}

async function run() {
  console.log(`\n🔍 検索クエリ: "${query}"\n`);
  const headers = {
    'Authorization':  `Bearer ${apiKey}`,
    'Accept':         'application/hal+json',
    'Accept-Version': '3.0',
    'Content-Type':   'application/hal+json',
  };
  const params = new URLSearchParams({ query, per_page: '20' });

  for (const state of ['sold', 'live']) {
    const url = `https://api.reverb.com/api/listings/all?${params}&state[]=${state}`;
    process.stdout.write(`  Reverb [${state}] ... `);
    const res = await fetch(url, { headers });
    if (!res.ok) { console.log(`❌ ${res.status} ${res.statusText}`); continue; }
    const data = await res.json();
    const items = (data.listings ?? []).map(normalizeListing);
    console.log(`✅ ${items.length}件`);
    if (items.length > 0) {
      items.slice(0, 3).forEach((r, i) => {
        console.log(`     ${i+1}. [${r.status}] ${r.title.slice(0, 50)}`);
        console.log(`        ¥${r.priceJPY.toLocaleString()} / $${r.priceUSD.toLocaleString()} | ${r.condition} | ${r.date}`);
        console.log(`        ${r.url}`);
      });
      if (items.length > 3) console.log(`     ... 他 ${items.length - 3}件`);
    }
    console.log();
  }
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
