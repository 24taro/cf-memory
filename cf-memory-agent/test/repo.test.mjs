import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHILD_SCAN_MS, localRepo, normalizeRemote, resolveRepo, stripUserinfo } from '../scripts/repo.mjs';
import { tempDir } from './helpers/fake-server.mjs';

test('remotes normalize to owner/name', () => {
  const cases = [
    ['git@github.com:acme/cf-memory.git', 'acme/cf-memory'],
    ['https://github.com/acme/cf-memory.git', 'acme/cf-memory'],
    ['https://github.com/acme/cf-memory', 'acme/cf-memory'],
    ['https://user:fixture-pass@github.com/acme/cf-memory.git', 'acme/cf-memory'],
    ['ssh://git@github.com:22/acme/cf-memory.git', 'acme/cf-memory'],
    ['ssh://git@gitlab.example.com/group/sub/project.git', 'group/sub/project'],
    ['git@internal:team/tool.git', 'team/tool'],
    ['/srv/git/local-repo.git', 'local-repo'],
    ['file:///srv/git/file-repo.git', 'file-repo'],
    ['https://github.com/acme/cf-memory/', 'acme/cf-memory'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeRemote(input), expected, input);
});

test('userinfo is stripped from URL remotes, scp user is kept', () => {
  assert.equal(stripUserinfo('https://user:fixture-pass@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(stripUserinfo('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});

test('resolveRepo reads the git remote, caches it, and falls back to the cwd name plus a hash of its path', () => {
  const dir = tempDir();
  try {
    const repoDir = join(dir.path, 'checkout');
    mkdirSync(repoDir);
    execFileSync('git', ['-C', repoDir, 'init', '-q']);
    execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://user:fixture-pass@github.com/example/demo.git']);
    const home = join(dir.path, 'home');
    const first = resolveRepo(repoDir, { home, now: 1000 });
    assert.deepEqual(first, { repo: 'example/demo', remote: 'https://github.com/example/demo.git', contexts: ['https://github.com/example/demo.git'] });
    assert.ok(!readFileSync(join(home, 'repo-cache.json'), 'utf8').includes('fixture-pass'), 'credentials never reach the cache');
    let calls = 0;
    const git = () => { calls++; throw Error('not called while cached'); };
    assert.equal(resolveRepo(repoDir, { home, now: 2000, git }).repo, 'example/demo');
    assert.equal(calls, 0);
    resolveRepo(repoDir, { home, now: 1000 + 11 * 60 * 1000, git });
    assert.equal(calls, 1, 'expired cache asks git again');
    const plain = join(dir.path, 'plain-folder');
    mkdirSync(plain);
    const local = resolveRepo(plain, { home, now: 5000 }).repo;
    assert.match(local, /^plain-folder#[0-9a-f]{8}$/);
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
    assert.match(result.repo, /^parent#[0-9a-f]{8}$/);
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
