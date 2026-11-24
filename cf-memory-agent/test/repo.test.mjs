import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHILD_SCAN_MS, localRepo, normalizeRemote, resolveRepo, stripUserinfo } from '../scripts/repo.mjs';
import { tempDir } from './helpers/fake-server.mjs';

test('network remotes normalize to host and repository path', () => {
  const cases = [
    ['git@github.com:acme/cf-memory.git', '//github.com/acme/cf-memory'],
    ['https://github.com/acme/cf-memory.git', '//github.com/acme/cf-memory'],
    ['https://GITHUB.com/acme/cf-memory', '//github.com/acme/cf-memory'],
    ['https://user:fixture-pass@github.com/acme/cf-memory.git', '//github.com/acme/cf-memory'],
    ['ssh://git@github.com:22/acme/cf-memory.git', '//github.com/acme/cf-memory'],
    ['https://github.com:22/acme/cf-memory.git', '//github.com:22/acme/cf-memory'],
    ['ssh://git@gitlab.example.com/group/sub/project.git', '//gitlab.example.com/group/sub/project'],
    ['ssh://git@gitlab.example.com:2222/group/sub/project.git', '//gitlab.example.com:2222/group/sub/project'],
    ['git@internal:team/tool.git', '//internal/team/tool'],
    ['git@[2001:db8::4]:team/tool.git', '//[2001:db8::4]/team/tool'],
    ['ssh://git@[2001:db8::4]/team/tool.git', '//[2001:db8::4]/team/tool'],
    ['/srv/git/local-repo.git', ''],
    ['file:///srv/git/file-repo.git', ''],
    ['https://github.com/acme/cf-memory/', '//github.com/acme/cf-memory'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeRemote(input), expected, input);
});

test('long repo keys preserve distinguishing path segments within the protocol limit', () => {
  const prefix = 'github.com/teams/' + 'archive/'.repeat(130);
  const a = normalizeRemote(`https://${prefix}one.git`);
  const b = normalizeRemote(`git@${prefix.replace('/', ':')}two.git`);
  assert.match(a, /^\/\/github\.com\/.*#[0-9a-f]{32}$/);
  assert.equal(a.length, 200);
  assert.equal(b.length, 200);
  assert.notEqual(a, b);
  assert.equal(normalizeRemote(`ssh://${prefix}one`), a);
});

test('userinfo is stripped from URL remotes, scp user is kept', () => {
  assert.equal(stripUserinfo('https://user:fixture-pass@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(stripUserinfo('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});

test('resolveRepo immediately tracks origin changes and falls back to the checkout path', () => {
  const dir = tempDir();
  try {
    const repoDir = join(dir.path, 'checkout');
    mkdirSync(repoDir);
    execFileSync('git', ['-C', repoDir, 'init', '-q']);
    execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://user:fixture-pass@github.com/example/demo.git?access_token=fixture-query']);
    const home = join(dir.path, 'home');
    const first = resolveRepo(repoDir, { home, now: 1000 });
    assert.deepEqual(first, { repo: '//github.com/example/demo', remote: 'https://github.com/example/demo.git', contexts: ['https://github.com/example/demo.git'] });
    assert.ok(!existsSync(join(home, 'repo-cache.json')), 'the current origin is read directly');
    execFileSync('git', ['-C', repoDir, 'remote', 'set-url', 'origin', 'ssh://git@git.example.com/example/demo.git']);
    assert.equal(resolveRepo(repoDir, { home, now: 2000 }).repo, '//git.example.com/example/demo');
    execFileSync('git', ['-C', repoDir, 'remote', 'set-url', 'origin', 'file:///srv/git/example/demo.git']);
    assert.equal(resolveRepo(repoDir, { home, now: 3000 }).repo, localRepo(repoDir));
    const plain = join(dir.path, 'plain-folder');
    mkdirSync(plain);
    const local = resolveRepo(plain, { home, now: 5000 }).repo;
    assert.match(local, /^plain-folder#[0-9a-f]{32}$/);
    assert.equal(local, localRepo(plain));
    const twin = join(dir.path, 'elsewhere', 'plain-folder');
    mkdirSync(twin, { recursive: true });
    assert.notEqual(resolveRepo(twin, { home, now: 5000 }).repo, local, 'same name, different directory: a different repo');
  } finally { dir.cleanup(); }
});

test('a parent of several checkouts gives their remotes as Recall contexts', () => {
  const dir = tempDir();
  try {
    for (const [name, remote] of [['a', 'git@github.com:org/a.git'], ['b', 'git@github.com:org/b.git']]) {
      const path = join(dir.path, 'parent', name);
      mkdirSync(path, { recursive: true });
      execFileSync('git', ['-C', path, 'init', '-q']);
      execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
    }
    const result = resolveRepo(join(dir.path, 'parent'), { home: join(dir.path, 'home'), now: 1, children: true });
    assert.match(result.repo, /^parent#[0-9a-f]{32}$/);
    assert.deepEqual(result.contexts, ['git@github.com:org/a.git', 'git@github.com:org/b.git']);
  } finally { dir.cleanup(); }
});

test('the child scan spends at most CHILD_SCAN_MS in all, keeps what it found, and the next call goes on from there (review r7)', () => {
  const dir = tempDir();
  try {
    const parent = join(dir.path, 'parent'), names = Array.from({ length: 12 }, (_, i) => 'repo' + String(i).padStart(2, '0'));
    for (const name of names) mkdirSync(join(parent, name), { recursive: true });
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const asked = [];
    // A slow git: 400 ms a call; the parent itself has no remote.
    const git = (_, args, options) => {
      const name = basename(args[1]);
      if (name === 'parent') throw Error('no remote');
      asked.push(name);
      if (options.timeout < 400) { sleep(options.timeout); throw Object.assign(Error('timed out'), { code: 'ETIMEDOUT' }); }
      sleep(400);
      return 'git@github.com:org/' + name + '.git\n';
    };
    const home = join(dir.path, 'home');
    let found = [], calls = 0;
    while (found.length < names.length && calls < names.length) {
      const started = performance.now();
      const { contexts } = resolveRepo(parent, { home, now: ++calls, git, children: true });
      assert.ok(performance.now() - started < CHILD_SCAN_MS + 500, 'call ' + calls + ' took ' + Math.round(performance.now() - started) + ' ms');
      assert.ok(contexts.length > found.length, 'each call goes on from the last');
      found = contexts;
    }
    assert.ok(calls > 1, 'not all in one call');
    assert.deepEqual(found, names.map(name => 'git@github.com:org/' + name + '.git'));
    assert.ok(names.every(name => asked.filter(other => other === name).length <= 2), 'only a call the scan cut short is asked again: ' + asked.join());
    asked.length = 0;
    assert.equal(resolveRepo(parent, { home, now: 99, git, children: true }).contexts.length, names.length);
    assert.deepEqual(asked, [], 'a finished scan is cached');
  } finally { dir.cleanup(); }
});

test('a child whose git hangs is skipped after it was cut short twice, so later children are reached (review 4)', () => {
  const dir = tempDir();
  try {
    const parent = join(dir.path, 'parent');
    for (const name of ['a-slow', 'b-repo', 'c-repo']) mkdirSync(join(parent, name), { recursive: true });
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const git = (_, args, options) => {
      const name = basename(args[1]);
      if (name === 'parent') throw Error('no remote');
      if (name === 'a-slow') { sleep(options.timeout); throw Object.assign(Error('timed out'), { code: 'ETIMEDOUT' }); }
      return 'git@github.com:org/' + name + '.git\n';
    };
    const home = join(dir.path, 'home');
    let contexts = [];
    for (let call = 1; call <= 3 && !contexts.length; call++) contexts = resolveRepo(parent, { home, now: call, git, children: true }).contexts;
    assert.deepEqual(contexts, ['git@github.com:org/b-repo.git', 'git@github.com:org/c-repo.git']);
    const started = performance.now();
    resolveRepo(parent, { home, now: 4, git, children: true });
    assert.ok(performance.now() - started < 200, 'a finished scan is cached');
  } finally { dir.cleanup(); }
});
