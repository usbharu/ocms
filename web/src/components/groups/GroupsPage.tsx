import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type Group = { group_id: string; name: string; builtin: boolean };
export type GroupRequest = (
  path: string,
  init?: RequestInit,
) => Promise<unknown>;

export function GroupsPage({ request }: { request: GroupRequest }) {
  const api = useRef(request);
  api.current = request;
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the request.
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api
      .current('/api/v1/groups')
      .then((result) => {
        if (active) setGroups((result as { groups: Group[] }).groups ?? []);
      })
      .catch(() => {
        if (active)
          setError('グループを読み込めませんでした。再試行してください。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  async function change(key: string, action: () => Promise<unknown>) {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setBusy(new Set(pending.current));
    setError('');
    try {
      await action();
      setRevision((value) => value + 1);
    } catch (e) {
      setError(`保存できませんでした: ${(e as Error).message}`);
    } finally {
      pending.current.delete(key);
      setBusy(new Set(pending.current));
    }
  }

  return (
    <section className="groups-page">
      <h1>グループ</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = name;
          void change('create', async () => {
            await request('/api/v1/groups', {
              method: 'POST',
              body: JSON.stringify({ name }),
            });
            setName((current) => (current === submitted ? '' : current));
          });
        }}
      >
        <label htmlFor="new-group-name">グループ名</label>
        <Input
          id="new-group-name"
          value={name}
          maxLength={100}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <Button disabled={busy.has('create')} type="submit">
          作成
        </Button>
      </form>
      {error && (
        <p role="alert">
          {error}{' '}
          <Button
            onClick={() => {
              setError('');
              setRevision((value) => value + 1);
            }}
          >
            再試行
          </Button>
        </p>
      )}
      {loading && <p role="status">読み込み中…</p>}
      <ul className="group-list">
        {groups.map((group) => (
          <GroupRow
            key={`${group.group_id}:${group.name}`}
            group={group}
            busy={busy.has(group.group_id)}
            onChange={(name) =>
              change(group.group_id, () =>
                request(`/api/v1/groups/${group.group_id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ name }),
                }),
              )
            }
            onDelete={() => {
              if (
                confirm(
                  `「${group.name}」を削除しますか？ コンテンツは残ります。defaultへの所属は変わりません。`,
                )
              )
                void change(group.group_id, () =>
                  request(`/api/v1/groups/${group.group_id}`, {
                    method: 'DELETE',
                  }),
                );
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function GroupRow({
  group,
  busy,
  onChange,
  onDelete,
}: {
  group: Group;
  busy: boolean;
  onChange: (name: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  return (
    <li>
      <Link to={`/groups/${group.group_id}`}>{group.name}</Link>
      {!group.builtin &&
        (editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onChange(name);
            }}
          >
            <label
              className="visually-hidden"
              htmlFor={`group-${group.group_id}`}
            >
              グループ名
            </label>
            <Input
              id={`group-${group.group_id}`}
              value={name}
              maxLength={100}
              required
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={busy}>
              保存
            </Button>
            <Button type="button" onClick={() => setEditing(false)}>
              キャンセル
            </Button>
          </form>
        ) : (
          <span>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              改名
            </Button>
            <Button variant="outline" disabled={busy} onClick={onDelete}>
              削除
            </Button>
          </span>
        ))}
    </li>
  );
}
