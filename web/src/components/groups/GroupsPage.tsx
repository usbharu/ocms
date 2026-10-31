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
  const [busy, setBusy] = useState(false);
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

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setRevision((value) => value + 1);
    } catch (e) {
      setError(`保存できませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="groups-page">
      <h1>グループ</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void change(async () => {
            await request('/api/v1/groups', {
              method: 'POST',
              body: JSON.stringify({ name }),
            });
            setName('');
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
        <Button disabled={busy} type="submit">
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
            busy={busy}
            onChange={(name) =>
              change(() =>
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
                void change(() =>
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
            <Button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
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
