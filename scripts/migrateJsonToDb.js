// ==================================================================
// data/*.json → PostgreSQL への一度きりの移行スクリプト
// ------------------------------------------------------------------
// 旧バージョン(JSONファイル方式)で既に動かしていた環境で、掲載データや
// ニュースキャッシュを新しいDB方式に引き継ぎたい場合に使う。
//
// 使い方:
//   1. .env に DATABASE_URL を設定する
//   2. Renderで運用中だった場合は、旧データ(data/companies.json など)を
//      Renderのシェル機能等で事前にダウンロードし、このプロジェクトの
//      data/ フォルダに上書き保存しておく(再デプロイすると消えるため、
//      再デプロイ *前* に必ず取得すること)
//   3. npm run migrate
//
// 既にDB側にIDが存在する掲載はスキップされるため、複数回実行しても安全。
// ==================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const COMPANIES_FILE = path.join(__dirname, '..', 'data', 'companies.json');
const NEWS_FILE = path.join(__dirname, '..', 'data', 'news.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL が設定されていません(.envを確認してください)');
  }
  await db.initSchema();

  const companies = readJson(COMPANIES_FILE, []);
  let migrated = 0;
  let skipped = 0;
  for (const listing of companies) {
    const existing = await db.getCompanyById(listing.id);
    if (existing) {
      skipped++;
      continue;
    }
    await db.insertCompany(listing);
    migrated++;
  }
  console.log(`companies.json → DB: ${migrated}件を移行しました(スキップ${skipped}件、全${companies.length}件中)`);

  const news = readJson(NEWS_FILE, null);
  if (news && news.articles) {
    await db.setNews(news);
    console.log(`news.json → DB: 記事${news.articles.length}件を移行しました`);
  } else {
    console.log('news.json が見つからない、または空のため、ニュースの移行はスキップしました');
  }
}

main()
  .catch((e) => {
    console.error('移行に失敗しました:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.closePool());
