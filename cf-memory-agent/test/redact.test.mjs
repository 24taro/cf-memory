import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubEntryText, scrubFreeTextSecrets, scrubText } from '../scripts/redact.mjs';

// Values below are obviously fake fixtures; test names never contain them.
const redacted = [
  ['Japanese keyword followed directly by the value', 'パスワードAbc12345で接続', 'パスワード[REDACTED]で接続'],
  ['Japanese keyword with は and a space', 'パスワードは Abc12345', 'パスワードは [REDACTED]'],
  ['English "is" connector', 'password is hunter22', 'password is [REDACTED]'],
  ['short keyword with a colon', 'pw: xyz789', 'pw: [REDACTED]'],
  ['PIN-style digits after 暗証番号', '暗証番号 1234', '暗証番号 [REDACTED]'],
  ['capital PIN with digits', 'PIN 4321 for the door', 'PIN [REDACTED] for the door'],
  ['full-width colon', 'パスワード：Fake99zz', 'パスワード：[REDACTED]'],
  ['quoted value in Japanese prose', 'パスワードは「Fake1234」です', 'パスワードは「[REDACTED]」です'],
  ['"to" connector', 'set the password to Fake1234!', 'set the password to [REDACTED]'],
  ['APIキー with は', 'APIキーはfake1234abcd5678です', 'APIキーは[REDACTED]です'],
  ['token with a colon and a credential-like value', 'token: fake0123abcd', 'token: [REDACTED]'],
  ['a long value after a colon', 'Password: fakehorsebattery', 'Password: [REDACTED]'],
  ['passwd without connector', 'passwd Fake-pass_1', 'passwd [REDACTED]'],
  ['command-line style flag', 'mysql --pass=Fake99 db', 'mysql --pass=[REDACTED] db'],
  ['secret with a long random value', 'secret fakeFAKEfake1234567890', 'secret [REDACTED]'],
  ['upper-case keyword', 'PASSWORD IS Hunter2Fake', 'PASSWORD IS [REDACTED]'],
];
for (const [name, input, expected] of redacted) test('free-text scrubber redacts: ' + name, () => assert.equal(scrubFreeTextSecrets(input), expected));

const kept = [
  ['changing a password in Japanese', 'パスワードを変えておく'],
  ['a password reset flow', 'password reset flow'],
  ['title case prose', 'Password Reset Flow'],
  ['a required password', 'The password is required'],
  ['an invalid token', 'token is invalid'],
  ['token budgets and counts', 'token budget 1500, max token 4096'],
  ['lower-case pin of a version', 'pin 1.2.3 of lodash'],
  ['words that contain a keyword', 'bypass 12345 and passport 12345678 and tokens 99999999'],
  ['passing tests', 'pass the test suite'],
  ['secret sauce', 'the secret sauce'],
  ['Japanese prose without a value', 'パスワードは変更済みです。暗証番号を忘れた'],
  ['a short plain label after a colon', 'token: abc'],
];
for (const [name, input] of kept) test('free-text scrubber keeps ordinary prose: ' + name, () => assert.equal(scrubFreeTextSecrets(input), input));

test('free-text scrubber does not touch an existing marker', () => {
  assert.equal(scrubFreeTextSecrets('password: [REDACTED]'), 'password: [REDACTED]');
});

test('scrubEntryText combines structured and prose scrubbing', () => {
  const out = scrubEntryText('Authorization: Bearer fixtureBearer123 and パスワードはFake5678 and API_KEY=fixturekey99');
  assert.ok(!out.includes('fixtureBearer123'));
  assert.ok(!out.includes('Fake5678'));
  assert.ok(!out.includes('fixturekey99'));
  assert.equal(scrubEntryText('plain words stay'), 'plain words stay');
});

test('scrubText (kept from the old agent) still redacts known token shapes', () => {
  const out = scrubText('ghp_' + 'C'.repeat(36) + ' eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl https://user:pw@host.test/x');
  assert.ok(out.includes('[REDACTED TOKEN]'));
  assert.ok(out.includes('[REDACTED JWT]'));
  assert.ok(!out.includes('user:pw@'));
});

test('oversized text is replaced, not scanned', () => {
  assert.equal(scrubFreeTextSecrets('x'.repeat(1024 * 1024 + 1)), '[REDACTED OVERSIZE CONTENT]');
});
