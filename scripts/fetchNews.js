require('dotenv').config();
const fetch = require('node-fetch');
const db = require('../db');

// 産業用ヘンプに関連するキーワード。嗜好用大麻のニュースをできるだけ除外するため、
// 産業用途(繊維・建材・バイオ素材など)に寄せたクエリにしている。
// 注意: NewsData.ioの無料プランは検索クエリ(q)が最大100文字まで。超えると
// 422 UNPROCESSABLE ENTITY エラーになるので、100文字以内に収めること。
const QUERY = '"industrial hemp" OR hempcrete OR "hemp fiber" OR "hemp textile" OR "hemp plastic"';

// UIが対応する言語(英語は原文なので翻訳対象から除く)
const TARGET_LANGS = ['ja', 'zh', 'ko', 'es'];

// MyMemory Translation API (https://mymemory.translated.net/) は無料・APIキー不要。
// 匿名利用で1日5,000文字、TRANSLATE_EMAILを設定すると1日50,000文字まで無料枠が
// 増える(クレジットカード登録は不要)。有料の翻訳APIを使わずに済ませるための選択。
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';

async function translateText(text, targetLang) {
  if (!text) return '';
  const email = process.env.TRANSLATE_EMAIL; // 任意。設定すると無料枠が10倍になる
  const params = new URLSearchParams({
    q: text,
    langpair: `en|${targetLang}`,
  });
  if (email) params.set('de', email);

  const res = await fetch(`${MYMEMORY_ENDPOINT}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`MyMemory API error: ${res.status}`);
  }
  const data = await res.json();
  if (data.responseStatus && data.responseStatus !== 200) {
    throw new Error(`MyMemory translation failed: ${JSON.stringify(data.responseDetails || data)}`);
  }
  return data.responseData ? data.responseData.translatedText : text;
}

async function translateArticle(article) {
  const i18n = { en: { title: article.title, description: article.description || '' } };
  for (const lang of TARGET_LANGS) {
    try {
      const [title, description] = await Promise.all([
        translateText(article.title, lang),
        translateText(article.description || '', lang),
      ]);
      i18n[lang] = { title, description };
    } catch (e) {
      // 翻訳に失敗した場合は英語原文にフォールバックする(記事自体は表示され続ける)
      console.warn(`[translate] ${lang} failed for "${article.title}":`, e.message);
      i18n[lang] = { title: article.title, description: article.description || '' };
    }
  }
  return i18n;
}

// 1回の更新で取得する記事数。MyMemory Translation APIの無料枠(匿名: 1日5,000文字、
// TRANSLATE_EMAIL設定時: 1日50,000文字)を踏まえた上限。記事1件はタイトル+概要で
// およそ150〜250文字、それを4言語(ja/zh/ko/es)に翻訳するので、1件あたり約
// 600〜1,000文字を消費する計算になる。8件なら約4,800〜8,000文字となり、
// TRANSLATE_EMAIL未設定(匿名5,000文字/日)だとこれだけでも上限に近い/超える
// 可能性があるため、TRANSLATE_EMAILの設定を強く推奨する(下の警告ログ参照)。
const ARTICLES_PER_FETCH = 8;

// 嗜好用大麻・THC関連の記事を除外するための語句(タイトル・概要に含まれていたら除外)。
// 検索クエリは無料プランの100文字制限があり除外条件を入れる余地が無いため、取得後に絞り込む。
const EXCLUDE_PATTERN = /\b(thc|marijuana|cannabis|dispensar\w*|delta-?\d|recreational|weed|psychoactive)\b/i;

// 同じ記事が複数のテレビ局サイト等で配信されていることがあるため、タイトルで重複を除く。
function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function selectArticles(results) {
  const seen = new Set();
  const out = [];
  for (const a of results) {
    if (!a || !a.title || !a.link) continue;
    if (EXCLUDE_PATTERN.test(`${a.title} ${a.description || ''}`)) continue;
    const key = normalizeTitle(a.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

async function fetchAndStoreNews() {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) {
    throw new Error('NEWSDATA_API_KEY が設定されていません(.env を確認してください)');
  }
  // このスクリプトは server.js を経由せず単独実行される場合もあるため
  // (npm run fetch-news など)、念のためここでもスキーマ作成を試みておく
  // (CREATE TABLE IF NOT EXISTS なので既に存在していれば何もしない)。
  await db.initSchema();
  if (!process.env.TRANSLATE_EMAIL) {
    console.warn(
      '[translate] 警告: TRANSLATE_EMAIL が未設定です。MyMemory Translation APIの匿名利用枠(1日5,000文字)は、' +
      `記事${ARTICLES_PER_FETCH}件を4言語に翻訳する1回の更新だけでほぼ使い切ってしまう可能性があります。` +
      '翻訳が上限に達すると該当言語の記事は英語原文にフォールバックされます(処理自体は止まりません)。' +
      '.envにTRANSLATE_EMAILを設定すると無料枠が1日50,000文字に拡大されます。'
    );
  }

  const url = `https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(QUERY)}&language=en`;
  const res = await fetch(url);
  if (!res.ok) {
    // NewsData.ioは失敗時に原因(例: クエリが長すぎる、パラメータ不正)をJSONで返すので、
    // 切り分けできるよう本文も一緒にエラーに含める(APIキーはURLにのみ含まれ本文には出ない)。
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
    throw new Error(`NewsData.io API error: ${res.status} ${res.statusText} ${detail}`);
  }
  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(`NewsData.io returned error: ${JSON.stringify(data)}`);
  }

  const rawArticles = selectArticles(data.results || []).slice(0, ARTICLES_PER_FETCH).map((a) => ({
    title: a.title,
    description: a.description,
    url: a.link,
    source: a.source_id,
    publishedAt: a.pubDate,
    imageUrl: a.image_url || null,
  }));

  if (rawArticles.length === 0) {
    // 絞り込みの結果0件になった場合に、既存の記事を空で上書きしてしまわないようにする
    throw new Error('条件に合う記事がありませんでした(既存のニュースはそのまま残しています)');
  }

  // 記事ごとに ja/zh/ko/es へ自動翻訳し、結果をキャッシュに保存しておく。
  // (取得のたびに翻訳し直さないよう、翻訳結果も news.json に永続化する)
  const articles = [];
  for (const article of rawArticles) {
    const i18n = await translateArticle(article);
    articles.push({ ...article, i18n });
  }

  const intervalDays = parseInt(process.env.NEWS_FETCH_INTERVAL_DAYS || '3', 10);
  const now = new Date();
  const next = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);

  const payload = {
    lastUpdated: now.toISOString(),
    nextScheduledUpdate: next.toISOString(),
    articles,
  };

  await db.setNews(payload);
  return payload;
}

module.exports = { fetchAndStoreNews };

if (require.main === module) {
  fetchAndStoreNews()
    .then((n) => console.log(`ニュース取得・翻訳完了: ${n.articles.length}件 (次回更新予定: ${n.nextScheduledUpdate})`))
    .catch((e) => {
      console.error('ニュース取得に失敗しました:', e.message);
      process.exit(1);
    })
    .finally(() => db.closePool());
}
