require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const db = require('./db');
const { fetchAndStoreNews } = require('./scripts/fetchNews');
const { createPiAuth } = require('./piAuth');
const piAuth = createPiAuth();

const app = express();
// Renderのようなリバースプロキシの背後で動く場合、req.ip が正しいクライアントIPを
// 返すようにするために必要(レート制限をIP単位で行うため)。
app.set('trust proxy', true);
app.use(express.json());

// ==================================================================
// セキュリティヘッダー
// ------------------------------------------------------------------
// helmet等の外部ライブラリを追加せず、最低限のセキュリティヘッダーを手動で
// 付与している。このアプリは public/*.html が単一ファイル内にインラインの
// <script> を持つ構成のため、script-src を 'self' のみに絞ると動作しなくなる。
// そのため 'unsafe-inline' を許容せざるを得ず、CSPによるXSS対策としては限定的
// である点に注意(XSS対策の本体は各ページ内のHTMLエスケープ・URLスキーム検証)。
// ==================================================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options は付けない: Pi Browser / Sandbox はアプリを iframe 内で表示するため、
  // DENY だと ERR_BLOCKED_BY_RESPONSE で開けなくなる。許可する親は CSP の frame-ancestors で絞る。
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://sdk.minepi.com https://*.minepi.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: https:; " +
      "connect-src 'self' https://socialchain.app https://api.minepi.com https://*.minepi.com; " +
      "frame-src https://*.minepi.com https://*.pinet.com; " +
      "frame-ancestors 'self' https://*.minepi.com https://*.pinet.com"
  );
  next();
});

// ==================================================================
// 簡易レート制限(IPアドレス単位・固定ウィンドウ)
// ------------------------------------------------------------------
// express-rate-limit 等の外部ライブラリを追加せずに済む最小限の実装。
// メモリ上にIPごとのカウンタを保持するだけなので、サーバー再起動でリセットされ、
// 複数インスタンス構成では共有されない(その場合はRedis等のストアが必要)。
// このアプリの規模ではスパム・総当たり対策として十分な水準と判断している。
// ==================================================================
function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: message || 'リクエストが多すぎます。しばらくしてから再度お試しください。' });
    }
    next();
  };
}
const listingCreateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: '掲載申込みが多すぎます。しばらくしてから再度お試しください。' });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: '管理APIへのリクエストが多すぎます。しばらくしてから再度お試しください。' });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', async (req, res) => {
  try {
    if (process.env.DATABASE_URL) {
      await db.getNews(); // DB疎通確認を兼ねる(軽量なSELECT)
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const LISTING_PRICE_PI = 10;
const LISTING_DURATION_DAYS = 60; // 2ヶ月
const PENDING_TTL_HOURS = 24; // 支払いが完了しないまま放置された申込みを自動削除するまでの猶予時間

const CATEGORIES = [
  { id: 'textile', label: '繊維・アパレル' },
  { id: 'food', label: '食品(種子・オイル・プロテイン)' },
  { id: 'construction', label: '建材(ヘンプクリート等)' },
  { id: 'cosmetics', label: '化粧品・スキンケア' },
  { id: 'cbd_wellness', label: 'CBD・ウェルネス製品' },
  { id: 'bioplastic', label: 'バイオプラスチック・工業素材' },
];

// ==================================================================
// News
// ==================================================================
app.get('/api/news', async (req, res) => {
  try {
    const news = await db.getNews();
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 管理者が手動でニュースを更新するためのエンドポイント(x-admin-token ヘッダーが必要)
app.post('/api/news/refresh', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const news = await fetchAndStoreNews();
    res.json({ ok: true, count: news.articles.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================================================================
// Categories / Config
// ==================================================================
app.get('/api/categories', (req, res) => {
  res.json(CATEGORIES);
});

// フロントエンドがPi.init()に渡すsandboxフラグをここから取得する。
// PI_SANDBOX を明示的に "false" にしない限り、常に安全側(sandbox: true)で動作する。
// これにより、本番でPiの決済を有効化する際もコードを一切編集せず、
// .envの PI_SANDBOX=false を設定してデプロイし直すだけで切り替えられる。
app.get('/api/config', (req, res) => {
  res.json({ sandbox: process.env.PI_SANDBOX !== 'false' });
});

// ==================================================================
// Companies / Product listings
// ==================================================================
function isSafeUrl(url) {
  // 未入力(任意項目)は許容する。入力がある場合は http/https のみ許可し、
  // javascript: のような危険なスキームや不正な値を拒否する。
  if (!url) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

const MAX_LEN = { name: 120, country: 80, description: 1000, website: 300, logoUrl: 300, contactEmail: 200 };
function tooLong(value, key) {
  return typeof value === 'string' && value.length > MAX_LEN[key];
}

// Pi.authenticate() で得た accessToken を App Studio で検証し、このサーバーのセッションを発行する。
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: '認証リクエストが多すぎます。しばらくしてから再度お試しください。' });
app.post('/api/auth/pi', authLimiter, async (req, res) => {
  try {
    const { accessToken } = req.body || {};
    const result = await piAuth.loginWithAccessToken(accessToken);
    res.json(result);
  } catch (e) {
    console.warn('[auth/pi] failed:', e.message);
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.get('/api/companies', async (req, res) => {
  try {
    const { category } = req.query;
    const active = await db.getActiveCompanies(category || null);
    res.json(active);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/companies', listingCreateLimiter, async (req, res) => {
  const { name, category, country, description, website, logoUrl, contactEmail } = req.body || {};
  if (!name || !category || !description) {
    return res.status(400).json({ error: 'name, category, description は必須です' });
  }
  if (!CATEGORIES.find((c) => c.id === category)) {
    return res.status(400).json({ error: '不正なカテゴリーです' });
  }
  if (
    tooLong(name, 'name') || tooLong(country, 'country') || tooLong(description, 'description') ||
    tooLong(website, 'website') || tooLong(logoUrl, 'logoUrl') || tooLong(contactEmail, 'contactEmail')
  ) {
    return res.status(400).json({ error: '入力内容が長すぎます' });
  }
  if (!isSafeUrl(website)) {
    return res.status(400).json({ error: 'ウェブサイトURLはhttp(s)形式で入力してください' });
  }
  if (!isSafeUrl(logoUrl)) {
    return res.status(400).json({ error: 'ロゴ画像URLはhttp(s)形式で入力してください' });
  }

  // 申込者のPiユーザーを記録しておく(後の支払い検証で「申し込んだ人」と
  // 「支払った人」が同一Piユーザーであることを確認するために使う)。
  // ブラウザが自己申告する uid / username は使わず、/api/auth/pi で App Studio により
  // 検証済みのセッション(X-Pi-Session ヘッダー)から得た uid / username だけを保存する。
  const session = piAuth.getSession(req.get('x-pi-session'));
  if (!session) {
    return res.status(401).json({ error: 'Piでのサインインが必要です。サインインしてからもう一度お試しください。' });
  }
  const creatorUid = session.uid;
  const creatorUsername = session.username;

  const listing = {
    id: uuidv4(),
    name,
    category,
    country: country || '',
    description,
    website: website || '',
    logoUrl: logoUrl || '',
    contactEmail: contactEmail || '',
    status: 'pending_payment',
    priceP: LISTING_PRICE_PI,
    createdAt: new Date().toISOString(),
    listingStart: null,
    listingEnd: null,
    paymentId: null,
    creatorUid,
    creatorUsername,
  };

  try {
    await db.insertCompany(listing);
    res.json({ listingId: listing.id, priceP: LISTING_PRICE_PI });
  } catch (e) {
    console.error('[companies/create] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================================================================
// Pi payment approval / completion
// ------------------------------------------------------------------
// Pi SDKの仕様上、支払いはクライアントで開始し、サーバー側で
// Pi Platform API (https://api.minepi.com/v2) に対して approve → complete を
// 呼び出す必要がある。PI_API_KEY が未設定の場合はエラーを返す(スタブ動作には戻さない)。
// ==================================================================
const PI_PLATFORM_BASE = 'https://api.minepi.com/v2';

async function piApiRequest(pathSuffix, options = {}) {
  if (!process.env.PI_API_KEY) {
    throw new Error('PI_API_KEY が設定されていません(.envを確認してください)');
  }
  const res = await fetch(`${PI_PLATFORM_BASE}${pathSuffix}`, {
    ...options,
    headers: {
      Authorization: `Key ${process.env.PI_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Pi Platform API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// ==================================================================
// 支払い内容の検証
// ------------------------------------------------------------------
// これまでは、クライアントが送ってきた paymentId / listingId をそのまま信用して
// approve/completeを呼んでいた。これだと理論上、①ある支払いを本来と別の
// listingIdに使い回す、②支払い金額が期待値と異なる、といった不正が可能だった。
// このため approve/complete の前に、Pi Platform API から実際の支払い内容
// (GET /payments/{id})を取得し、以下を確認してから処理を進めるようにしている。
//   1. 金額が LISTING_PRICE_PI と一致するか
//   2. metadata.listingId が、リクエストで指定されたlistingIdと一致するか
//   3. この paymentId が、他のlistingIdで既に使われていないか(使い回し防止)
//   4. (掲載作成時にPi認証済みの場合)支払った人(payment.user_uid)が
//      申し込んだ人(listing.creatorUid)と同一Piユーザーであるか
// creatorUidが無い掲載(Pi認証トークンの検証に失敗した場合)については、
// 4のみスキップする(1〜3は必ず検証する)。
// ==================================================================
async function verifyPiPayment(paymentId, listing) {
  const payment = await piApiRequest(`/payments/${paymentId}`, { method: 'GET' });

  const paidAmount = Number(payment.amount);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - LISTING_PRICE_PI) > 1e-6) {
    throw new Error(`支払い金額が一致しません(期待値: ${LISTING_PRICE_PI}π, 実際: ${payment.amount}π)`);
  }
  if (!payment.metadata || payment.metadata.listingId !== listing.id) {
    throw new Error('この支払いは指定された掲載のものではありません(metadata不一致)');
  }
  const otherUses = await db.findCompanyByPaymentId(paymentId);
  if (otherUses.some((c) => c.id !== listing.id)) {
    throw new Error('この支払いは既に別の掲載で使用されています');
  }
  if (listing.creatorUid && payment.user_uid && payment.user_uid !== listing.creatorUid) {
    throw new Error('この支払いを行ったPiユーザーは、この掲載を申し込んだユーザーと一致しません');
  }
  return payment;
}

app.post('/api/payments/approve', async (req, res) => {
  const { paymentId, listingId } = req.body || {};
  if (!paymentId || !listingId) {
    return res.status(400).json({ error: 'paymentId, listingId は必須です' });
  }
  try {
    const listing = await db.getCompanyById(listingId);
    if (!listing) {
      return res.status(404).json({ error: '該当する掲載が見つかりません' });
    }
    if (listing.status !== 'pending_payment') {
      return res.status(400).json({ error: 'この掲載は支払い待ち状態ではありません' });
    }
    await verifyPiPayment(paymentId, listing);

    // Pi Platform APIに支払いの承認を要求する。これによりPi Browser側の
    // onReadyForServerApproval が完了し、ユーザーに実際の送金が促される。
    await piApiRequest(`/payments/${paymentId}/approve`, { method: 'POST' });

    await db.patchCompany(listingId, (l) => {
      l.paymentId = paymentId;
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[payments/approve] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/payments/complete', async (req, res) => {
  const { paymentId, txid, listingId } = req.body || {};
  if (!paymentId || !txid || !listingId) {
    return res.status(400).json({ error: 'paymentId, txid, listingId は必須です' });
  }
  try {
    const listing = await db.getCompanyById(listingId);
    if (!listing) {
      return res.status(404).json({ error: '該当する掲載が見つかりません' });
    }
    if (listing.status !== 'pending_payment') {
      return res.status(400).json({ error: 'この掲載は支払い待ち状態ではありません(既に処理済みの可能性があります)' });
    }
    if (listing.paymentId && listing.paymentId !== paymentId) {
      return res.status(400).json({ error: 'approve時と異なる支払いIDです' });
    }
    await verifyPiPayment(paymentId, listing);

    // ブロックチェーン上のトランザクションIDを添えて、Pi Platform APIに支払いの
    // 完了を報告する。これによりPiネットワーク側でも支払いが正式に完了扱いになる。
    await piApiRequest(`/payments/${paymentId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ txid }),
    });

    const updatedListing = await db.patchCompany(listingId, (l) => {
      const now = new Date();
      const end = new Date(now.getTime() + LISTING_DURATION_DAYS * 24 * 60 * 60 * 1000);
      l.status = 'active';
      l.listingStart = now.toISOString();
      l.listingEnd = end.toISOString();
      l.paymentId = paymentId;
      l.txid = txid;
    });
    res.json({ ok: true, listing: updatedListing });
  } catch (e) {
    console.error('[payments/complete] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================================================================
// Admin
// ------------------------------------------------------------------
// 掲載の事前審査フローは無く、支払いが完了すると即座に公開される。この管理APIは、
// 不適切な掲載を後から一覧・停止できるようにするための最低限の運用手段。
// ==================================================================
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// 全ステータス(pending_payment / active / expired / suspended)の掲載を一覧
app.get('/api/admin/companies', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const companies = await db.getAllCompanies();
    res.json(companies);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 掲載のステータスを手動変更(不適切な掲載の停止、誤って期限切れにしたものの復活など)
app.post('/api/admin/companies/:id/status', adminLimiter, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const allowed = ['pending_payment', 'active', 'expired', 'suspended'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status は ${allowed.join(', ')} のいずれかである必要があります` });
  }
  try {
    const updated = await db.setCompanyStatus(id, status);
    if (!updated) return res.status(404).json({ error: '該当する掲載が見つかりません' });
    res.json({ ok: true, listing: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 掲載を完全に削除(スパム・テスト投稿の除去用)
app.delete('/api/admin/companies/:id', adminLimiter, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const removed = await db.deleteCompany(id);
    res.json({ ok: removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================================================================
// メンテナンス(期限切れの自動反映・未払いpendingの自動削除)
// ==================================================================
async function maintainCompanies() {
  await db.runMaintenance(PENDING_TTL_HOURS);
}

// 毎日03:30に、期限切れ掲載のステータス更新と、支払われなかった申込みの掃除を行う
const maintenanceCronTask = cron.schedule('30 3 * * *', () => {
  maintainCompanies().catch((e) => console.error('[maintenance] failed:', e.message));
});

// ==================================================================
// News auto-refresh scheduling
// ==================================================================
const intervalDays = parseInt(process.env.NEWS_FETCH_INTERVAL_DAYS || '3', 10);

// 毎日03:00にチェックし、前回更新から intervalDays 日 経過していれば取得する
const newsCronTask = cron.schedule('0 3 * * *', async () => {
  if (!process.env.NEWSDATA_API_KEY) return;
  try {
    const news = await db.getNews();
    const last = news.lastUpdated ? new Date(news.lastUpdated).getTime() : 0;
    const dueMs = intervalDays * 24 * 60 * 60 * 1000;
    if (Date.now() - last >= dueMs) {
      await fetchAndStoreNews();
      console.log('[cron] news updated');
    }
  } catch (e) {
    console.error('[cron] news fetch failed:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
let httpServer = null;

async function start() {
  if (!process.env.DATABASE_URL) {
    console.warn(
      '[startup] 警告: DATABASE_URL が未設定です。ニュース・企業掲載APIはすべて失敗します。' +
      'RenderのFree PostgreSQLを追加し、接続文字列を .env の DATABASE_URL に設定してください。'
    );
  } else {
    try {
      await db.initSchema();
      console.log('[startup] データベーススキーマを確認/作成しました');
    } catch (e) {
      console.error('[startup] データベース初期化に失敗しました:', e.message);
    }
  }

  httpServer = app.listen(PORT, () => {
    console.log(`World Hemp History server running on port ${PORT}`);
    if (!process.env.PI_API_KEY) {
      console.warn('[startup] 警告: PI_API_KEY が未設定です。Pi決済のapprove/completeは失敗します。');
    }
    if (process.env.PI_SANDBOX !== 'false') {
      console.log('[startup] Pi SDKはsandboxモードで動作します(本番決済を有効にするには .env の PI_SANDBOX=false を設定してください)');
    }
  });

  // 起動時、まだ一度もニュースを取得していなければ即時取得を試みる
  if (process.env.DATABASE_URL && process.env.NEWSDATA_API_KEY) {
    try {
      const news = await db.getNews();
      if (!news.lastUpdated) {
        fetchAndStoreNews()
          .then(() => console.log('[startup] initial news fetch complete'))
          .catch((e) => console.error('[startup] initial news fetch failed:', e.message));
      }
    } catch (e) {
      console.error('[startup] news check failed:', e.message);
    }
  }
}

start();

// ==================================================================
// グレースフルシャットダウン
// ------------------------------------------------------------------
// RenderはデプロイのたびにSIGTERMを送って旧インスタンスを止める。これを無視すると
// 処理中のリクエストが打ち切られたり、DBコネクションプールが行儀悪く残ったりする
// ため、シグナルを受けたら新規リクエストの受付を止め、進行中の処理とDB接続を
// クリーンに終了してからプロセスを終了する。
// ==================================================================
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} を受信しました。終了処理を行います...`);
  try {
    maintenanceCronTask.stop();
    newsCronTask.stop();
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
    await db.closePool();
  } catch (e) {
    console.error('[shutdown] 終了処理中にエラーが発生しました:', e.message);
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
