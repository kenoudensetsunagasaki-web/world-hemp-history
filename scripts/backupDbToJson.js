// ==================================================================
// PostgreSQL → data/*.json への手動バックアップスクリプト
// ------------------------------------------------------------------
// RenderのFree PostgreSQLはバックアップ機能が無く、作成から30日+14日の猶予期間を
// 過ぎると自動的にデータが完全削除される(2026年9月時点の仕様)。有料プランへの
// 切り替え(このアプリの場合、オープンメインネット移行のタイミングを予定)までの
// 間は、このスクリプトで定期的に(できれば1〜2週間に一度)DBの内容を手元のファイルに
// 書き出し、そのファイル自体は git 等、別の場所にも保存しておくことを推奨する。
//
// 使い方:
//   1. .env の DATABASE_URL が本番DBを指していることを確認する
//      (別のDBに向けて誤って上書きしないよう注意)
//   2. npm run backup
//   3. 書き出された data/companies.json / data/news.json を、Gitリポジトリへの
//      コミットやクラウドストレージへのコピーなど、DBとは別の場所に保存する
//
// 万一データが消えてしまった場合は、このバックアップファイルを
// `npm run migrate` で新しいDBに読み込むことで復元できる。
// ==================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL が設定されていません(.envを確認してください)');
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const companies = await db.getAllCompanies();
  writeJsonAtomic(COMPANIES_FILE, companies);
  console.log(`DB → companies.json: ${companies.length}件を書き出しました (${COMPANIES_FILE})`);

  const news = await db.getNews();
  writeJsonAtomic(NEWS_FILE, news);
  console.log(`DB → news.json: 記事${(news.articles || []).length}件を書き出しました (${NEWS_FILE})`);

  console.log('\n忘れずに、この2つのファイルをDBとは別の場所(Gitリポジトリなど)にも保存してください。');
}

main()
  .catch((e) => {
    console.error('バックアップに失敗しました:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.closePool());
