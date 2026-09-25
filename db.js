// ==================================================================
// データストア(PostgreSQL)
// ------------------------------------------------------------------
// これまでこのアプリは data/*.json ファイルに直接読み書きしていたが、Renderの
// 無料プラン(および Persistent Disk を付けていない有料プラン)ではディスクが
// 一時的(ephemeral)で、再デプロイ・再起動のたびに消えてしまう。有料掲載
// (10π/2ヶ月)のデータが再デプロイで失われるのを避けるため、PostgreSQLに
// データを永続化する構成に変更した。RenderのFree PostgreSQLを使えば、
// Webサービス自体は無料プランのままで運用できる(README参照)。
//
// 移行を最小リスクで行うため、各レコードは「完全なオブジェクトをそのまま
// JSONB列に保存する」方式にしている(companies/newsの形はJSONファイル時代と
// 同一)。status・category・listing_end・created_at だけは検索・絞り込み用に
// 実カラムとしても複製している。これにより、フロントエンド(public/*.html)側の
// コードは一切変更せずに済んでいる。
// ==================================================================
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL が設定されていません(.envを確認してください)。' +
      'RenderのFree PostgreSQLを追加し、その内部接続文字列を DATABASE_URL に設定してください。'
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // マネージドPostgres(Render等)は自己署名に近い証明書チェーンを使うことが多いため、
      // SSL自体は有効にしつつ証明書検証は緩めている。ローカルの非SSL Postgresを使う場合は
      // .envで DATABASE_SSL=false を設定するとSSLなしで接続できる。
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function initSchema() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      listing_end TIMESTAMPTZ,
      data JSONB NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_companies_category ON companies(category);`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS news_cache (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL
    );
  `);
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ==================================================================
// Companies
// ==================================================================
async function getAllCompanies() {
  const p = getPool();
  const { rows } = await p.query('SELECT data FROM companies ORDER BY created_at DESC');
  return rows.map((r) => r.data);
}

async function getActiveCompanies(category) {
  const p = getPool();
  const now = new Date().toISOString();
  const params = [now];
  let sql = `SELECT data FROM companies WHERE status = 'active' AND listing_end IS NOT NULL AND listing_end > $1`;
  if (category) {
    params.push(category);
    sql += ' AND category = $2';
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await p.query(sql, params);
  return rows.map((r) => r.data);
}

async function getCompanyById(id) {
  const p = getPool();
  const { rows } = await p.query('SELECT data FROM companies WHERE id = $1', [id]);
  return rows[0] ? rows[0].data : null;
}

// 同じPi支払いIDが、意図しない別の掲載に使い回されていないかを確認するために使う
// (支払い検証の一部)。通常は0〜1件だが、不正利用の検出のため全件返す。
async function findCompanyByPaymentId(paymentId) {
  const p = getPool();
  const { rows } = await p.query(`SELECT data FROM companies WHERE data->>'paymentId' = $1`, [paymentId]);
  return rows.map((r) => r.data);
}

async function insertCompany(listing) {
  const p = getPool();
  await p.query(
    `INSERT INTO companies (id, status, category, created_at, listing_end, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [listing.id, listing.status, listing.category, listing.createdAt, listing.listingEnd, JSON.stringify(listing)]
  );
  return listing;
}

// idで1件をロックして読み込み、patchFn(listing) で書き換えてから保存する。
// row-level lock (FOR UPDATE) により、同じ掲載への同時更新が競合しないようにしている
// (JSONファイル時代の書き込みキューに代わる、DBネイティブな排他制御)。
async function patchCompany(id, patchFn) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM companies WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const listing = rows[0].data;
    patchFn(listing);
    await client.query(
      `UPDATE companies SET status = $2, category = $3, listing_end = $4, data = $5 WHERE id = $1`,
      [id, listing.status, listing.category, listing.listingEnd, JSON.stringify(listing)]
    );
    await client.query('COMMIT');
    return listing;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function setCompanyStatus(id, status) {
  return patchCompany(id, (listing) => {
    listing.status = status;
  });
}

async function deleteCompany(id) {
  const p = getPool();
  const { rowCount } = await p.query('DELETE FROM companies WHERE id = $1', [id]);
  return rowCount > 0;
}

// 期限切れactiveをexpiredに、支払われないまま放置されたpending_paymentを削除する
async function runMaintenance(pendingTtlHours) {
  const p = getPool();
  const now = new Date();
  await p.query(
    `UPDATE companies
     SET status = 'expired', data = jsonb_set(data, '{status}', '"expired"')
     WHERE status = 'active' AND listing_end IS NOT NULL AND listing_end <= $1`,
    [now.toISOString()]
  );
  const cutoff = new Date(now.getTime() - pendingTtlHours * 60 * 60 * 1000).toISOString();
  await p.query(
    `DELETE FROM companies WHERE status = 'pending_payment' AND created_at < $1`,
    [cutoff]
  );
}

// ==================================================================
// News (1行だけのキャッシュ)
// ==================================================================
async function getNews() {
  const p = getPool();
  const { rows } = await p.query('SELECT data FROM news_cache WHERE id = 1');
  return rows[0] ? rows[0].data : { lastUpdated: null, nextScheduledUpdate: null, articles: [] };
}

async function setNews(payload) {
  const p = getPool();
  await p.query(
    `INSERT INTO news_cache (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(payload)]
  );
  return payload;
}

module.exports = {
  initSchema,
  closePool,
  getAllCompanies,
  getActiveCompanies,
  getCompanyById,
  findCompanyByPaymentId,
  insertCompany,
  patchCompany,
  setCompanyStatus,
  deleteCompany,
  runMaintenance,
  getNews,
  setNews,
};
