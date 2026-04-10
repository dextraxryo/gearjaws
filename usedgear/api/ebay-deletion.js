/**
 * /api/ebay-deletion.js
 * eBay Marketplace Account Deletion/Closure Notification Endpoint
 *
 * eBay の GDPR 対応要件：ユーザーアカウント削除通知を受け取るエンドポイント
 * GearJaws はユーザーデータを保存しないため、通知を受け取って 200 を返すのみ
 *
 * GET  /api/ebay-deletion?challenge_code=xxx  → challengeResponse を返す
 * POST /api/ebay-deletion                     → 削除通知を受け取り 200 を返す
 *
 * 設定方法:
 * 1. EBAY_DELETION_TOKEN を Vercel 環境変数に設定（任意の文字列 20 文字以上）
 * 2. eBay Developer Console → Alerts → Marketplace account deletion
 *    Notification URL: https://gearjaws.vercel.app/api/ebay-deletion
 *    Verification token: EBAY_DELETION_TOKEN と同じ値
 */

const crypto = require('crypto');

const ENDPOINT_URL      = 'https://gearjaws.vercel.app/api/ebay-deletion';
const VERIFICATION_TOKEN = process.env.EBAY_DELETION_TOKEN || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── GET: eBay からの検証チャレンジに応答 ──────────────────────
  if (req.method === 'GET') {
    const challengeCode = req.query.challenge_code;

    if (!challengeCode) {
      return res.status(200).json({ status: 'GearJaws eBay deletion endpoint is active' });
    }

    if (!VERIFICATION_TOKEN) {
      console.error('[ebay-deletion] EBAY_DELETION_TOKEN is not set');
      return res.status(500).json({ error: 'Verification token not configured' });
    }

    // challengeResponse = SHA-256(challengeCode + verificationToken + endpointUrl)
    const hash = crypto
      .createHash('sha256')
      .update(challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL)
      .digest('hex');

    return res.status(200).json({ challengeResponse: hash });
  }

  // ── POST: アカウント削除通知を受信（GearJaws はユーザーデータ非保持のため無視） ──
  if (req.method === 'POST') {
    // 本来はここで Supabase からユーザーデータを削除するが、
    // GearJaws v0.3 はユーザーアカウント機能なし → ログのみ記録して 200 を返す
    const body = req.body;
    console.info('[ebay-deletion] Received account deletion notification:', JSON.stringify(body));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
