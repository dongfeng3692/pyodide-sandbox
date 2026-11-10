// AUTH — token lifecycle (main) + first-run account flows (account).
//
// The `account` profile is NOT bootstrapped by the harness: AUTH-020..025
// drive setup / login / zero-token / password change / lockout themselves, in
// that order. The lockout case deliberately leaves the admin locked for 5
// minutes — it must stay last on this profile.
import assert from 'node:assert/strict';
import { ADMIN_USER, ADMIN_PASS, ADMIN_PASS_2 } from '../harness.mjs';

const LOGIN = { user: ADMIN_USER, password: ADMIN_PASS };

// ---- main: token CRUD gates /exec ------------------------------------------------

export default [
  {
    id: 'AUTH-001', profile: 'main', title: '无令牌头 → 401 unauthorized',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"n": 1}' }, null);
      assert.equal(r.status, 401);
      assert.equal(r.body.error.type, 'unauthorized');
    },
  },
  {
    id: 'AUTH-002', profile: 'main', title: '错误令牌 → 401 unauthorized',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"n": 1}' }, 'garbage');
      assert.equal(r.status, 401);
      assert.equal(r.body.error.type, 'unauthorized');
    },
  },
  {
    id: 'AUTH-003', profile: 'main', title: '令牌列表只含安全字段(无明文无哈希)',
    run: async (c) => {
      const r = await c.admin('GET', '/admin/api/tokens');
      assert.equal(r.status, 200);
      const t = r.body.tokens[0];
      assert.equal(t.name, 'regression');
      assert.equal(t.enabled, true);
      assert.ok(t.prefix && t.prefix.length === 8, 'prefix is first 8 chars');
      assert.ok(!('token' in t) && !('token_hash' in t), 'no plaintext/hash field');
      assert.ok(!JSON.stringify(r.body).includes(c.state.token), 'plaintext never echoed anywhere');
    },
  },
  {
    id: 'AUTH-004', profile: 'main', title: 'prefix = 令牌前 8 字符',
    run: async (c) => {
      const r = await c.admin('GET', '/admin/api/tokens');
      assert.equal(r.body.tokens[0].prefix, c.state.token.slice(0, 8));
    },
  },
  {
    id: 'AUTH-005', profile: 'main', title: '创建第二令牌 → 201 · 48hex · 两个令牌各自可用',
    run: async (c) => {
      const r = await c.admin('POST', '/admin/api/tokens', { name: 'aux' });
      assert.equal(r.status, 201);
      assert.match(r.body.token, /^[0-9a-f]{48}$/);
      c.state.aux = r.body.token;
      c.state.auxId = r.body.id;
      assert.equal((await c.exec({ code: 'result = {}' }, c.state.token)).status, 200);
      assert.equal((await c.exec({ code: 'result = {}' }, c.state.aux)).status, 200);
    },
  },
  {
    id: 'AUTH-006', profile: 'main', title: '非法名称(空/超长/缺失)→ 422 invalid_name',
    run: async (c) => {
      for (const name of ['', '   ', 'x'.repeat(65), undefined]) {
        const r = await c.admin('POST', '/admin/api/tokens', name === undefined ? {} : { name });
        assert.equal(r.status, 422, `name=${JSON.stringify(name)}`);
        assert.equal(r.body.error.type, 'invalid_name');
      }
    },
  },
  {
    id: 'AUTH-007', profile: 'main', title: '停用 aux → 仅 aux 被 401;恢复 → 200',
    run: async (c) => {
      const off = await c.admin('PATCH', `/admin/api/tokens/${c.state.auxId}`, { enabled: false });
      assert.equal(off.status, 200);
      assert.equal((await c.exec({ code: 'result = {}' }, c.state.aux)).status, 401);
      assert.equal((await c.exec({ code: 'result = {}' }, c.state.token)).status, 200, 'other token unaffected');
      const on = await c.admin('PATCH', `/admin/api/tokens/${c.state.auxId}`, { enabled: true });
      assert.equal(on.status, 200);
      assert.equal((await c.exec({ code: 'result = {}' }, c.state.aux)).status, 200);
    },
  },
  {
    id: 'AUTH-008', profile: 'main', title: 'last_used_ts 在成功调用后被记录',
    run: async (c) => {
      const r = await c.admin('GET', '/admin/api/tokens');
      const aux = r.body.tokens.find((t) => t.id === c.state.auxId);
      assert.ok(aux.last_used_ts, 'last_used_ts recorded after successful calls');
    },
  },
  {
    id: 'AUTH-009', profile: 'main', title: '删除 aux → 401;列表不再含它',
    run: async (c) => {
      const del = await c.admin('DELETE', `/admin/api/tokens/${c.state.auxId}`);
      assert.equal(del.status, 200);
      assert.equal((await c.exec({ code: 'result = {}' }, c.state.aux)).status, 401);
      const list = await c.admin('GET', '/admin/api/tokens');
      assert.ok(!list.body.tokens.some((t) => t.id === c.state.auxId));
    },
  },
  {
    id: 'AUTH-010', profile: 'main', title: '未知令牌 id PATCH/DELETE → 404',
    run: async (c) => {
      assert.equal((await c.admin('PATCH', '/admin/api/tokens/999', { enabled: false })).status, 404);
      assert.equal((await c.admin('DELETE', '/admin/api/tokens/999')).status, 404);
    },
  },
  {
    id: 'AUTH-011', profile: 'main', title: 'PATCH 非布尔 enabled → 422 invalid_body',
    run: async (c) => {
      const r = await c.admin('PATCH', `/admin/api/tokens/${c.state.tokenId}`, { enabled: 'yes' });
      assert.equal(r.status, 422);
      assert.equal(r.body.error.type, 'invalid_body');
    },
  },
  {
    id: 'AUTH-012', profile: 'main', title: '管理 API 无会话 → 401',
    run: async (c) => {
      for (const [m, p] of [['GET', '/admin/api/tokens'], ['GET', '/admin/api/metrics'], ['POST', '/admin/api/mcp']]) {
        const r = await c.admin(m, p, m === 'POST' ? { enabled: true } : undefined, { cookie: null });
        assert.equal(r.status, 401, `${m} ${p}`);
      }
    },
  },
  {
    id: 'AUTH-013', profile: 'main', title: '会话可走 Authorization: Bearer',
    run: async (c) => {
      const login = await c.admin('POST', '/admin/api/login', LOGIN, { cookie: null });
      assert.equal(login.status, 200);
      const sessionToken = (login.headers.get('set-cookie') ?? '').split(';')[0].replace('sbx_admin=', '');
      assert.match(sessionToken, /^[0-9a-f]{64}$/);
      const r = await c.fetch('/admin/api/tokens', { headers: { authorization: `Bearer ${sessionToken}` } });
      assert.equal(r.status, 200, 'sessionCookie accepts Bearer');
    },
  },
  {
    id: 'AUTH-014', profile: 'main', title: '登出 → 会话失效;再次登出仍 200',
    run: async (c) => {
      const login = await c.admin('POST', '/admin/api/login', LOGIN, { cookie: null });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const out = await c.admin('POST', '/admin/api/logout', undefined, { cookie });
      assert.equal(out.status, 200);
      assert.equal((await c.admin('GET', '/admin/api/tokens', undefined, { cookie })).status, 401);
      assert.equal((await c.admin('POST', '/admin/api/logout', undefined, { cookie })).status, 200, 'idempotent');
    },
  },

  // ---- account: first-run setup / login / zero-token / password change / lockout ----

  {
    id: 'AUTH-020', profile: 'account', title: '首跑:setup 全分支 + cookie 属性',
    run: async (c) => {
      const st0 = await c.fetch('/admin/api/status');
      const b0 = await st0.json();
      assert.equal(b0.admin, 'setup');
      assert.equal(b0.user, null);
      const weak = await c.admin('POST', '/admin/api/setup', { user: ADMIN_USER, password: 'short' }, { cookie: null });
      assert.equal(weak.status, 422);
      assert.equal(weak.body.error.type, 'invalid_credentials');
      const badUser = await c.admin('POST', '/admin/api/setup', { user: 'a b!', password: ADMIN_PASS }, { cookie: null });
      assert.equal(badUser.status, 422);
      const setup = await c.admin('POST', '/admin/api/setup', LOGIN, { cookie: null });
      assert.equal(setup.status, 200);
      const setCookie = setup.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      c.state.adminCookie = setCookie.split(';')[0];
      const st1 = await c.admin('GET', '/admin/api/status');
      assert.equal(st1.body.admin, 'ready');
      assert.equal(st1.body.user, ADMIN_USER);
    },
  },
  {
    id: 'AUTH-021', profile: 'account', title: '二次 setup → 409 already_initialized',
    run: async (c) => {
      const r = await c.admin('POST', '/admin/api/setup', LOGIN, { cookie: null });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.type, 'already_initialized');
    },
  },
  {
    id: 'AUTH-022', profile: 'account', title: '登录:错密/错名 401,正确 200',
    run: async (c) => {
      const wrongPw = await c.admin('POST', '/admin/api/login', { user: ADMIN_USER, password: 'nope' }, { cookie: null });
      assert.equal(wrongPw.status, 401);
      const wrongUser = await c.admin('POST', '/admin/api/login', { user: 'root', password: ADMIN_PASS }, { cookie: null });
      assert.equal(wrongUser.status, 401);
      const ok = await c.admin('POST', '/admin/api/login', LOGIN, { cookie: null });
      assert.equal(ok.status, 200);
      c.state.adminCookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    },
  },
  {
    id: 'AUTH-023', profile: 'account', title: '零令牌 → /exec 401 no_tokens_configured',
    run: async (c) => {
      const r = await c.exec({ code: 'result = {"n": 1}' }, null);
      assert.equal(r.status, 401);
      assert.equal(r.body.error.type, 'no_tokens_configured');
    },
  },
  {
    id: 'AUTH-024', profile: 'account', title: '改密:全分支 + 他端会话被踢',
    run: async (c) => {
      const cur = c.state.adminCookie;
      const call = (body, cookie) => c.admin('POST', '/admin/api/password', body, { cookie });
      assert.equal((await call({ current: ADMIN_PASS, next: ADMIN_PASS_2 }, null)).status, 401, 'unauthenticated');
      assert.equal((await call({ current: 'nope', next: ADMIN_PASS_2 }, cur)).status, 401, 'wrong current');
      assert.equal((await call({ current: ADMIN_PASS, next: 'short' }, cur)).status, 422, 'short next');
      // a second live session…
      const second = await c.admin('POST', '/admin/api/login', LOGIN, { cookie: null });
      const cookie2 = (second.headers.get('set-cookie') ?? '').split(';')[0];
      // …is invalidated by the change, the current one survives
      assert.equal((await call({ current: ADMIN_PASS, next: ADMIN_PASS_2 }, cur)).status, 200);
      assert.equal((await c.admin('GET', '/admin/api/tokens', undefined, { cookie: cur })).status, 200, 'current session kept');
      assert.equal((await c.admin('GET', '/admin/api/tokens', undefined, { cookie: cookie2 })).status, 401, 'other session kicked');
      // old password rejected, new one works
      assert.equal((await c.admin('POST', '/admin/api/login', LOGIN, { cookie: null })).status, 401);
      const re = await c.admin('POST', '/admin/api/login', { user: ADMIN_USER, password: ADMIN_PASS_2 }, { cookie: null });
      assert.equal(re.status, 200);
      c.state.adminCookie = (re.headers.get('set-cookie') ?? '').split(';')[0];
    },
  },
  {
    id: 'AUTH-025', profile: 'account', title: '10 次登录失败 → 锁定 429;锁定期 setup 也 429',
    // MUST stay last on the account profile — it locks the admin for 5 minutes.
    run: async (c) => {
      // 10 failures: each is still answered 401 — the lock arms on the 10th
      // and takes effect on the NEXT request.
      for (let i = 1; i <= 10; i++) {
        const r = await c.admin('POST', '/admin/api/login', { user: ADMIN_USER, password: `wrong-${i}` }, { cookie: null });
        assert.equal(r.status, 401, `attempt ${i}`);
      }
      const locked = await c.admin('POST', '/admin/api/login', { user: ADMIN_USER, password: ADMIN_PASS_2 }, { cookie: null });
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error.type, 'login_locked');
      const setup = await c.admin('POST', '/admin/api/setup', LOGIN, { cookie: null });
      assert.equal(setup.status, 429, 'setup is also gated while locked');
      assert.equal(setup.body.error.type, 'setup_locked');
    },
  },
];
