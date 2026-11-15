import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubEntryText, scrubText, scrub, markedPrivate } from '../scripts/redact.mjs';
// Time limits are for a fast laptop; a slower machine sets CF_MEMORY_TEST_TIME_SCALE (CI uses 10).
const SLOW = Number(process.env.CF_MEMORY_TEST_TIME_SCALE) || 1;

// scrubEntryText is the one scrubber for log text (agent and server). Values
// are obviously fake fixtures; vendor prefixes are joined at run time so this
// file never holds a token-shaped literal. Test names never contain a value.
const FAKE = 'Fake2pass9';
const join = (prefix, body) => prefix + body;

// [name, input, ...fragments that must not survive]
const secrets = [
  // Words between the keyword and the value.
  ['an English phrase before "is"', `the password for the staging db is ${FAKE}`, FAKE],
  ['an adverb after "is"', 'the db password is now fake2pass!', 'fake2pass'],
  ['a Japanese comma after the keyword', `Wi-Fiのパスワード、${FAKE}`, FAKE],
  ['a Japanese phrase, then a colon', '暗証番号を教えます: 4821', '4821'],
  ['a Japanese phrase, then a full-width colon', `パスワードを教えます：${FAKE}`, FAKE],
  ['a Japanese phrase, then が、', `ログインに使うパスワードですが、${FAKE} です`, FAKE],
  ['a user / password pair', `credentials: admin / ${FAKE}`, FAKE],
  ['a quoted password with spaces', 'password is "fake pass 9"', 'fake pass 9'],
  ['a comma inside the value', 'password is f@ke,pass99 ok', 'f@ke', 'pass99'],
  ['a long plain passphrase after "is"', 'my password is fakehorsebatterystaple', 'fakehorsebatterystaple'],
  // Keywords that were missing.
  ['passphrase with a colon', 'passphrase: Fa1ke&horse', 'Fa1ke&horse'],
  ['passphrase in prose', 'my passphrase is fake-horse-battery-9', 'fake-horse-battery-9'],
  ['パスフレーズ', `パスフレーズは ${FAKE}`, FAKE],
  ['lower-case pin with a colon', 'pin: 4821', '4821'],
  ['lower-case pin with "is"', 'pin is 4821', '4821'],
  ['PIN番号', 'PIN番号は4821です', '4821'],
  ['PINコード', 'PINコード：4821', '4821'],
  ['a quoted JSON pin inside a line', 'sent {"user": "a", "pin": "4821"} to the API', '4821'],
  // Environment names ending in PASS/PWD/AUTH/KEY, and keywords after "_".
  ['SMTP_PASS', `SMTP_PASS=${FAKE}`, FAKE],
  ['MYSQL_PWD', `MYSQL_PWD=${FAKE}`, FAKE],
  ['REDIS_AUTH', `REDIS_AUTH=${FAKE}`, FAKE],
  ['SENDGRID_KEY', 'SENDGRID_KEY=' + join('SG.', 'fakefake.fakefake'), 'fakefake'],
  ['a quoted export', `export DB_PASS="${FAKE}"`, FAKE],
  ['a keyword after "_" in prose', `db_password is ${FAKE}`, FAKE],
  ['env lines in a diff', `< SMTP_PASS=${FAKE}\n< MYSQL_PWD=${FAKE}\n> SMTP_PASS=\n`, FAKE],
  // Command arguments.
  ['mysql -pX', `mysql -u root -p${FAKE} mydb`, FAKE],
  ['redis-cli -a X', `redis-cli -a ${FAKE} ping`, FAKE],
  ['sshpass -p X', `sshpass -p ${FAKE} ssh deploy@host`, FAKE],
  ['a single-quoted literal that starts with $', "sshpass -p '$fake2pass' ssh deploy@host", 'fake2pass'],
  ['docker login -p X', `docker login -u me -p ${FAKE} registry.example.test`, FAKE],
  ['curl -u user:pass', `curl -u admin:${FAKE} https://api.example.test/x`, FAKE],
  ['curl -b', 'curl -b "sessionid=fake0123456789" https://x.example.test', 'fake0123456789'],
  ['curl --cookie', 'curl --cookie "sid=fake0123456789" https://x.example.test', 'fake0123456789'],
  ['gh secret set --body', `gh secret set FOO --body ${FAKE}`, FAKE],
  ['aws configure set', 'aws configure set aws_secret_access_key fakeFAKE/fake0123/FAKEfake', 'fakeFAKE'],
  ['npm _authToken', 'npm config set //registry.npmjs.org/:_authToken fakefake0123456789', 'fakefake0123456789'],
  ['echo into a secret store', 'echo FAKEfake0123456789 | wrangler secret put CF_TOKEN', 'FAKEfake0123456789'],
  ['a here-string into a secret store', 'wrangler secret put API_TOKEN <<< FAKEfake0123456789', 'FAKEfake0123456789'],
  ['a .netrc line', `machine api.example.test login me password ${FAKE}`, FAKE],
  ['a cookie in prose', 'cookie a=FAKEfake0123456789', 'FAKEfake0123456789'],
  // Token prefixes.
  ['Hugging Face', join('hf_', 'FAKEfakeFAKEfakeFAKEfake12'), 'FAKEfake'],
  ['npm', join('npm_', 'FAKEfakeFAKEfakeFAKEfake1234567890'), 'FAKEfake'],
  ['SendGrid', join('SG.', 'fakefakefakefake.fakefakefakefakefakefake'), 'fakefake'],
  ['Google OAuth access token', join('ya29.', 'a0FAKEfakeFAKEfake0123'), 'FAKEfake'],
  ['Google OAuth client secret', join('GOCSPX-', 'FAKEfakeFAKEfake0123'), 'FAKEfake'],
  ['Shopify', join('shpat_', '0123456789abcdef0123456789abcdef'), '0123456789abcdef'],
  ['PyPI', join('pypi-', 'AgEIcHlwaS5vcmcFAKEfakeFAKE'), 'FAKEfake'],
  ['DigitalOcean', join('dop_v1_', '0123456789abcdef'.repeat(4)), '0123456789abcdef'],
  ['Stripe webhook secret', join('whsec_', 'FAKEfakeFAKEfake01234'), 'FAKEfake'],
  ['age secret key', join('AGE-SECRET-KEY-1', 'FAKE'.repeat(12)), 'FAKEFAKE'],
  ['AWS temporary key id', join('ASIA', 'FAKEFAKEFAKEFAKE'), 'FAKEFAKE'],
  ['a Slack webhook URL', join('https://hooks.slack', '.com/services/T00000000/B00000000/FAKEfakeFAKEfake'), 'FAKEfake'],
  ['Azure AccountKey', 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=FAKEfakeFAKE0123==;EndpointSuffix=core.windows.net', 'FAKEfake'],
  ['an Azure SAS sig', 'https://acct.blob.core.windows.net/c/f?sv=2020&sig=FAKEsig%2Bfake%3D', 'FAKEsig'],
  // Private keys.
  ['a PGP private key block', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFAKEFAKE\n-----END PGP PRIVATE KEY BLOCK-----', 'FAKEFAKE'],
  ['a private key cut before its END line', 'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEFAKEFAKE\n(truncated)', 'FAKEFAKE'],
  ['an OpenSSH key on one line', 'Bash: -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaFAKE -----END OPENSSH PRIVATE KEY-----', 'FAKE'],
  ['an encrypted private key', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFAKE\n-----END ENCRYPTED PRIVATE KEY-----', 'FAKE'],
];
for (const [name, input, ...hidden] of secrets) test('scrubEntryText redacts ' + name, () => {
  const out = scrubEntryText(input);
  for (const fragment of hidden) assert.ok(!out.includes(fragment), `${name}: ${JSON.stringify(out)}`);
  assert.match(out, /\[REDACTED/);
  assert.equal(scrubEntryText(out), out, 'a second pass (the server) changes nothing');
});

test('scrubEntryText keeps the words around a redacted value', () => {
  for (const [input, expected] of [
    [`the password for the staging db is ${FAKE}`, 'the password for the staging db is [REDACTED]'],
    ['暗証番号を教えます: 4821', '暗証番号を教えます: [REDACTED]'],
    [`Wi-Fiのパスワード、${FAKE}`, 'Wi-Fiのパスワード、[REDACTED]'],
    [`credentials: admin / ${FAKE}`, 'credentials: admin / [REDACTED]'],
    [`mysql -u root -p${FAKE} mydb`, 'mysql -u root -p[REDACTED] mydb'],
    [`curl -u admin:${FAKE} https://api.example.test/x`, 'curl -u admin:[REDACTED] https://api.example.test/x'],
    [`SMTP_PASS=${FAKE}\nNEXT=1`, 'SMTP_PASS=[REDACTED]\nNEXT=1'],
    [`password is ${FAKE}.`, 'password is [REDACTED].'],
    ['before\n-----BEGIN PRIVATE KEY-----\nMIIFAKE\n-----END PRIVATE KEY-----\nafter', 'before\n[REDACTED PRIVATE KEY]\nafter'],
  ]) assert.equal(scrubEntryText(input), expected);
});

test('a private key cut anywhere leaves none of its body', () => {
  const key = '-----BEGIN PRIVATE KEY-----\n' + 'MIIFAKEKEYBODY'.repeat(40) + '\n-----END PRIVATE KEY-----';
  const text = 'x'.repeat(100) + key;
  for (const cut of [120, 300, 500, text.length - 10]) assert.ok(!scrubEntryText(text.slice(0, cut)).includes('FAKEKEYBODY'), 'cut at ' + cut);
});

// Item 2: a mention never wipes the whole entry.
test('a data URI in a log entry loses only its payload', () => {
  assert.equal(scrubEntryText('Embed it as <img src="data:image/png;base64,iVBORw0KGgoFAKEFAKE"> and keep the alt text.'),
    'Embed it as <img src="data:image/png;base64,[REDACTED MEDIA CONTENT]"> and keep the alt text.');
  assert.equal(scrubEntryText('![chart](data:image/png;base64,iVBORw0KGgoFAKE) shows the trend'),
    '![chart](data:image/png;base64,[REDACTED MEDIA CONTENT]) shows the trend');
  const wrapped = 'data:image/png;base64,' + 'QUJD'.repeat(19) + '\n' + 'QUJD'.repeat(19) + '\nThe next line stays.';
  assert.equal(scrubEntryText(wrapped), 'data:image/png;base64,[REDACTED MEDIA CONTENT]\nThe next line stays.');
  const json = scrubEntryText('{"note":"see the image","url":"data:image/png;base64,iVBORFAKE"}');
  assert.ok(json.includes('see the image') && !json.includes('iVBORFAKE'));
  assert.equal(scrubEntryText('the data: field has 5 rows'), 'the data: field has 5 rows');
  const once = scrubEntryText('data:image/png;base64,iVBORFAKE tail');
  assert.equal(scrubEntryText(once), once);
});

test('"private": true wipes a log entry only when the whole text is a privacy envelope', () => {
  for (const mention of [
    'Set "private": true in package.json so npm refuses to publish.',
    'The hook skips {"private": true, "text": "..."} payloads; everything else is logged.',
  ]) assert.equal(scrubEntryText(mention), mention);
  assert.equal(scrubEntryText('{"private": true, "text": "fake diary entry"}'), '[REDACTED PRIVATE CONTENT]');
  const nested = scrubEntryText('{"items":[{"private":true,"body":"fake diary entry"},{"body":"keep me"}]}');
  assert.ok(nested.includes('keep me') && !nested.includes('fake diary entry'));
});

test('scrubText, scrub and markedPrivate keep their whole-text behaviour for the Worker', () => {
  assert.equal(scrubText('see data:image/png;base64,iVBORFAKE here'), '[REDACTED MEDIA CONTENT]');
  assert.equal(scrubText('log line {"private": true, "a": 1}'), '[REDACTED PRIVATE CONTENT]');
  assert.equal(scrubText('{"a":{"private":true},"b":"keep"}'), '[REDACTED PRIVATE CONTENT]');
  assert.deepEqual(scrub({ note: 'data:,abc', password: 'x' }), { note: '[REDACTED MEDIA CONTENT]', password: '[REDACTED]' });
  assert.equal(markedPrivate({ a: [{ private: true }] }), true);
  assert.equal(scrubText('token: abc'), 'token: [REDACTED]');
});

// Item 4: ordinary text stays readable.
const ordinary = [
  'pass `--dry-run` to preview the change',
  'pass --force to overwrite',
  'You can pass ./config.json as the first argument',
  'pass userId as the second argument',
  'pass process.env.PORT into the server',
  'the token is refreshed every 3600 seconds',
  'token: 3 remaining',
  'Password: see the vault entry',
  'パスワード: 8文字以上が必要です',
  'パスワードをSHA256でハッシュする',
  'パスワードはargon2idで保存する',
  'トークンはlocalStorageに保存しない',
  'APIキーは環境変数ANTHROPIC_API_KEYで渡す',
  'token getAccessTokenSilently returns a promise',
  'interface User { token: string; password: string }',
  'secret: true',
  'pin 18.x and test again',
  'PIN 1.2.3 of the dependency',
  'set the pw to v2 later',
  'Pass 2: run the migration',
  'PIN: required on every login',
  'https://github.com/acme/cf-memory/blob/main/src/logs.ts#L12',
  'import "@vite/client"',
  'the token count exceeded 200000 tokens',
  'token budget 1500',
  'access key rotation policy',
  'is the password correct?',
  'max_tokens: 4096',
  'if (password == null) return',
  'the password for this account is required',
  'docker run -p 8080:80 -u 1000:1000 app',
  'mysql -u root -p mydb',
  'echo hello | grep h',
  'wc -w <<< "two words"',
  'password is case-sensitive',
  'Use password: <your-password> here',
  'echo "$CF_TOKEN" | wrangler secret put CF_TOKEN',
  'login: https://example.test/login',
  'run docker login with --password-stdin',
];
for (const text of ordinary) test('scrubEntryText keeps ordinary text: ' + text, () => assert.equal(scrubEntryText(text), text));

// Item 3: no input makes the scrubber quadratic. The server scrubs up to 64 KB per entry.
test('scrubEntryText and scrubText stay fast on hostile 64 KB inputs', () => {
  const N = 65536, fill = s => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs = {
    'TOKEN run': fill('TOKEN'), 'keyword words': fill('password '), 'pin is': fill('pin is '), 'パスワード': fill('パスワード'),
    'phrase without a value': fill('パスワードを教えます'), 'colons': fill('password:'), 'scheme then colons': 'a://' + fill(':'),
    'JWT-like run': fill('eyJ-'), 'emails': fill('a@b.co '), 'joined emails': fill('a@b.co'), 'email without a dot': 'x@' + fill('a-'),
    'URL userinfo': fill('http://a'), 'escaped quotes': '"' + fill('\\"'), 'short quoted strings': fill('"a" '), 'JSON openers': fill('{"a":'),
    'data URIs': fill('data:,'), 'base64 data URI': 'data:image/png;base64,' + fill('QUJD'), 'BEGIN lines': fill('-----BEGIN PRIVATE KEY-----'),
    'private tags': fill('<private>'), 'curl -u': fill('curl -u a'), 'mysql -p': fill('mysql -p'), 'echo pipes': fill('echo x |'),
    'here-strings': fill('<<< '), 'config set': fill('config set '), 'env names': fill('A_B_C_D_E_F_'), 'token prefixes': fill('sk-hf_SG.'),
    'credential pairs': fill('credentials: a / '), 'whitespace run': 'password' + ' '.repeat(N) + 'x', 'phrase gap': fill('the password for the '),
    'mixed keywords': fill('pass token secret pw pwd PIN pin api key '), 'commas': 'password is a' + fill(',a'),
    'normal reply': fill('Here is the fix: `const token = getToken();` then run `npm test`. The password reset flow now passes; パスワードは変更済みです。\n'),
  };
  // Best of 5 under a 150 ms ceiling: a quadratic pattern takes seconds on these inputs, a loaded machine tens of ms.
  const slowest = (fn, text) => { let best = Infinity; for (let i = 0; i < 5; i++) { const t = performance.now(); fn(text); best = Math.min(best, performance.now() - t); } return best; };
  for (const [name, text] of Object.entries(inputs)) {
    for (const fn of [scrubEntryText, scrubText]) {
      const ms = slowest(fn, text);
      assert.ok(ms < 150 * SLOW, `${fn.name} on ${name}: ${ms.toFixed(1)} ms`);
    }
  }
});

test('a key header without an END line takes only the key body, not the rest of the text (review 7)', () => {
  assert.equal(scrubEntryText('key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEFAKEFAKE\n(truncated)'), 'key:\n[REDACTED PRIVATE KEY]\n(truncated)');
  assert.equal(scrubEntryText('The file must start with `-----BEGIN OPENSSH PRIVATE KEY-----`. Then run `ssh-add`.'), 'The file must start with `[REDACTED PRIVATE KEY]`. Then run `ssh-add`.');
  assert.equal(scrubEntryText('-----BEGIN PRIVATE KEY----- MIIEvFAKEfakeFAKEfake1234567890abcdEFGH'), '[REDACTED PRIVATE KEY]');
  const started = performance.now(); scrubEntryText('-----BEGIN PRIVATE KEY-----'.repeat(38000));
  assert.ok(performance.now() - started < 500 * SLOW, 'many headers without END stay linear');
});
