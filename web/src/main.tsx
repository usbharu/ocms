import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Asset = {
  asset_id: string; filename: string; mime_type: string; tags: string[]; status: string;
  snippet?: string; page_number?: number; start_ms?: number; end_ms?: number;
};
type Rendition = { rendition_id: string; profile_id: string; mime_type: string };
type Job = { job_id: string; job_type: string; status: string; attempts: number; error_code?: string };
type Me = { principal_id: string; csrf_token: string };
type Mode = 'keyword' | 'semantic' | 'hybrid' | 'perceptual' | 'exact_duplicate';
const statuses: Record<string, string> = {
  pending: 'アップロード待ち', stored: '保存済み・解析待ち', processing: '解析中', ready: '処理完了', failed: '処理失敗',
  queued: '待機中', retry: '再試行待ち', running: '実行中', completed: '完了',
};

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [dev, setDev] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [renditions, setRenditions] = useState<Rendition[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('keyword');
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  async function request(path: string, init: RequestInit = {}) {
    const res = await fetch(path, { ...init, headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf_token ?? '', ...init.headers,
    } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  async function refresh() {
    setError(''); setSearching(true);
    try {
      let res;
      if (mode === 'perceptual' || mode === 'exact_duplicate') {
        if (!selected) throw new Error('比較するファイルを一覧から選んでください。');
        res = await request(`/api/v1/assets/${selected.asset_id}/${mode === 'perceptual' ? 'similar' : 'duplicates'}`);
      } else if (query) {
        res = await request('/api/v1/search', { method: 'POST', body: JSON.stringify({ query, mode, limit: 200 }) });
      } else {
        res = await request('/api/v1/assets');
      }
      setAssets(res.assets);
    } finally { setSearching(false); }
  }
  useEffect(() => {
    fetch('/auth/config').then(r => r.json()).then(c => setDev(c.development));
    fetch('/api/v1/me').then(r => r.ok ? r.json() : null).then(setMe).catch(() => setError('接続できません'));
  }, []);
  useEffect(() => { if (me) refresh().catch(e => setError(e.message)); }, [me]);
  useEffect(() => {
    setRenditions([]); setJobs([]);
    if (!selected || !me) return;
    let active = true;
    const update = async () => {
      const [ds, js, asset] = await Promise.all([
        request(`/api/v1/assets/${selected.asset_id}/renditions`),
        request(`/api/v1/assets/${selected.asset_id}/jobs`),
        request(`/api/v1/assets/${selected.asset_id}`),
      ]);
      if (active) {
        setRenditions(ds.renditions); setJobs(js.jobs);
        setSelected(current => current ? { ...current, status: asset.status } : null);
        setAssets(current => current.map(a => a.asset_id === asset.asset_id ? { ...a, status: asset.status } : a));
      }
    };
    update().catch(e => { if (active && !['pending', 'uploading'].includes(selected.status)) setError(e.message); });
    const timer = window.setInterval(() => update().catch(() => {}), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [selected?.asset_id, me]);

  async function upload(file: File) {
    setError(''); setProgress(0);
    try {
      const u = await request('/api/v1/uploads', { method: 'POST', body: JSON.stringify({
        filename: file.name, mime_type: file.type || 'application/octet-stream', size_bytes: file.size,
      }) });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/v1/uploads/${u.upload_id}/content`);
        xhr.setRequestHeader('X-CSRF-Token', me!.csrf_token);
        xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error('アップロード失敗。ファイルを選び直して再送してください。'));
        xhr.onerror = () => reject(new Error('通信に失敗しました'));
        xhr.send(file);
      });
      const a = await request(`/api/v1/assets/${u.asset_id}`);
      setSelected(a); setQuery(''); setMode('keyword');
      setAssets((await request('/api/v1/assets')).assets);
    } catch (e) { setError((e as Error).message); }
    finally { setProgress(null); }
  }
  const run = (action: () => Promise<void>) => action().catch(e => setError(e.message));
  const mediaURL = (a: Asset) => {
    const d = renditions.find(d => d.profile_id === (a.mime_type.startsWith('video/') ? 'video.mp4-v1' : 'audio.opus-v1'));
    const url = `/api/v1/assets/${a.asset_id}/${d ? `renditions/${d.rendition_id}/content` : 'content'}`;
    return url + (a.start_ms !== undefined ? `#t=${a.start_ms / 1000}` : '');
  };
  return <div className="shell">
    <aside>
      <div className="brand">◈ <b>OCMS</b></div><p className="muted">MEDIA STORAGE</p><nav>▦ ライブラリ</nav>
      <div className="aside-foot">暗号化メディアストレージ<br />AES-256-CTR · S3</div>
    </aside>
    <main>
      <header><span>ワークスペース / ライブラリ</span>{me && <button onClick={() => run(async () => {
        await request('/auth/logout', { method: 'POST' }); setMe(null); setAssets([]); setSelected(null);
      })}>ログアウト</button>}</header>
      {!me ? <section className="login">
        <p className="eyebrow">YOUR PRIVATE LIBRARY</p><h1>メディアを、ひとつの場所に。</h1>
        <p>画像・動画・音声・PDFを暗号化して保管します。</p>
        {dev ? <><p className="notice">ローカル開発用ログイン · OIDC未使用</p>
          {['alice', 'bob'].map(user => <button key={user} onClick={() => run(async () => {
            const response = await fetch('/auth/dev-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user }) });
            if (!response.ok) throw new Error('ログインに失敗しました'); location.reload();
          })}>{user} でログイン</button>)}
        </> : <a className="button" href="/auth/login">SSOでログイン</a>}
      </section> : <>
        <section className="heading">
          <div><p className="eyebrow">YOUR PRIVATE LIBRARY</p><h1>ライブラリ</h1><p className="muted">ファイルを保存して、内容から見つける。</p></div>
          <label className="button">＋ アップロード<input type="file" accept="image/*,video/*,audio/*,application/pdf" disabled={progress !== null}
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></label>
        </section>
        <form className="search" onSubmit={e => { e.preventDefault(); run(refresh); }}>
          <select aria-label="検索モード" value={mode} onChange={e => setMode(e.target.value as Mode)}>
            <option value="keyword">キーワード</option><option value="semantic">意味検索</option><option value="hybrid">ハイブリッド</option>
            <option value="perceptual">選択ファイルとの類似</option><option value="exact_duplicate">選択ファイルとの完全一致</option>
          </select>
          <input aria-label="検索クエリ" placeholder="ファイル名・タグ・内容を検索…" value={query} onChange={e => setQuery(e.target.value)}
            disabled={mode === 'perceptual' || mode === 'exact_duplicate'} />
          <button disabled={searching}>{searching ? '検索中…' : '検索'}</button>
        </form>
        {progress !== null && <p role="status">アップロード中 {progress}% <progress max="100" value={progress} /></p>}
        <p className="muted">{assets.length} 件表示 · 抽出・索引処理は非同期で実行します</p>
        <div className="library">
          <section className="files">{assets.length === 0 ? <div className="empty">該当するファイルがありません。</div> : assets.map(a =>
            <button className={`file ${selected?.asset_id === a.asset_id ? 'active' : ''}`} key={a.asset_id} onClick={() => { setError(''); setSelected(a); }}>
              <span className="file-icon">{a.mime_type.startsWith('image/') ? '▧' : a.mime_type.startsWith('video/') ? '▷' : a.mime_type.startsWith('audio/') ? '♫' : '▤'}</span>
              <span><b>{a.filename}</b><small>{a.mime_type} · {statuses[a.status] ?? a.status}</small>
                {a.snippet && <span className="snippet">{a.snippet}</span>}
                {(a.page_number !== undefined || a.start_ms !== undefined) && <small>{a.page_number ? `${a.page_number} ページ` : `${(a.start_ms! / 1000).toFixed(1)} 秒から`}</small>}
              </span><span className="tag">{a.tags.join(', ')}</span>
            </button>)}</section>
          {selected && <section className="details">
            <h2>{selected.filename}</h2><p className="muted">{statuses[selected.status] ?? selected.status}</p>
            {selected.mime_type.startsWith('image/') ? <img alt={selected.filename} src={`/api/v1/assets/${selected.asset_id}/${renditions.some(d => d.profile_id === 'thumbnail-v1') ? 'preview' : 'content'}`} />
              : selected.mime_type.startsWith('video/') ? <video key={mediaURL(selected)} controls preload="metadata" src={mediaURL(selected)} />
              : selected.mime_type.startsWith('audio/') ? <audio key={mediaURL(selected)} controls preload="metadata" src={mediaURL(selected)} />
              : renditions.some(d => d.profile_id === 'pdf.page-1-v1') ? <img alt="PDF 1ページ目" src={`/api/v1/assets/${selected.asset_id}/preview`} /> : <p>ページプレビューを生成中です。</p>}
            <a href={`/api/v1/assets/${selected.asset_id}/content${selected.page_number ? `#page=${selected.page_number}` : ''}`} target="_blank" rel="noreferrer">元ファイルを開く ↗</a>
            <h3>派生ファイル</h3>
            {renditions.map(d => <p key={d.rendition_id}><a href={`/api/v1/assets/${selected.asset_id}/renditions/${d.rendition_id}/content`} target="_blank" rel="noreferrer">{d.profile_id} ↗</a></p>)}
            <button onClick={() => run(async () => { await request(`/api/v1/assets/${selected.asset_id}/renditions`, { method: 'POST', body: '{}' }); })}>変換を要求・失敗処理を再試行</button>
            <h3>処理状態</h3>
            {jobs.map(j => <p className="job" key={j.job_id}>{j.job_type === 'media.process' ? '変換・抽出' : '意味索引'}：{statuses[j.status] ?? j.status}<small>試行 {j.attempts}{j.error_code ? ` · ${j.error_code}` : ''}</small></p>)}
            <form key={selected.asset_id} onSubmit={e => {
              e.preventDefault(); const data = new FormData(e.currentTarget);
              run(async () => { const updated = await request(`/api/v1/assets/${selected.asset_id}`, { method: 'PATCH', body: JSON.stringify({ tags: String(data.get('tags')).split(',').map(t => t.trim()).filter(Boolean) }) }); setSelected(updated); await refresh(); });
            }}><label>タグ（カンマ区切り）<input name="tags" defaultValue={selected.tags.join(', ')} /></label><button>タグを保存</button></form>
            <button className="danger" onClick={() => { if (confirm('このファイルを削除しますか？')) run(async () => {
              await request(`/api/v1/assets/${selected.asset_id}`, { method: 'DELETE' }); setSelected(null); await refresh();
            }); }}>削除</button>
          </section>}
        </div>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer>Encrypted media library · EmbeddingGemma 2 · OCR / ASR</footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
