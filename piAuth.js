// ==================================================================
// Pi認証(App Studio経由)
// ------------------------------------------------------------------
// ブラウザは Pi.authenticate() で取得した accessToken をこのサーバーに送る。
// サーバーはそれを App Studio のログインAPIに渡して検証し、返ってきた
// uid / username だけを本人の身元として扱う(ブラウザが自己申告する
// uid / username は一切信用しない)。検証後は、このサーバー独自の
// セッショントークンを発行して返す(1回のサインインにつき交換は1回だけ)。
// セッションはメモリ上に保持する(再起動すると消えるが、その場合は
// クライアントが再サインインする)。
// ==================================================================
const crypto = require('crypto');
const fetch = require('node-fetch');

const APPSTUDIO_LOGIN_URL = 'https://backend.appstudio-u7cm9zhmha0ruwv8.piappengine.com/pi/auth/v1/login';
const PI_ME_URL = 'https://api.minepi.com/v2/me';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;

function createPiAuth({ fetchImpl = fetch, now = () => Date.now(), origin = process.env.APP_ORIGIN || 'https://world-hemp-history.onrender.com' } = {}) {
  const sessions = new Map(); // token -> { uid, username, expiresAt }

  function sweep() {
    const t = now();
    for (const [k, v] of sessions) {
      if (v.expiresAt <= t) sessions.delete(k);
    }
    // 上限を超えた場合は古いものから捨てる(Mapは挿入順)
    while (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }

  async function loginWithAccessToken(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) {
      const err = new Error('accessToken が不正です');
      err.status = 400;
      throw err;
    }
    // 1) まず App Studio で検証する(App Studio から開いたアプリのトークンはこちらで通る)。
    let identity = null;
    let appStudioFailure = '';
    try {
      const res = await fetchImpl(APPSTUDIO_LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // App Studio がアプリを特定できるよう、このアプリ自身のURLをOriginとして付ける
          ...(origin ? { Origin: origin, Referer: origin + '/' } : {}),
        },
        body: JSON.stringify({ accessToken }),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
      if (res.ok && data.user && typeof data.user.uid === 'string' && data.user.uid) {
        identity = { uid: data.user.uid, username: typeof data.user.username === 'string' ? data.user.username : null };
      } else {
        const snippet = (text || '').replace(/\s+/g, ' ').slice(0, 160); // 原因切り分け用(トークンは含まれない)
        appStudioFailure = `App Studio: ${res.status} ${snippet}`.trim();
      }
    } catch (e) {
      appStudioFailure = `App Studio: ${e.message}`;
    }

    // 2) App Studio で検証できなかった場合(Pi Developer Portal に登録した Testnet アプリを
    //    Develop から開いたときなど、トークンが App Studio のアプリのものではない場合)は、
    //    Pi Platform の /v2/me で検証する。いずれの経路でも、検証済みの uid / username だけを使う。
    if (!identity) {
      try {
        const res = await fetchImpl(PI_ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
        if (res.ok && typeof data.uid === 'string' && data.uid) {
          identity = { uid: data.uid, username: typeof data.username === 'string' ? data.username : null };
        } else {
          appStudioFailure += ` / Pi /v2/me: ${res.status}`;
        }
      } catch (e) {
        appStudioFailure += ` / Pi /v2/me: ${e.message}`;
      }
    }
    if (!identity) {
      const err = new Error(`Pi認証に失敗しました(${appStudioFailure})`);
      err.status = 401;
      throw err;
    }
    const { uid, username } = identity;
    sweep();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionToken, { uid, username, expiresAt: now() + SESSION_TTL_MS });
    return { sessionToken, user: { uid, username } };
  }

  // 有効なセッションなら { uid, username } を、無ければ null を返す
  function getSession(token) {
    if (typeof token !== 'string' || !token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return { uid: s.uid, username: s.username };
  }

  return { loginWithAccessToken, getSession };
}

module.exports = { createPiAuth, APPSTUDIO_LOGIN_URL };
