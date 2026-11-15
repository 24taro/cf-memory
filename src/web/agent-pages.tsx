import type { FC } from 'hono/jsx';
import type { CaptureService, CaptureEvent, CaptureHit, CaptureSession } from '../capture';
import { Layout } from './layout';

type Health = Awaited<ReturnType<CaptureService['health']>>;
type Provenance = Awaited<ReturnType<CaptureService['provenance']>>;
const CSS = `
.agent-view{overflow-wrap:anywhere}.agent-view pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32rem;overflow:auto;font-size:.8rem;background:var(--surface-2);padding:.8rem;border-radius:8px}
.agent-view .card{margin:.7rem 0;min-width:0}.agent-view h2{font-size:1rem;color:var(--text);letter-spacing:0}
.agent-view dl{display:grid;grid-template-columns:minmax(5rem,auto) minmax(0,1fr);gap:.3rem .8rem;font-size:.85rem}.agent-view dd{margin:0}
.agent-view .agent-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem}
.agent-view label{display:block;font-size:.8rem;color:var(--text-2)}.agent-view input{width:100%;min-width:0;padding:.45rem;border:1px solid var(--border-strong);border-radius:7px;font:inherit;color:var(--text);background:var(--surface)}
.agent-view button,.agent-view .button{padding:.45rem .8rem;border:1px solid var(--border-strong);border-radius:7px;font:inherit;background:var(--surface);color:var(--accent-ink);cursor:pointer;display:inline-block}
.agent-view .state-healthy{color:var(--accent-ink)}.agent-view .state-degraded,.agent-view .state-offline{color:var(--stub)}
.agent-view .preview{font-size:.82rem;white-space:pre-wrap;max-height:8rem;overflow:hidden}.agent-view .actions{display:flex;gap:.7rem;flex-wrap:wrap;align-items:center;margin:.8rem 0}
@media(max-width:520px){.agent-view .agent-filters{grid-template-columns:1fr}}
`;
// Static source only: request/user data is never interpolated into executable JS.
const REFRESH = `(()=>{const toggle=document.getElementById('agent-refresh');let timer;
const schedule=()=>{clearTimeout(timer);if(toggle.checked&&!document.hidden)timer=setTimeout(()=>{if(toggle.checked&&!document.hidden)location.reload()},30000)};
try{toggle.checked=sessionStorage.getItem('cf-memory-health-refresh')==='true'}catch{}
toggle.addEventListener('change',()=>{try{sessionStorage.setItem('cf-memory-health-refresh',String(toggle.checked))}catch{}schedule()});
document.addEventListener('visibilitychange',schedule);schedule()})();`;
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; }
function count(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '未報告'; }
function date(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '未報告'; }
function state(value: string): string { return value === 'healthy' ? '正常' : value === 'degraded' ? '要確認' : '通信なし'; }
function distill(value: string): string { return ({ pending: '処理状況未報告', shadow: 'Shadow確認済み', processed: '確認済み', applied: '保存に使用' } as Record<string, string>)[value] || value; }
function nextLink(path: string, filters: Record<string, string>, cursor: string): string {
  const query = new URLSearchParams(filters); query.set('cursor', cursor); return path + '?' + query.toString();
}
const AgentStyle: FC = () => <style>{CSS}</style>;
const EventCard: FC<{ event: CaptureHit | CaptureEvent }> = ({ event }) => {
  const meta = event.metadata;
  const preview = 'preview' in event ? event.preview : JSON.stringify(event.payload_redacted).slice(0, 400);
  return <article class="card">
    <a href={`/capture/events/${event.id}`}><strong>{event.event_type}{event.tool_name ? ` · ${event.tool_name}` : ''}</strong></a>
    <div class="meta-row"><span class="pill">{date(event.occurred_at)}</span><span class="pill">{distill(event.distill_status)}</span><span class="pill">{event.visibility === 'project' ? 'project原典・本人のみ' : 'personal原典'}</span>
      {meta.denied === true ? <span class="pill">内容抑制</span> : null}{meta.truncated === true ? <span class="pill">Capture時に短縮</span> : null}</div>
    <p class="preview">{preview}</p>
    {strings(meta.file_refs).slice(0, 3).map(file => <div class="muted">{file}</div>)}
    <div class="actions"><a href={`/capture/sessions/${event.session_id}`}>このsessionを開く</a><a href={`/capture/events/${event.id}`}>原典の詳細</a></div>
  </article>;
};
export const CapturePage: FC<{ handle?: string; hits: CaptureHit[]; sessions: CaptureSession[]; filters: Record<string, string>; nextCursor: string | null; scanned: number; scanLimit: number; retention: number }> = p => <Layout title="Capture原典" handle={p.handle} sessionHandle={p.handle}>
  <AgentStyle /><div class="agent-view"><h1>Capture原典</h1>
  <p class="sub">本人の短期原典を調べます。共有memoryの権限とは別で、project原典も他の人には見えません。保持期間は受信後{p.retention}日です。</p>
  <form method="get" action="/capture">
    <label>キーワード（すべての語を含む）<input name="q" value={p.filters.q || ''} placeholder="例: PostgreSQL transaction" maxlength={200} /></label>
    <details open={Object.keys(p.filters).some(key => key !== 'q')}><summary>詳細条件：Tool・ファイル・repo・日時</summary><div class="agent-filters">
    {[
      ['tool_name', 'Tool名（完全一致）', 'Read'],
      ['event_type', 'Event名（完全一致）', 'PostToolUse'], ['file_ref', 'ファイル参照（完全一致）', 'src/db.ts'],
      ['repo', 'Captureのremote（完全一致）', 'https://github.com/acme/cf-memory'], ['session_id', 'Session digest', '64文字のdigest'],
      ['since', '開始日時（UTC・含む）', '2026-09-30T00:00:00Z'], ['until', '終了日時（UTC・含まない）', '2026-10-01T00:00:00Z'],
    ].map(([key, label, placeholder]) => <label>{label}<input name={key} value={p.filters[key] || ''} placeholder={placeholder} maxlength={key === 'file_ref' || key === 'repo' ? 500 : 160} /></label>)}
    </div></details>
    <div class="actions"><button type="submit">原典を検索</button><a href="/capture">条件を消す</a></div>
  </form>
  <h2>検索結果</h2><p class="muted">このページで{p.scanned}件の原典を確認（上限{p.scanLimit}件）。結果は400文字以内のプレビューです。詳細から短縮後の原典全体を読めます。</p>
  {!p.hits.length ? <p>{p.nextCursor ? 'この範囲に一致はありません。続きの原典も検索してください。' : 'この範囲に一致する保持中の原典はありません。'}</p> : null}
  {p.hits.map(event => <EventCard event={event} />)}
  {p.nextCursor ? <a class="button" href={nextLink('/capture', p.filters, p.nextCursor)}>続きの原典を検索</a> : null}
  <h2>最近のsession</h2><p class="muted">保持中の原典がないsessionも残ります。処理状況未報告には、旧clientや未処理の原典が含まれます。</p>
  <ul class="list">{p.sessions.map(s => <li><a href={`/capture/sessions/${s.id}`}>{s.platform_source || 'client不明'} · {date(s.started_at)}</a><div class="muted">保持中 {s.retained_events}件 · {s.ended_at == null ? '終了未報告' : `終了 ${date(s.ended_at)}`}</div></li>)}</ul>
  {!p.sessions.length ? <p>まだsessionがありません。<a href="/agent-health">Agentの状態を確認</a></p> : null}
  {p.sessions.length ? <a href="/capture/sessions">すべてのsessionを順に見る</a> : null}
  </div></Layout>;

export const CaptureSessionsPage: FC<{ handle?: string; sessions: CaptureSession[]; nextCursor: string | null }> = p => <Layout title="Capture session一覧" handle={p.handle} sessionHandle={p.handle}>
  <AgentStyle /><div class="agent-view"><p><a href="/capture">← 原典の検索</a></p><h1>Session一覧</h1>
  <p class="sub">本人のsessionだけを新しい順で表示します。保持期限後は原典の内容を読めません。</p>
  {!p.sessions.length ? <p>この範囲にsessionはありません。</p> : null}
  {p.sessions.map(session => <article class="card"><strong><a href={`/capture/sessions/${session.id}`}>{session.platform_source || 'client不明'} · {date(session.started_at)}</a></strong>
    <p class="mono muted">{session.id}</p><dl><dt>Client version</dt><dd>{session.client_version || '未報告'}</dd><dt>保持中の原典</dt><dd>{session.retained_events}件</dd><dt>最後の原典</dt><dd>{date(session.last_event_at)}</dd><dt>終了時刻</dt><dd>{date(session.ended_at)}</dd></dl></article>)}
  {p.nextCursor ? <a class="button" href={nextLink('/capture/sessions', {}, p.nextCursor)}>以前のsessionを見る</a> : null}
  </div></Layout>;

export const CaptureSessionPage: FC<{ handle?: string; id: string; events: CaptureEvent[]; nextCursor: string | null }> = p => <Layout title="Capture session" handle={p.handle} sessionHandle={p.handle}>
  <AgentStyle /><div class="agent-view"><p><a href="/capture">← 原典の検索</a></p><h1>Sessionの原典</h1><p class="mono muted">{p.id}</p>
  <p class="sub">保持中の原典を時刻順に表示します。通常Recallには注入されません。</p>
  {!p.events.length ? <p>保持期間内の原典はありません。保存されたmemoryのprovenanceは引き続き確認できます。</p> : null}
  {p.events.map(event => <EventCard event={event} />)}
  {p.nextCursor ? <a class="button" href={nextLink(`/capture/sessions/${p.id}`, {}, p.nextCursor)}>次の原典</a> : null}
  </div></Layout>;

export const CaptureEventPage: FC<{ handle?: string; event: CaptureEvent; around: CaptureEvent[] }> = ({ handle, event, around }) => <Layout title="Capture原典の詳細" handle={handle} sessionHandle={handle}>
  <AgentStyle /><div class="agent-view"><p><a href="/capture">← 原典の検索</a></p><h1>{event.event_type} · {event.tool_name || 'lifecycle'}</h1>
  <dl><dt>時刻</dt><dd>{date(event.occurred_at)}</dd><dt>保持期限</dt><dd>{date(event.expires_at)}</dd><dt>処理状況</dt><dd>{distill(event.distill_status)}</dd>
    <dt>Actor</dt><dd>{str(event.metadata.actor) || '未報告'}</dd><dt>Client</dt><dd>{str(event.metadata.client)} {str(event.metadata.client_version)}</dd>
    <dt>Plugin</dt><dd>{str(event.metadata.plugin_version) || '未報告'}</dd><dt>Session</dt><dd><a href={`/capture/sessions/${event.session_id}`}>{event.session_id}</a></dd>
    <dt>Event</dt><dd class="mono">{event.id}</dd><dt>Hash</dt><dd class="mono">{event.payload_hash}</dd>
    <dt>Remote</dt><dd>{strings(event.metadata.repo_context).map(repo => <div>{repo}</div>)}</dd><dt>File</dt><dd>{strings(event.metadata.file_refs).map(file => <div>{file}</div>)}</dd>
  </dl>
  <p class="muted">本人のみ閲覧できます。秘密を伏せた後の内容です。{event.metadata.denied === true ? 'deny設定により内容を保存していません。' : ''}{event.metadata.truncated === true ? 'Capture時に上限を超えた内容は短縮されています。' : ''}</p>
  <h2>原典の内容</h2><pre>{JSON.stringify(event.payload_redacted, null, 2)}</pre>
  <h2>前後の原典</h2>{around.filter(e => e.id !== event.id).map(e => <EventCard event={e} />)}
  </div></Layout>;

export const AgentHealthPage: FC<{ handle?: string; clients: Health; server: Record<string, unknown>; nonce: string }> = ({ handle, clients, server, nonce }) => <Layout title="Agentの状態" handle={handle} sessionHandle={handle}>
  <AgentStyle /><div class="agent-view"><h1>Agentの状態</h1><p class="sub">本人のclient heartbeatを表示します。最終通信から24時間を超えると通信なし、送信待ち・処理待ち・Recall停止などは要確認になります。</p>
  <div class="actions"><a class="button" href="/agent-health">最新の状態に更新</a><a href="/capture">原典を調べる</a></div>
  <label><input id="agent-refresh" type="checkbox" style="width:auto" /> 自動更新（30秒・画面を表示中のみ）</label>
  {!clients.length ? <article class="card"><strong>まだ通信を受け取っていません</strong><p>Pluginをインストールし、Captureを有効にしてsessionを開始してください。接続に失敗したclientはサーバーから見えないため、ローカルのdoctorでも確認します。</p></article> : null}
  {clients.map(client => {
    const status = client.status, hooks = record(status.hooks), lastDistill = record(hooks.distill), attempts = record(status.provider_attempts);
    return <article class="card"><strong class={`state-${client.state}`}>{state(client.state)}</strong><span class="pill">Plugin {str(status.plugin_version) || '未報告'}</span>
      <p class="muted">最終通信 {date(client.updated_at)} · client {client.client_id.slice(0, 12)}</p>
      <dl><dt>Capture</dt><dd>{status.capture_enabled === true ? '有効' : status.capture_enabled === false ? '無効' : '未報告'}</dd>
        <dt>Distill</dt><dd>{status.distill_enabled === true ? '有効' : status.distill_enabled === false ? '無効' : '未報告'}</dd>
        <dt>送信待ち</dt><dd>{count(status.pending)}</dd><dt>Spool bytes</dt><dd>{count(status.spool_bytes)}</dd><dt>最古の送信待ち</dt><dd>{status.pending === 0 ? '待ちなし' : date(status.oldest_pending_at)}</dd>
        <dt>処理待ち</dt><dd>{count(status.ready_to_distill)}</dd><dt>終了通知待ち</dt><dd>{count(status.awaiting_checkpoint)}</dd><dt>古い終了通知待ち</dt><dd>{count(status.stale_awaiting_checkpoint)}</dd>
      </dl>
      {Object.keys(attempts).length ? <><h2>モデル呼び出しの状態</h2><dl>
        <dt>復旧操作が必要</dt><dd>{count(attempts.blocked)}</dd><dt>再試行待ち</dt><dd>{count(attempts.waiting)}</dd>
        <dt>呼び出し中・応答未確定</dt><dd>{count(attempts.in_flight)}</dd><dt>provider一時停止</dt><dd>{count(attempts.cooldowns)}</dd>
        <dt>状態ファイルの異常</dt><dd>{count(attempts.invalid)}</dd><dt>次の再試行可能時刻</dt><dd>{attempts.next_retry_at === null ? '時刻指定なし' : date(attempts.next_retry_at)}</dd>
      </dl><p class="muted">原典は保持されています。doctorで確認してください。明示的な <code>recover --session DIGEST --retry-model</code> は利用枠・API料金を再び消費する場合があります。</p></> : null}
      <ul class="list">{['recall', 'capture', 'distill', 'upload', 'worker', 'heartbeat', 'session-end'].map(name => {
        const hook = record(hooks[name]);
        return <li><strong>{name}</strong> · 成功 {date(hook.last_success)}<div class="muted">累積失敗数 {count(hook.failures)} · 最終失敗 {date(hook.last_failure)}{hook.ok === false ? ' · 要確認' : ''}</div></li>;
      })}</ul>
      {typeof lastDistill.processed_events === 'number' ? <p class="muted">最終Distill: {count(lastDistill.processed_events)}原典・{count(lastDistill.candidates)}候補 · {str(lastDistill.provider)} · {str(lastDistill.mode)}。{Object.entries(record(lastDistill.decisions)).map(([action, n]) => `${action} ${count(n)}`).join(' / ')}</p> : null}
      {client.state !== 'healthy' ? <p>下のdoctorでOAuth・Hook・spoolを確認してください。停止したsessionは <code>sessions</code> で選び、<code>recover --session DIGEST</code> で原典から復旧できます。</p> : null}
    </article>;
  })}
  <h2>接続と復旧の確認</h2><pre>node cf-memory-agent/scripts/agent.mjs doctor{ '\n' }node cf-memory-agent/scripts/agent.mjs sessions{ '\n' }node cf-memory-agent/scripts/agent.mjs recover --session DIGEST</pre>
  <p class="muted">ローカルspoolの件数・最古の待ち原典や、サーバーへ通信できない障害はdoctorで確認します。サーバーのheartbeatだけではOAuth切れとHook停止を区別できません。</p>
  <h2>本番versionと基盤</h2><dl>{['git_sha', 'build_date', 'schema_version', 'required_schema_version', 'schema_ready', 'raw_event_retention_days'].map(key => <><dt>{key}</dt><dd>{String(server[key] ?? '未報告')}</dd></>)}</dl>
  {(() => {
    const logs = record(server.logs);
    const bytes = (value: unknown) => typeof value === 'number' ? `${Math.round(value / 1024).toLocaleString('ja-JP')} KB` : '未報告';
    const limit = (value: unknown) => value === null ? '上限なし' : bytes(value);
    return <article class="card"><h3>会話ログ（cf-memory-logs）</h3><strong>{logs.configured === true ? (logs.error ? '取得できません' : '接続済み') : '未設定（LOGS binding なし）'}</strong>
      <dl><dt>データベースの大きさ</dt><dd>{bytes(logs.size_bytes)}</dd><dt>あなたの件数</dt><dd>{typeof logs.entries === 'number' ? count(logs.entries) : '未報告'}</dd>
        <dt>今日の action</dt><dd>{bytes(logs.today_action_bytes)} / {limit(logs.daily_action_limit)}</dd>
        <dt>今日の合計</dt><dd>{bytes(logs.today_total_bytes)} / {limit(logs.daily_total_limit)}</dd>
        <dt>action・error の保持</dt><dd>{typeof logs.action_retention_days === 'number' ? `${logs.action_retention_days}日` : '未報告'}</dd></dl>
    </article>;
  })()}
  <details><summary>サーバー情報のJSON</summary><pre>{JSON.stringify(server, null, 2)}</pre></details>
  <script nonce={nonce} dangerouslySetInnerHTML={{ __html: REFRESH }} />
  </div></Layout>;

export const ProvenancePage: FC<{ handle?: string; title: string; memoryHref: string; sources: Provenance; callerId: string }> = p => <Layout title="Memoryの根拠" handle={p.handle} sessionHandle={p.handle}>
  <AgentStyle /><div class="agent-view"><p><a href={p.memoryHref}>← memoryを開く</a></p><h1>Memoryの根拠</h1><p class="sub">{p.title}</p>
  {!p.sources.length ? <p>このmemoryにはCapture由来の根拠が登録されていません。手動で保存されたmemoryもあります。</p> : null}
  {p.sources.map(source => {
    const meta = record(source.source);
    return <article class="card"><strong>{source.relation}</strong>{meta.imported === true ? <p class="muted">importされたmetadata（未検証）。Actor IDはimport実行者、元のactor・時刻・IDは申告情報です。原典の存在を証明しません。</p> : null}<dl><dt>Actor ID</dt><dd>{source.actor_id}</dd><dt>保存時刻</dt><dd>{date(source.created_at)}</dd><dt>原典の時刻</dt><dd>{date(meta.occurred_at)}</dd>
      <dt>保存理由</dt><dd>{source.rationale || '未報告'}</dd><dt>生成元</dt><dd>{source.generated_by || '未報告'}</dd><dt>信頼度</dt><dd>{Math.round(source.confidence * 100)}%</dd>
      <dt>Tool / event</dt><dd>{str(meta.tool_name)} · {str(meta.event_type)}</dd><dt>Remote</dt><dd>{strings(meta.repo_context).map(repo => <div>{repo}</div>)}</dd><dt>File</dt><dd>{strings(meta.file_refs).map(file => <div>{file}</div>)}</dd>
      <dt>Session</dt><dd class="mono">{source.source_session_id}</dd><dt>Event</dt><dd class="mono">{source.event_id}</dd></dl>
      {meta.imported === true ? <details><summary>元の記録の申告情報</summary><pre>{JSON.stringify(meta.imported_origin,null,2)}</pre></details> : source.actor_id === p.callerId ? <div class="actions"><a href={`/capture/events/${source.event_id}`}>本人の原典を開く</a><a href={`/capture/sessions/${source.source_session_id}`}>Sessionを開く</a><span class="muted">保持期限後は原典の内容を読めません。</span></div> : <p class="muted">他の人のCapture内容は閲覧できません。共有されるのはこのmemoryと根拠のmetadataです。</p>}
    </article>;
  })}</div></Layout>;
