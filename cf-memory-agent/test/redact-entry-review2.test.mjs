import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubEntryText, scrubText, scrub } from '../scripts/redact.mjs';
// Time limits are for a fast laptop; a slower machine sets CF_MEMORY_TEST_TIME_SCALE (CI uses 10).
const SLOW = Number(process.env.CF_MEMORY_TEST_TIME_SCALE) || 1;

// Review round 2 of scrubEntryText. Values are obviously fake fixtures; vendor
// prefixes are joined at run time so this file never holds a token-shaped
// literal. Test names never contain a value. Every redaction is checked twice:
// the server scrubs the Agent's text again and must change nothing.
const FAKE = 'Fake2pass9';
const join = (prefix, body) => prefix + body;
const scrubbed = input => {
  const out = scrubEntryText(input);
  assert.equal(scrubEntryText(out), out, `a second pass changes nothing: ${JSON.stringify(out)}`);
  return out;
};
const expectAll = cases => { for (const [input, expected] of cases) assert.equal(scrubbed(input), expected, JSON.stringify(input)); };

// Item 1: a credential key whose value is not JSON never wipes the rest of the entry.
test('a credential key followed by code or prose keeps the rest of the entry', () => {
  for (const text of [
    'Here is the fix:\n```python\npayload = {"model": model, "max_tokens": max_tokens, "messages": msgs}\nresp = client.post(url, json=payload)\n```\nAfter this change the 429 errors stopped. Next steps: update the README.',
    'export interface Config {\n  "authToken": string;\n  region: string;\n}\n\nその後、デプロイ手順を README に追記しました。',
    'In the schema, "token": is optional now. Next we deploy to prod and run the 0042 migration.',
    'TypeScript: interface A { "password": string; name: string } — then rename the file and push.',
    'Set "apiKey": process.env.API_KEY in the config, then restart the worker.',
    'const cfg = { "secret": getSecret(), region: "us-east-1" };\nconsole.log(cfg.region);',
    'Rename "authorization": header handling — see PR #12 and the failing tests.',
    '{"token": undefined, "next": "page2"} and then more prose that matters.',
    'defaults: {"secret": true, "token": null, "password": boolean} stay readable',
  ]) assert.equal(scrubbed(text), text);
});

test('a credential key loses one token or its JSON value, and a cut value only the rest of its line', () => {
  expectAll([
    [`{"password": ${FAKE}, "user": "a"} then more`, '{"password": "[REDACTED]", "user": "a"} then more'],
    [`const c = {"apiKey": '${FAKE}'}; next()`, 'const c = {"apiKey": "[REDACTED]"}; next()'],
    [`"token": "${FAKE} and the line goes on\nnext line stays`, '"token": "[REDACTED]"\nnext line stays'],
    [`"credentials": {"user": "a", "password": "${FAKE}"\nnext line stays`, '"credentials": "[REDACTED]"\nnext line stays'],
    [`"credentials": {\n  "user": "a",\n  "password": "${FAKE}"\n}\nafter`, '"credentials": "[REDACTED]"\nafter'],
    ['"token": {"a": [1, 2\n"note": "keep"', '"token": "[REDACTED]"\n"note": "keep"'],
  ]);
});

test('<private> without </private> loses only the rest of its line', () => {
  expectAll([
    ['Use the <private> tag to exclude text.\nThen we deploy and verify the 3 endpoints.', 'Use the [REDACTED PRIVATE CONTENT]\nThen we deploy and verify the 3 endpoints.'],
    ['a <private>fake diary\nsecond line</private> b', 'a [REDACTED PRIVATE CONTENT] b'],
    ['x <private>a</private> y <private> mention\nz', 'x [REDACTED PRIVATE CONTENT] y [REDACTED PRIVATE CONTENT]\nz'],
  ]);
  assert.equal(scrubText('<private> x\ny'), '[REDACTED PRIVATE CONTENT]', 'scrubText keeps its whole-text behaviour');
});

// Item 2: no run of one or two characters makes the scrubber super-linear.
test('dash runs and BEGIN fragments stay linear', () => {
  const best = (text, runs = 3) => { let ms = Infinity; for (let i = 0; i < runs; i++) { const t = performance.now(); scrubEntryText(text); ms = Math.min(ms, performance.now() - t); } return ms; };
  const fill = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const K64 = 65536, M1 = 1024 * 1024;
  for (const [name, unit] of [['dashes', '-'], ['BEGIN fragments', '-----BEGIN'], ['BEGIN headers', '-----BEGIN PRIVATE KEY-----'],
    ['dash runs before BEGIN', '-'.repeat(1000) + 'BEGIN '], ['dashes and newlines', '-\n'], ['END lines', '-----END PRIVATE KEY-----'],
    ['mixed', '--BEGIN --END -- BEGIN PRIVATE KEY----- -\n']]) {
    const small = best(fill(unit, K64));
    assert.ok(small < 50 * SLOW, `${name} at 64 KB: ${small.toFixed(1)} ms`);
    const large = best(fill(unit, M1), 1);
    assert.ok(large < 800 * SLOW, `${name} at 1 MB: ${large.toFixed(1)} ms`);
  }
  assert.equal(scrubEntryText('-'.repeat(K64)), '-'.repeat(K64));
});

test('the new rules stay fast on hostile 64 KB and 1 MB inputs', () => {
  const fill = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const best = text => { let ms = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); scrubEntryText(text); ms = Math.min(ms, performance.now() - t); } return ms; };
  for (const unit of ['"token": {', '"token": {\n', '"token": [', '"token": "', '"token":-', '"token": is, ', 'x "password": y ', '"auth":"', '<private>', '<private>\n',
    '</private><private>', 'password: |\n', '  password: >-\n    x\n', '| password | x |\n', '| a | b |\n|---|---|\n', '|', '4111 ', '4-', '1:1:1:1:', 'a:1:b:c:',
    'bot1234567:', 'seed ', 'seed AAAA ', 'cvv 1', 'password: x\n', 'password: x #', '- password: ', '"Cookie: ', "'cookie:", 'set-cookie:', 'authorization: x | ',
    'http://a/home/', '/home/', 'file:///Users/', '{"Value":"', '{"Name":"x","Value":"', 'hvs.', 'A.B.', 'API_KEY=\\\n', 'パスワード：Ｆ', ' token: string;\n', 'secret: ']) {
    const small = best(fill(unit, 65536));
    assert.ok(small < 50 * SLOW, `${JSON.stringify(unit)} at 64 KB: ${small.toFixed(1)} ms`);
  }
  for (const unit of ['"token": {\n', 'x "password": y ', '  password: >-\n    x\n', '| password | x |\n', 'secret: ', '"Cookie: ']) {
    const t = performance.now(); scrubEntryText(fill(unit, 1024 * 1024)); const ms = performance.now() - t;
    assert.ok(ms < 800 * SLOW, `${JSON.stringify(unit)} at 1 MB: ${ms.toFixed(1)} ms`);
  }
});

test('long runs inside the structures the new rules parse stay fast', () => {
  const fill = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const best = text => { let ms = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); scrubEntryText(text); ms = Math.min(ms, performance.now() - t); } return ms; };
  for (const [context, unit] of [['| X | y |\n|---|---|\n| X | z |', 'a-'], ['| X | y |\n|---|---|\n| X | z |', 'a_'], ['| password | X |', 'a '],
    ['cvv X', '　 '], ['cvv X', '\t'], ['password X', '\t"'], ['token X', '\t"'], ['"token": X', '{"a'], ['a:\n  password: >-\n    X\n', 'a\n'],
    ['X:5432:db:user:pw', 'a.'], ['h:1:d:X', 'a!'], ['bot123456:X', 'aA'], ['seed: X', 'A '], ['Cookie: X', ' \n'], ['"Cookie: X"', 'a '],
    ['https://X@host/home/x', 'a/'], ['{"Name":"a","Value":"X"}', '\\"'], ['<private>X', '<private>'], ['-----BEGIN PRIVATE KEY-----X', '-']]) {
    const ms = best(context.replace('X', () => fill(unit, 65536)));
    assert.ok(ms < 50 * SLOW, `${JSON.stringify(context)} with ${JSON.stringify(unit)} at 64 KB: ${ms.toFixed(1)} ms`);
  }
});

// Item 3: secrets that survived round 1.
const survivors = [
  // [name, input, ...fragments that must not survive]
  ['a docker auth entry', '{"auths":{"https://index.docker.io/v1/":{"auth":"YWxpY2U6RmFrZVBhc3N3b3JkMTIz"}}}', 'YWxpY2U6'],
  ['a docker auth entry inside a line', 'cat config.json shows {"auths": {"ghcr.io": {"auth": "YWxpY2U6RmFrZVBhc3N3b3JkMTIz"}}}', 'YWxpY2U6'],
  ['an npm _auth line', '_auth=dXNlcjpGYWtlUGFzc3dvcmQ=', 'dXNlcjpG'],
  ['a quoted npm _auth line', '_auth = "dXNlcjpGYWtlUGFzc3dvcmQ="', 'dXNlcjpG'],
  ['a .pgpass line', 'db.internal:5432:app:appuser:Fak3PgPass!', 'Fak3PgPass'],
  ['a .pgpass line with wildcards', `*:*:*:postgres:${FAKE}`, FAKE],
  ['a .pgpass line written by echo', "echo 'db.internal:5432:app:appuser:Fak3PgPass!' >> ~/.pgpass", 'Fak3PgPass'],
  ['a card number with spaces and its cvv', 'card 4111 1111 1111 1111 exp 12/29 cvv 123', '4111', '1111 1111', 'cvv 123'],
  ['a card number with dashes and a Japanese security code', 'カード番号 4111-1111-1111-1111 有効期限 12/29 セキュリティコード 123', '4111', 'コード 123'],
  ['a CVC after a colon', 'CVC: 1234', '1234'],
  ['a TOTP seed after a few words', '2FA backup seed: JBSWY3DPEHPK3PXPFAKE', 'JBSWY3DP'],
  ['a grouped TOTP seed', 'TOTP secret: JBSW Y3DP EHPK 3PXP', 'JBSW Y3DP'],
  ['a lower-case TOTP seed', 'MFA seed is jbswy3dpehpk3pxp', 'jbswy3dp'],
  ['a YAML folded block scalar', 'db:\n  password: >-\n    FakeFolded12345\n    second line\n  user: app\n', 'FakeFolded', 'second line'],
  ['a YAML literal block scalar with a blank line', 'tls:\n  private_key: |\n    MIIFAKE\n\n    MOREFAKE\nnext: 1', 'MIIFAKE', 'MOREFAKE'],
  ['a shell continuation', 'export API_KEY=\\\n  FAKEKEY1234567890 && next', 'FAKEKEY'],
  ['a shell continuation of an env name', `SMTP_PASS=\\\n  ${FAKE}`, FAKE],
  ['a Telegram bot token in a URL', join('https://api.telegram.org/bot123456789:', 'AAFakeTelegramTokenFAKEFAKEFAKE1234') + '/sendMessage', 'AAFake'],
  ['a full-width value after a full-width colon', 'パスワード：Ｆａｋｅ１２３４', 'Ｆａｋｅ'],
  ['a full-width value after a full-width space', 'パスワード　Ｆａｋｅ１２３４です', 'Ｆａｋｅ'],
  ['kubeconfig keys', 'users:\n- name: admin\n  user:\n    client-certificate-data: LS0tLS1CRUdJTiBDRVJUFAKE\n    client-key-data: LS0tLS1CRUdJTiBSU0EgFAKE==\n    token: fakeKubeToken0123\n', 'LS0t', 'fakeKubeToken'],
  ['an SSM SecureString parameter', '{"Parameter":{"Name":"/prod/db","Type":"SecureString","Value":"Fak3DbPassw0rd!"}}', 'Fak3DbPassw0rd'],
  ['an SSM parameter inside a line', 'aws ssm output: {"Name": "/prod/db", "Type": "SecureString", "Value": "Fak3DbPassw0rd!"} done', 'Fak3DbPassw0rd'],
  ['a Key Vault secret', '{"value": "FakeKeyVaultSecret123", "id": "https://v.vault.azure.net/secrets/x"}', 'FakeKeyVault'],
  ['a container env entry naming a password', `[{"name": "DB_PASSWORD", "value": "${FAKE}"}, {"name": "PORT", "value": "8080"}]`, FAKE],
];
for (const [name, input, ...hidden] of survivors) test('scrubEntryText redacts ' + name, () => {
  const out = scrubbed(input);
  for (const fragment of hidden) assert.ok(!out.includes(fragment), `${name}: ${JSON.stringify(out)}`);
  assert.match(out, /\[REDACTED/);
});

test('the surviving shapes keep their surroundings', () => {
  expectAll([
    ['card 4111 1111 1111 1111 exp 12/29 cvv 123', 'card [REDACTED CARD] exp 12/29 cvv [REDACTED]'],
    ['db:\n  password: >-\n    FakeFolded12345\n  user: app\n', 'db:\n  password: >-\n    [REDACTED]\n  user: app\n'],
    ['export API_KEY=\\\n  FAKEKEY1234567890 && next', 'export API_KEY=\\\n  [REDACTED] && next'],
    [join('https://api.telegram.org/bot123456789:', 'AAFakeTelegramTokenFAKEFAKEFAKE1234') + '/sendMessage', 'https://api.telegram.org/bot123456789:[REDACTED TOKEN]/sendMessage'],
    ['db.internal:5432:app:appuser:Fak3PgPass!', 'db.internal:5432:app:appuser:[REDACTED]'],
    ['{"Parameter":{"Name":"/prod/db","Type":"SecureString","Value":"Fak3DbPassw0rd!"}}', '{"Parameter":{"Name":"/prod/db","Type":"SecureString","Value":"[REDACTED]"}}'],
  ]);
});

test('look-alikes of the surviving shapes stay', () => {
  for (const text of [
    '{"author": "Jane Doe", "oauth_url": "https://x.test/oauth/authorize", "auth": "basic"}',
    'author: Jane Doe\noauth_url: https://x.test/oauth/authorize',
    'src/a.ts:12:5: error TS2304', '00:1a:2b:3c:4d:5e', '12:30:45:67:89',
    'ts 1730700000000 id 20241104123456 order 4111111111111112', '20241104:release-notes-for-the-big-feature-launch',
    'MFA enforcement policy', 'notes: |\n  plain text stays\n', 'パスワード：ＡＢＣ',
    '{"name": "Content-Type", "value": "application/json"}', 'headers: {"name": "Accept", "value": "text/html"}',
  ]) assert.equal(scrubbed(text), text);
  const nested = scrubbed(`{"auth": {"username": "a", "password": "${FAKE}"}}`);
  assert.ok(/"username":\s*"a"/.test(nested) && !nested.includes(FAKE), nested);
  for (const text of ['{"auth": "hunter2"}', '{"auth": "changeme"}', 'auth: changeme']) assert.ok(!scrubbed(text).includes(text.match(/hunter2|changeme/)[0]), text);
});

// Item 4a: a credential key that starts a config line redacts any value but placeholders.
test('a config line redacts any value of a credential key', () => {
  expectAll([
    ['password: changeme', 'password: [REDACTED]'],
    ['DB_PASSWORD: postgres', 'DB_PASSWORD: [REDACTED]'],
    ['stringData:\n  password: changeme\n  api-token: hunter2hunter2', 'stringData:\n  password: [REDACTED]\n  api-token: [REDACTED]'],
    ['  - password: changeme', '  - password: [REDACTED]'],
    ['environment:\n  POSTGRES_PASSWORD: postgres  # local only', 'environment:\n  POSTGRES_PASSWORD: [REDACTED]  # local only'],
    ['password:\r\n  changeme\r\nnext: 1', 'password:\r\n  [REDACTED]\r\nnext: 1'],
  ]);
  for (const text of ['password: string', 'password: ""', "password: ''", 'password: <your-password>', 'password: ${DB_PASSWORD}', 'password: $DB_PASSWORD',
    'secret: true', 'token: required', 'password: null', 'password: none', 'auth: optional', 'password: ~', '  password: process.env.DB_PASSWORD,',
    '  password: changeme,', 'Password: see the vault entry', 'the password: changeme is the default', 'token: 3 remaining', 'max_tokens: 4096', 'password: |\n']) {
    assert.equal(scrubbed(text), text);
  }
});

// Item 4b: Markdown tables.
test('a Markdown table loses the value next to a credential name and under a credential header', () => {
  expectAll([
    ['| key | value |\n|---|---|\n| password | FakeTablePw1 |\n| API token | ghFakeTok1234 |', '| key | value |\n|---|---|\n| password | [REDACTED] |\n| API token | [REDACTED] |'],
    ['| User | Password |\n|---|---|\n| admin | Fake1234 |\n| bob | Tr0ub4dor |', '| User | Password |\n|---|---|\n| admin | [REDACTED] |\n| bob | [REDACTED] |'],
    ['| password | `Fake 1234` |', '| password | [REDACTED] |'],
    ['| password | **Fake1234** |', '| password | **[REDACTED]** |'],
    ['| 環境 | パスワード |\n|---|---|\n| 本番 | Fake1234 |', '| 環境 | パスワード |\n|---|---|\n| 本番 | [REDACTED] |'],
    ['| aws_secret_access_key | FakeKey123 |', '| aws_secret_access_key | [REDACTED] |'],
  ]);
  for (const text of [
    '| Name | Type |\n|---|---|\n| token | string |\n| password | Your account password |',
    '| Token | Value |\n|---|---|\n| --color-primary | #fff |',
    '| Status | Count |\n|---|---|\n| pass | 12 |',
    '| Package | Pin |\n|---|---|\n| lodash | 4.17.21 |\n| react | ^18.2.0 |',
    '| Password | Notes |\n|---|---|\n| - | rotate monthly |',
    'cat x | grep password | wc -l',
  ]) assert.equal(scrubbed(text), text);
});

// Item 4c: dotted values.
test('dotted code references stay; long passphrase-like or random dotted values go', () => {
  expectAll([
    ['password: Correct.Horse.Battery.Staple', 'password: [REDACTED]'],
    [join('token: hvs.', 'CAESIFAKEFAKEFAKEFAKEFAKE'), 'token: [REDACTED TOKEN]'],
    [join('password: hvs.', 'CAESIFAKEFAKEFAKE'), 'password: [REDACTED TOKEN]'],
    ['password: abc.Def1ghIjkl23mn', 'password: [REDACTED]'],
  ]);
  for (const text of ['password: process.env.DB_PASSWORD', 'token: config.auth.token', 'secret: this.props.authToken', 'password: config.oauth2.clientSecret',
    'api_key: key.value.here', 'pass process.env.PORT into the server', 'my password is correct horse battery staple']) assert.equal(scrubbed(text), text);
});

// Item 5: over-redaction.
test('a header value ends at its quote or the shell pipe', () => {
  expectAll([
    ['curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com/v1/items | jq .items', 'curl -H "Authorization: [REDACTED]" https://api.example.com/v1/items | jq .items'],
    ["curl -H 'Cookie: sid=fake0123' -H 'Accept: x' https://x.test | head", "curl -H 'Cookie: [REDACTED]' -H 'Accept: x' https://x.test | head"],
    ['Cookie: sid=fake0123; theme=dark | grep x', 'Cookie: [REDACTED] | grep x'],
    ['Authorization: Basic Zm9vOmJhcg==', 'Authorization: [REDACTED]'],
  ]);
});

test('URL userinfo keeps the host, path and the rest of the command', () => {
  expectAll([
    [join('git clone https://oauth2:', 'glpat-FAKEFAKEFAKEFAKEFAKE') + '@gitlab.com/x/y.git && cd y && make', 'git clone https://oauth2:[REDACTED TOKEN]@gitlab.com/x/y.git && cd y && make'],
    [`git clone https://oauth2:${FAKE}@gitlab.com/x/y.git && cd y`, 'git clone https://[REDACTED]@gitlab.com/x/y.git && cd y'],
    [`https://token:${FAKE}@host.test/x y`, 'https://[REDACTED]@host.test/x y'],
  ]);
});

test('home paths become ~ only outside URLs', () => {
  expectAll([
    ['See https://example.com/home/docs/install and /Users/alice/project/src', 'See https://example.com/home/docs/install and ~/project/src'],
    ['open file:///Users/alice/a.txt', 'open file://~/a.txt'],
    ['http://localhost/home/alice ok', 'http://localhost/home/alice ok'],
  ]);
});

test('token counts are not credentials', () => {
  for (const text of ['"max_tokens": 1024, "input_tokens": 12', '{"usage": {"input_tokens": 1234, "output_tokens": 56, "max_tokens": 4096}}',
    'max_tokens=4096\ntokens: 12\ntoken_count=3', '{"token_count": "17"}', 'request {"tokens": 8, "max_tokens": 16} sent']) assert.equal(scrubbed(text), text);
  assert.ok(!scrubbed('{"tokens": "abcd1234efgh"}').includes('abcd1234'));
  assert.ok(!scrubbed('max_tokens=abcd1234efgh').includes('abcd1234'));
});

test('scrubText and scrub keep their behaviour for the Worker', () => {
  assert.equal(scrubText('{"max_tokens":1}'), '{"max_tokens":"[REDACTED]"}');
  assert.deepEqual(scrub({ max_tokens: 1, oauth_url: 'u', author: 'a' }), { max_tokens: '[REDACTED]', oauth_url: '[REDACTED]', author: 'a' });
  assert.equal(scrubText('token: abc'), 'token: [REDACTED]');
  assert.equal(scrubText('Cookie: a | b'), 'Cookie: [REDACTED]');
  assert.equal(scrubText('/home/alice/x'), '~/x');
});
