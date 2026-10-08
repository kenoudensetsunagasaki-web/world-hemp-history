require('dotenv').config();
const fetch = require('node-fetch');
const db = require('../db');

// 産業用ヘンプに関連するキーワード。嗜好用大麻のニュースをできるだけ除外するため、
// 産業用途(繊維・建材・バイオ素材など)に寄せたクエリにしている。
// 注意: NewsData.ioの無料プランは検索クエリ(q)が最大100文字まで。超えると
// 422 UNPROCESSABLE ENTITY エラーになるので、100文字以内に収めること。
// 件数を確保するため、切り口の違うクエリを複数回に分けて検索する(各100文字以内)。
// どれか1つが失敗(422など)しても、他のクエリの結果で処理を続ける。
const QUERIES = [
  '"industrial hemp" OR hempcrete OR "hemp fiber" OR "hemp textile" OR "hemp plastic"',
  'hemp AND (farming OR farmers OR building OR construction OR processing OR fuel)',
];
// 1クエリあたり最大何ページ取得するか(1ページ約10件、1ページ=1クレジット。無料枠は1日200)
const MAX_PAGES_PER_QUERY = 2;
// 保存しておく記事の最大件数(これを超えたら古いものから消える)
const MAX_STORED_ARTICLES = 30;

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
const EXCLUDE_PATTERN = /\b(thc|marijuana|cannabis|dispensar\w*|delta-?\d|recreational|weed|psychoactive|cbd|joint|joints|rolling|smok\w*|vap\w*|pre-?rolls?|bongs?|edibles?|cagr)\b/i;
// 産業用ヘンプと無関係な記事(検索語が本文の一部にしか出てこないもの)を避けるため、
// タイトルか概要に "hemp" が含まれる記事だけを採用する。
const REQUIRE_PATTERN = /hemp/i;

// 同じ記事が複数のテレビ局サイト等で配信されていることがあるため、タイトルで重複を除く。
function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function selectArticles(results) {
  const seen = new Set();
  const out = [];
  for (const a of results) {
    if (!a || !a.title || !a.link) continue;
    const text = `${a.title} ${a.description || ''}`;
    if (!REQUIRE_PATTERN.test(text)) continue;
    if (EXCLUDE_PATTERN.test(text)) continue;
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

  // 複数のクエリ・ページから記事を集める
  const collected = [];
  const errors = [];
  for (const q of QUERIES) {
    let page = null;
    for (let i = 0; i < MAX_PAGES_PER_QUERY; i++) {
      let url = `https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(q)}&language=en`;
      if (page) url += `&page=${encodeURIComponent(page)}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          // NewsData.ioは失敗時に原因をJSONで返すので、切り分けできるよう本文も含める
          let detail = '';
          try { detail = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
          throw new Error(`NewsData.io API error: ${res.status} ${res.statusText} ${detail}`);
        }
        const data = await res.json();
        if (data.status !== 'success') {
          throw new Error(`NewsData.io returned error: ${JSON.stringify(data)}`);
        }
        collected.push(...(data.results || []));
        page = data.nextPage || null;
      } catch (e) {
        console.warn(`[news] query failed (${q}):`, e.message);
        errors.push(e.message);
        break;
      }
      if (!page) break;
    }
  }
  if (collected.length === 0 && errors.length > 0) {
    throw new Error(errors[0]);
  }

  // 既に保存済みの記事と重複しない「新しい記事」だけを抽出する
  const existing = await db.getNews();
  const existingArticles = Array.isArray(existing.articles) ? existing.articles : [];
  const knownUrls = new Set(existingArticles.map((a) => a.url));
  const knownTitles = new Set(existingArticles.map((a) => normalizeTitle(a.title)));

  const newRaw = selectArticles(collected)
    .filter((a) => !knownUrls.has(a.link) && !knownTitles.has(normalizeTitle(a.title)))
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, ARTICLES_PER_FETCH)
    .map((a) => ({
      title: a.title,
      description: a.description,
      url: a.link,
      source: a.source_id,
      publishedAt: a.pubDate,
      imageUrl: a.image_url || null,
    }));

  if (newRaw.length === 0 && existingArticles.length === 0) {
    // 保存済みも新規も無い場合は何も上書きしない
    throw new Error('条件に合う記事がありませんでした(既存のニュースはそのまま残しています)');
  }

  // 新しい記事だけを ja/zh/ko/es へ自動翻訳する(既存記事は翻訳済みなので再翻訳しない)
  const newArticles = [];
  for (const article of newRaw) {
    const i18n = await translateArticle(article);
    newArticles.push({ ...article, i18n });
  }

  // 既存の記事も、今回の検索条件(除外ワード等)に合わなくなったものは取り除く
  const keptExisting = existingArticles.filter(
    (a) => REQUIRE_PATTERN.test(`${a.title} ${a.description || ''}`) &&
           !EXCLUDE_PATTERN.test(`${a.title} ${a.description || ''}`)
  );

  const articles = [...newArticles, ...keptExisting]
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, MAX_STORED_ARTICLES);

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
