import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { Asset, AssetChanges } from '../../lib/assets';
import { AssetMetadataEditor } from '../library/AssetMetadataEditor';
import { AssetViewer } from '../library/AssetViewer';
import { FavoriteButton } from '../library/FavoriteButton';
import { Thumbnail } from '../library/Thumbnail';
import { Button } from '../ui/button';

type Series = Asset & { members: Asset[]; editable: boolean };
type Suggestion = Asset & { reasons?: string[] };
type Request = (path: string, init?: RequestInit) => Promise<unknown>;

export function SeriesPage({ request }: { request: Request }) {
  const location = useLocation();
  const navigate = useNavigate();
  const parts = location.pathname.split('/');
  const creating = parts[2] === 'new';
  const editing = creating || parts[3] === 'edit';
  const viewing = parts[3] === 'view';
  const id = creating ? '' : parts[2];
  const params = new URLSearchParams(location.search);
  const source = params.get('source') || '';
  const initialMember = params.get('member') || '';
  const initialLocation: Pick<Asset, 'page_number' | 'start_ms' | 'end_ms'> =
    {};
  for (const key of ['page_number', 'start_ms', 'end_ms'] as const) {
    const raw = params.get(key);
    const value = Number(raw);
    if (
      raw !== null &&
      /^\d+$/.test(raw) &&
      Number.isSafeInteger(value) &&
      (key !== 'page_number' || value > 0)
    )
      initialLocation[key] = value;
  }
  const [series, setSeries] = useState<Series | null>(null);
  const [items, setItems] = useState<Asset[]>([]);
  const [members, setMembers] = useState<Asset[]>([]);
  const [leaves, setLeaves] = useState<Asset[]>([]);
  const [kind, setKind] = useState<'collection' | 'composite'>('collection');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const [retry, setRetry] = useState(0);
  const [metadata, setMetadata] = useState<Asset | null>(null);
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Fetches are scoped to this route; stale responses cannot replace a new draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: request uses the current authenticated session.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const load = async () => {
      if (id) {
        const value = (await request(
          `/api/v1/series/${encodeURIComponent(id)}`,
        )) as Series;
        const flattened: Asset[] = [];
        for (const member of value.members) {
          if (member.series_kind) {
            const nested = (await request(
              `/api/v1/series/${member.asset_id}`,
            )) as Series;
            flattened.push(...nested.members);
          } else flattened.push(member);
        }
        if (!active) return;
        setSeries(value);
        setName(value.filename);
        setKind(value.series_kind || 'collection');
        setMembers(value.members);
        setLeaves(flattened);
        setIndex(
          Math.max(
            0,
            flattened.findIndex((a) => a.asset_id === initialMember),
          ),
        );
      } else if (creating) {
        if (source) {
          const value = (await request(
            `/api/v1/assets/${encodeURIComponent(source)}`,
          )) as Asset;
          if (!active) return;
          setMembers([value]);
        }
      } else {
        const value = (await request(
          `/api/v1/series?limit=200&offset=${(page - 1) * 200}`,
        )) as { assets: Asset[]; total: number };
        if (active) {
          setItems(value.assets);
          setTotal(value.total);
        }
      }
    };
    void load()
      .catch(() => {
        if (active) setError('シリーズを読み込めません。再試行してください。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, creating, source, initialMember, page, retry]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: request uses the current authenticated session.
  useEffect(() => {
    if (!editing || loading) return;
    let active = true;
    setCandidateLoading(true);
    setCandidateError('');
    const timer = window.setTimeout(() => {
      void request('/api/v1/series/suggestions', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          member_ids: members.map((a) => a.asset_id),
          source_id: source,
          editing_id: id || '',
          query,
        }),
      })
        .then((value) => {
          if (active) setCandidates((value as { assets: Suggestion[] }).assets);
        })
        .catch(() => {
          if (active) {
            setCandidates([]);
            setCandidateError('候補を取得できません。再試行してください。');
          }
        })
        .finally(() => {
          if (active) setCandidateLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [editing, loading, members, kind, query, source, id, retry]);

  function reorder(position: number, delta: number) {
    setMembers((current) => {
      const next = [...current];
      [next[position], next[position + delta]] = [
        next[position + delta],
        next[position],
      ];
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const value = (await request(
        id ? `/api/v1/series/${id}` : '/api/v1/series',
        {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name,
            kind,
            member_ids: members.map((a) => a.asset_id),
            version: series?.series_version,
          }),
        },
      )) as Series;
      navigate(`/assets/${value.asset_id}`);
    } catch (e) {
      setError(
        (e as { status?: number }).status === 409
          ? '構成または権限が変更されました。再読み込みして確認してください。'
          : '保存できません。作品の所有者・公開範囲・所属を確認してください。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite() {
    if (!series || busy) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/assets/${series.asset_id}/favorite`, {
        method: series.is_favorite ? 'DELETE' : 'PUT',
      });
      setSeries({ ...series, is_favorite: !series.is_favorite });
    } catch {
      setError('お気に入りを保存できません。再試行してください。');
    } finally {
      setBusy(false);
    }
  }

  async function dissolve() {
    if (
      !series ||
      !confirm('シリーズを解除しますか？ 元のファイルは残ります。')
    )
      return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/series/${series.asset_id}`, { method: 'DELETE' });
      navigate('/series');
    } catch {
      setError('解除できません。再試行してください。');
    } finally {
      setBusy(false);
    }
  }

  async function saveMetadata(changes: AssetChanges) {
    if (!metadata) throw new Error('画像を選択してください');
    const value = (await request(`/api/v1/assets/${metadata.asset_id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    })) as Asset;
    setMetadata(value);
    setMembers((current) =>
      current.map((a) => (a.asset_id === value.asset_id ? value : a)),
    );
    return value;
  }

  async function deleteMember(asset: Asset) {
    if (!confirm('この画像を削除しますか？')) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/assets/${asset.asset_id}`, { method: 'DELETE' });
      if (kind === 'composite' && members.length <= 2) navigate('/library');
      else setRetry((v) => v + 1);
    } catch {
      setError('削除できません。再試行してください。');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p role="status">読み込み中…</p>;
  if (error && !editing)
    return (
      <section role="alert">
        <p>{error}</p>
        <Button onClick={() => setRetry((v) => v + 1)}>再試行</Button>
        <Link to="/series">シリーズ一覧</Link>
      </section>
    );
  if (editing)
    return (
      <section className="series-page">
        <h1>{creating ? 'シリーズを作成' : 'シリーズを編集'}</h1>
        {error && (
          <p role="alert">
            {error}{' '}
            <Button onClick={() => setRetry((v) => v + 1)}>再読み込み</Button>
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="series-fields">
            <label>
              種類
              <select
                aria-label="種類"
                value={kind}
                disabled={!creating}
                onChange={(event) => {
                  setKind(event.target.value as typeof kind);
                  setCandidates([]);
                }}
              >
                <option value="collection">通常シリーズ</option>
                <option
                  value="composite"
                  disabled={members.some(
                    (a) =>
                      !a.mime_type.startsWith('image/') ||
                      a.series_kind ||
                      a.composite_id,
                  )}
                >
                  一体型シリーズ
                </option>
              </select>
            </label>
            {kind === 'composite' && (
              <p>
                画像を1作品として表示します。タグ・キャラクター・レーティングは構成画像から集約されます。
              </p>
            )}
            <label>
              シリーズ名
              <input
                required
                maxLength={1024}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="series-actions series-submit-actions">
              <Button
                type="submit"
                disabled={
                  members.length < 2 || !name.trim() || candidateLoading
                }
              >
                {busy ? '保存中…' : '保存'}
              </Button>
              <Link
                to={
                  id
                    ? `/series/${id}`
                    : source
                      ? `/assets/${source}`
                      : '/series'
                }
              >
                キャンセル
              </Link>
            </div>
            <div className="series-editor">
              <section>
                <h2>選択済み（{members.length}）</h2>
                <ol className="series-members">
                  {members.map((asset, position) => (
                    <li key={asset.asset_id}>
                      <Thumbnail asset={asset} />
                      <span>{asset.filename}</span>
                      <div className="series-actions">
                        <Button
                          variant="outline"
                          type="button"
                          disabled={position === 0}
                          aria-label={`${asset.filename}を上へ`}
                          onClick={() => reorder(position, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="outline"
                          type="button"
                          disabled={position === members.length - 1}
                          aria-label={`${asset.filename}を下へ`}
                          onClick={() => reorder(position, 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          type="button"
                          onClick={() =>
                            setMembers((current) =>
                              current.filter(
                                (a) => a.asset_id !== asset.asset_id,
                              ),
                            )
                          }
                        >
                          外す
                        </Button>
                        {!creating && kind === 'composite' && (
                          <>
                            <Button
                              type="button"
                              onClick={() => setMetadata(asset)}
                            >
                              画像を編集
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={() => void deleteMember(asset)}
                            >
                              画像を削除
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              <section>
                <h2>作品を追加</h2>
                <label>
                  タイトルを検索
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                {candidateLoading ? (
                  <p role="status">候補を読み込み中…</p>
                ) : candidateError ? (
                  <p role="alert">
                    {candidateError}
                    <Button
                      type="button"
                      onClick={() => setRetry((v) => v + 1)}
                    >
                      再試行
                    </Button>
                  </p>
                ) : candidates.length === 0 ? (
                  <p>追加できる作品がありません</p>
                ) : (
                  <ul className="series-members">
                    {candidates.map((asset) => (
                      <li key={asset.asset_id}>
                        <Thumbnail asset={asset} />
                        <span>
                          {asset.filename}
                          {asset.reasons?.length ? (
                            <small>{asset.reasons.join('・')}</small>
                          ) : null}
                        </span>
                        <Button
                          type="button"
                          onClick={() => {
                            setMembers((current) => [...current, asset]);
                            setCandidates((current) =>
                              current.filter(
                                (a) => a.asset_id !== asset.asset_id,
                              ),
                            );
                          }}
                        >
                          追加
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </fieldset>
        </form>
        {metadata && (
          <section>
            <h2>{metadata.filename}</h2>
            <AssetMetadataEditor
              key={metadata.asset_id}
              asset={metadata}
              onSave={saveMetadata}
              onSearchTag={(tag) =>
                navigate(`/library?tag=${encodeURIComponent(tag)}`)
              }
              onSearchCharacter={(character) =>
                navigate(`/library?character=${encodeURIComponent(character)}`)
              }
            />
            <Button onClick={() => setMetadata(null)}>編集を閉じる</Button>
          </section>
        )}
      </section>
    );
  if (series)
    return (
      <section className="series-page">
        <div className="series-actions">
          <h1>{series.filename}</h1>
          <FavoriteButton
            asset={series}
            busy={busy}
            onToggle={() => {
              void toggleFavorite();
            }}
          />
          <Link to="/series">シリーズ一覧</Link>
          {leaves.length > 0 && (
            <Button asChild>
              <Link
                to={`/assets/${series.asset_id}/view${initialMember ? location.search : ''}`}
              >
                順番に見る
              </Link>
            </Button>
          )}
          {series.editable && (
            <>
              <Link to={`/series/${series.asset_id}/edit`}>編集</Link>
              <Button disabled={busy} onClick={() => void dissolve()}>
                シリーズを解除
              </Button>
            </>
          )}
        </div>
        <p>
          {series.tags.join('・')} {series.characters?.join('・')}{' '}
          {series.rating}
        </p>
        <ol className="series-members">
          {series.members.map((asset) => (
            <li key={asset.asset_id}>
              <Thumbnail asset={asset} />
              <Link to={`/assets/${asset.asset_id}`}>{asset.filename}</Link>
            </li>
          ))}
        </ol>
        {viewing && leaves[index] && (
          <AssetViewer
            asset={{
              ...leaves[index],
              ...(leaves[index].asset_id === initialMember
                ? initialLocation
                : {}),
              is_favorite: series.is_favorite,
            }}
            continuous
            onFavorite={() => {
              void toggleFavorite();
            }}
            favoriteBusy={busy}
            hasPrevious={index > 0}
            hasNext={index < leaves.length - 1}
            onNavigate={(direction) => {
              const next = index + direction;
              setIndex(next);
              navigate(
                `/series/${series.asset_id}/view?member=${leaves[next].asset_id}`,
                { replace: true },
              );
            }}
            onClose={() => navigate(`/series/${series.asset_id}`)}
            navigationError=""
          />
        )}
      </section>
    );
  return (
    <section className="series-page">
      <div className="series-actions">
        <h1>シリーズ</h1>
        <Button asChild>
          <Link to="/series/new">シリーズを作成</Link>
        </Button>
      </div>
      {items.length === 0 ? (
        <p>シリーズがありません</p>
      ) : (
        <ul className="series-members">
          {items.map((asset) => (
            <li key={asset.asset_id}>
              <Thumbnail asset={asset} />
              <Link
                to={`/assets/${asset.asset_id}`}
                state={{ closeTo: location.pathname + location.search }}
              >
                {asset.filename}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="series-actions">
        {page > 1 && <Link to={`/series?page=${page - 1}`}>前へ</Link>}
        {page * 200 < total && (
          <Link to={`/series?page=${page + 1}`}>次へ</Link>
        )}
      </div>
    </section>
  );
}
