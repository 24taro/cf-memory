// Review round 3 (security): Japanese particles, shell continuations, code and SQL
// literals, key names, Markdown tables, whole-JSON entries and over-redaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubEntryText, scrubText } from '../scripts/redact.mjs';
// Time limits are for a fast laptop; a slower machine sets CF_MEMORY_TEST_TIME_SCALE (CI uses 10).
const SLOW = Number(process.env.CF_MEMORY_TEST_TIME_SCALE) || 1;

const once = text => { const out = scrubEntryText(text); assert.equal(scrubEntryText(out), out, 'idempotent: ' + JSON.stringify(text)); return out; };
const leaks = (cases, secret = /Fake|ねこ|さくら|correct horse|8f7a6b5c|Zx9/) => { for (const text of cases) assert.ok(!secret.test(once(text)), JSON.stringify(text) + ' → ' + JSON.stringify(scrubEntryText(text))); };
const stays = cases => { for (const text of cases) assert.equal(once(text), text); };

test('an English keyword followed by a Japanese particle, パス and ID/password pairs', () => {
  leaks(['PWはFake1234です', 'passwordは Fake1234 です', 'DBのpasswordはFake1234', 'tokenは ghx0Fake1234abcd', 'pwは「Fake1234」', 'ID/PWは admin/Fake1234',
    'パスはFake1234です', 'ログインパスは Fake1234', 'IDとパスワードは admin / Fake1234', 'pw→Fake1234x', 'password -> Fake1234x', 'アクセスキーは AKIDFAKE1234567890',
    'wifiのパスワード「ねこ２２」', 'パスワードを「ねこ２２」に', 'パスワードは「さくら２０２４」です', 'パスワードは"correct horse"です']);
  stays(['パスは /usr/bin です', 'パスは src/app です', 'パスタは美味しい', 'パスポートを更新', 'PATHのパスに追加', 'passwordは8文字以上', 'tokenは期限切れ',
    'パスワードは忘れました', 'パスワード「忘れた」', 'パスワード: 8文字以上', 'トークン数は12000です']);
});

test('command-argument rules cross shell continuations; more password flags', () => {
  leaks(['docker login r \\\n -u a \\\n -p FakeDockerPw1', 'mysql -h db \\\n -pFakeMysqlPw1', 'curl https://x \\\n -u admin:FakeCurlPw1', 'sshpass \\\n -p FakeSshPw1 ssh h',
    'redis-cli -h x \\\n -a FakeRedisPw1 ping', 'zip -P FakeZipPw1 a.zip f', 'unzip -P FakeZipPw1 a.zip', '7z a -pFake7zPw1 a.7z f', 'openssl enc -aes256 -k FakeOsslPw1 -in f',
    'security add-generic-password -a me -s svc -w FakeKcPw1', 'keytool -genkey -storepass FakeKs1 -keypass FakeKey1', 'smbclient //h/s -U bob%FakeSmbPw1',
    'mongosh mongodb://h -u a -p FakeMongoPw1', 'requirepass FakeRedisConf1', 'rabbitmqctl add_user bob FakeRmqPw1', 'htpasswd -b .htpasswd alice FakeHt1x']);
  stays(['docker run -p 8080:80 -u 1000:1000 img', 'zip -r out.zip src', 'ssh -p 2222 host']);
});

test('code and SQL literals, escaped JSON, key/value tuples and key names', () => {
  leaks(["'password' => 'FakePhpPw1',", ":password => 'FakeRbPw1'", "define('DB_PASSWORD', 'FakeWpPw1');", "CREATE USER 'u'@'%' IDENTIFIED BY 'FakeSqlPw1';",
    "ALTER USER u IDENTIFIED WITH mysql_native_password BY 'FakeSqlPw2';", "CREATE ROLE app WITH LOGIN PASSWORD 'FakePgPw1';", 'body={\\"password\\":\\"FakeEsc123\\"}',
    '[["X-Api-Key","8f7a6b5c4d3e2f1a0b9c"]]', "('password','FakeTuplePw1')", 'encryption_key = "Zx9fakeKeyValue1234"', 'signing_key: 8f7a6b5c4d3e2f1a0b9c8d7e',
    'masterKey: "Zx9fakeMasterKey12345"', 'SLACK_SIGNING=Zx9fakeSign', 'DJANGO_SALT=Zx9fakeSalt', 'password: | # prod\n    FakeBlockCmt1']);
  stays(['primary_key = True', 'sort_key: name', 'cache_key = "user:1234"', 'users.map(u => u.name)', 'const token = await getToken()', 'password = input("Password: ")',
    'const password = req.body.password;', "tokenize='trigram'", 'tokenizer: trigram', 'secretName: tls-cert', 'token_endpoint: https://idp.example.com/oauth/token',
    "fetch(u, { credentials: 'include' })", 'API_KEY=your-api-key-here']);
});

test('Markdown tables: password, token, key and pass columns; design tokens and yes/no stay', () => {
  leaks(['| Service | Token |\n|---|---|\n| gh | 8f7a6b5c4d3e2f1a0b9c |', '| User | Pass |\n|---|---|\n| admin | Fake1234 |', '| Name | Key |\n|---|---|\n| stripe | Zx9FakeKey77 |',
    'User | Password\n--- | ---\nadmin | Fake1234', '| password | Fake1234 |']);
  stays(['| Design token | Value |\n|---|---|\n| color-primary | #0055ff |\n| space-4 | 16px |', '| Primary token | #0055ff |', '| Name | Secret |\n|---|---|\n| a | yes |\n| b | no |',
    '| Suite | Pass | Fail |\n|---|---|---|\n| unit | 12 | 0 |', 'a | b in prose']);
  const t = performance.now(); scrubEntryText('|pw|' + 'ab|'.repeat(20000)); assert.ok(performance.now() - t < 500 * SLOW, 'a 64 KB table row stays linear');
});

test('a whole-JSON entry keeps its own text; credential values are redacted in place', () => {
  const pretty = JSON.stringify({ name: 'app', password: 'Fak3Pw1', items: Array.from({ length: 1500 }, (_, i) => i) }, null, 2);
  const out = once(pretty);
  assert.ok(out.includes('"password": "[REDACTED]"') && !out.includes('Fak3Pw1'));
  assert.equal(out.replace('"[REDACTED]"', '"Fak3Pw1"'), pretty, 'nothing else changed: no minifying, no 1,000-item cut');
  stays(['{"token_endpoint":"https://idp.example.com/token","authorization_endpoint":"https://idp.example.com/auth"}', '{"password": {"type":"string","minLength":8}}',
    '"cookie": {"secure": true, "httpOnly": true, "sameSite": "lax"}', 'Config: {"password": {"minLength": 12, "requireSymbol": true}, "lockout": 5}', '{"token_count": "17"}']);
  assert.equal(once('{"password": {"type":"string","default":"Fak3Pw1"}}'), '{"password": "[REDACTED]"}');
  assert.equal(once('{"private": true, "text": "x"}'), '[REDACTED PRIVATE CONTENT]');
  assert.equal(scrubText('{"password":"Fak3Pw1","user":"a"}'), '{"password":"[REDACTED]","user":"a"}', 'scrubText still rebuilds JSON');
});

test('false positives from review 3 stay readable', () => {
  stays(['counts: 4000 1000 2000 3000', 'service:8080:GET:/users:200', 'redis:6379:0:user:list', '{"Dimensions":[{"Name":"InstanceId","Value":"i-0abc1234def567890"}]}',
    'Set the Cookie: header before calling fetch, then retry.']);
  assert.equal(once('https://x/cb#access_token=Fak3Tok123&token_type=bearer'), 'https://x/cb#access_token=[REDACTED]&token_type=bearer');
  assert.equal(once("connect(password='Fak3Secret')"), "connect(password='[REDACTED]')");
  assert.equal(once("curl -d 'username=admin&password=Fake1x' https://x/login"), "curl -d 'username=admin&password=[REDACTED]' https://x/login");
  assert.equal(once('card 4111 1111 1111 1111 exp 12/29'), 'card [REDACTED CARD] exp 12/29');
});

test('round 4: secrets inside JSON strings and argv arrays get the full log scrub', () => {
  leaks(['"args": ["x","--password","Fake1234x"]', '["redis-cli","-a","FakeRedis1"]', '["mysql","-u","root","-pFakeMy1"]', 'args:\n  - --password\n  - Fake1234x\n',
    '{"msg":"the password is \\"Fake12x34\\""}', '{"conf":"port 6379\\nrequirepass FakeRedis1"}', '{"db":"mysql -u root -p\\"Fake My1\\" app"}',
    '{"mcpServers":{"db":{"command":"npx","args":["-y","server","--token","ghxFake1234abcd"]}}}']);
  stays(['["docker","run","-p","8080:80","img"]', '["npm","run","build"]']);
  assert.equal(once('{"db":"mysql -u root -p\\"Fake My1\\" app"}'), '{"db":"mysql -u root -p[REDACTED] app"}', 'the JSON string stays valid');
});

test('round 4: continuations between a flag and its value, => arrows, htpasswd forms, auth tuples, mid-line Authorization', () => {
  leaks(['docker login r -u a -p \\\n FakeDock1', 'redis-cli -h x -a \\\n FakeRedis1', 'keytool -importkeystore \\\n -srcstorepass FakeKs1', 'zip -rP FakeZip1 a.zip x',
    'password => Fake1234x', 'token => ghxFake1234abcdEF', 'PASSWORD=>Fake1234x', 'パスワード => Fake1234x', 'htpasswd -nbB alice FakeHt1', 'htpasswd -B -b -C 10 .htpasswd alice FakeHt1',
    "auth=('admin', 'Fake1234x')", "requests.get(u, auth=HTTPBasicAuth('admin','Fake1234x'))", 'sent Authorization: SSWS 00FakeOkta1234abcd',
    'x Authorization: Splunk 1234abcd-56ef-7890Fake', 'deploy --token Fake1234abcd now']);
  stays(['htpasswd -c .htpasswd alice', 'x = a => b', 'the Authorization: header is required', 'docker login --password-stdin r']);
});

test('round 4: ordinary key names and validation rules stay', () => {
  stays(['sort_key = "created_at_2024_01_01"', 'primaryKey: "user_1234567890abcdef"', 'partition_key = "tenant_1234567890abcd"', 'idempotency_key: req_1234567890abcdefgh',
    'storage_key = "avatars/u123456789.png"', "'password' => 'required|min:8'", 'hashKey: "id_1234567890abcdef"']);
  leaks(['encryption_key = "Zx9fakeKeyValue1234"', 'session_salt: 8f7a6b5c4d3e2f1a0b9c', 'webhook_secret_key: Zx9fake1234567890ab']);
});

test('round 5: index assignments, YAML name/value pairs, CloudFormation parameters, XML, Go DSNs', () => {
  leaks(["app.config['SECRET_KEY'] = 'Fake1234abcdefgh'", 'os.environ["DB_PASSWORD"] = "Fake1234x"', "ENV['GITHUB_TOKEN'] = 'ghxFake1234abcd'", "$config['db_password'] = 'Fake1234x';",
    "headers['X-Api-Key'] = 'Fake1234abcd'", 'env:\n  - name: DB_PASSWORD\n    value: Fake1234x\n', '- {name: API_KEY, value: Fake1234abcd}',
    '{"ParameterKey":"DBPassword","ParameterValue":"Fake1234x"}', '<server><username>me</username><password>Fake1234x</password></server>',
    '<property name="spring.datasource.password" value="Fake1234x"/>', '<add key="ApiToken" value="Fake1234abcd"/>', '<string name="api_key">Fake1234abcd</string>',
    'root:Fake1234x@tcp(127.0.0.1:3306)/app']);
  stays(['env:\n  - name: LOG_LEVEL\n    value: debug\n', '{"ParameterKey":"InstanceType","ParameterValue":"t3.micro"}', '<password>${env.PW}</password>',
    '<string name="app_name">Demo</string>', '<tokenizer>trigram</tokenizer>', 'x["password"] == "a"']);
});

test('round 5: an input up to 1 MiB that redaction lengthens is not dropped', () => {
  const text = 'my email is me@x.io and the rest ' + 'word '.repeat(209000);
  assert.ok(text.length <= 1024 * 1024);
  const out = scrubEntryText(text);
  assert.ok(out.startsWith('my email is (email omitted)'), out.slice(0, 60));
  assert.ok(out.length > text.length);
  assert.equal(scrubEntryText('x'.repeat(1024 * 1024 + 1)), '[REDACTED OVERSIZE CONTENT]');
});

test('round 5: login and admin command flags, basic-auth helpers, setters, SQL SET PASSWORD and fallbacks', () => {
  leaks(['az login --service-principal -u app -p Fake1234abcdefgh --tenant t', 'oc login -u admin -p Fake1234x https://api:6443', 'twine upload -u __token__ -p Fake1234abcdefgh dist/*',
    'sqlcmd -S h -U sa -P Fake1234x', 'ldapsearch -x -D cn=admin -w Fake1234x', 'echo Fake1234x | sudo -S apt update', 'cli --secret-key Fake1234x',
    "httpx.BasicAuth('admin', 'Fake1234x')", "requests.post(u, auth=(user, 'Fake1234x'))", 'ds.setPassword("Fake1234x");',
    'const password = process.env.DB_PASSWORD || "Fake1234x";', "SET PASSWORD FOR 'u'@'h' = 'Fake1234x';", "os.getenv('API_TOKEN', 'Fake1234abcd')"]);
  stays(['docker run -p 8080:80 img', 'cf push app -p ./dist', 'az group list -o table', 'user.setName("Alice")', 'const x = a || "default"']);
  const started = performance.now(); scrubEntryText('password' + ' '.repeat(65536) + 'x');
  assert.ok(performance.now() - started < 300 * SLOW, 'a long whitespace run after a credential name stays linear');
});

test('round 6: Markdown labels, typed assignments, email users, defaults, PowerShell, positional passwords', () => {
  leaks(['**Password:** Fake1234x', '- **Password**: Fake1234x', '**API Key:** Fake1234abcdefgh', '**パスワード:** Fake1234x', '- `JWT_SECRET`: `Fake1234abcdefgh`',
    'Set `DB_PASSWORD` to `Fake1234x`', 'Add `STRIPE_WEBHOOK_SECRET` = `whsecFake1234`',
    'db_password: str = "Fake1234x"', 'private readonly apiKey: string = "Fake1234abcd"', 'val password: String = "Fake1234x"', 'const API_KEY: string = "Fake1234abcd"',
    'password: Optional[str] = "Fake1234x"', 'const API_KEY: &str = "Fake1234abcd";',
    'curl -u me@example.com:Fake1234abcdTOKEN https://acme.atlassian.net/rest', 'curl --user "me@x.com:Fake1234abcd" https://x', 'login: me@example.com / Fake1234x',
    'ログイン情報: test@example.com / Fake1234x', 'smbclient //h/s -U me@corp.com%Fake1234x',
    'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-Fake1234x}', '$password = ConvertTo-SecureString "Fake1234x" -AsPlainText -Force', 'the password has been set to Fake1234x',
    'ssh-keygen -t ed25519 -N "Fake1234x" -f k', 'Ocp-Apim-Subscription-Key: 8f7a6b5c4d3e2f1a0b9c', 'DriverManager.getConnection(url, "root", "Fake1234x");',
    "new Sequelize('app', 'root', 'Fake1234x', {})", "smtp.login('bot@example.com', 'Fake1234x')"]);
  stays(["password = request.form['password']", 'token = tokens[0]', 'SELECT * FROM t WHERE token = $1', 'tokenize: str = "trigram"', '**Note:** the password must be 8+ chars',
    '`password` is required', 'x = { password: string }', 'interface A { token: string; }', 'ssh-keygen -N "" -f k', 'password = Get-Content x', 'user.login(name, pw)']);
});

test('round 7: space, dot and bracket runs stay linear; package.json and key mentions keep their text; a second pass is stable', () => {
  for (const text of ['api_key:' + ' '.repeat(32000) + 'x', 'Authorization: a' + ' '.repeat(131072) + 'x', '"password":' + '.'.repeat(131072) + 'x', 'token=x' + ')'.repeat(65536)]) {
    const started = performance.now(); scrubEntryText(text);
    assert.ok(performance.now() - started < 300 * SLOW, JSON.stringify(text.slice(0, 20)) + ' took ' + Math.round(performance.now() - started) + ' ms');
  }
  const pkg = '{\n  "name": "my-app",\n  "private": true,\n  "scripts": {\n    "dev": "vite"\n  }\n}';
  assert.equal(scrubEntryText(pkg), pkg, 'a package.json is no privacy envelope');
  assert.equal(scrubEntryText('{"private": true, "text": "fake diary"}'), '[REDACTED PRIVATE CONTENT]');
  const once = scrubEntryText('"authToken": string;\\n  region: x');
  assert.equal(scrubEntryText(once), once);
  stays(['db_password: str = "${DB_PASSWORD}"']);
  leaks(['db_password: str = "Fake1234x"', 'password: Optional[str] = "Fake1234x"']);
});
