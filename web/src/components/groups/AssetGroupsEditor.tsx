import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import type { Group, GroupRequest } from './GroupsPage';

export function AssetGroupsEditor({
  assetId,
  series,
  request,
  onSaved,
}: {
  assetId: string;
  series: boolean;
  request: GroupRequest;
  onSaved: () => void;
}) {
  const api = useRef(request);
  api.current = request;
  const [groups, setGroups] = useState<Group[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the request.
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      api.current('/api/v1/groups'),
      api.current(`/api/v1/assets/${assetId}/groups`),
    ])
      .then(([list, membership]) => {
        if (!active) return;
        setGroups((list as { groups: Group[] }).groups ?? []);
        setIds((membership as { group_ids: string[] }).group_ids ?? []);
        setError('');
      })
      .catch(() => {
        if (active)
          setError('所属を読み込めませんでした。再試行してください。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [assetId, revision]);

  return (
    <form
      className="asset-groups"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        setNotice('');
        void request(`/api/v1/assets/${assetId}/groups`, {
          method: 'PUT',
          body: JSON.stringify({ group_ids: ids }),
        })
          .then(() => {
            setNotice('所属を保存しました');
            onSaved();
          })
          .catch(() =>
            setError('所属を保存できませんでした。再試行してください。'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <fieldset disabled={loading || busy}>
        <legend>グループ</legend>
        {groups
          .filter((group) => !series || group.group_id !== 'all')
          .map((group) => (
            <label key={group.group_id}>
              <input
                type="checkbox"
                checked={ids.includes(group.group_id)}
                disabled={group.group_id === 'all'}
                onChange={(event) => {
                  setNotice('');
                  setIds((previous) =>
                    event.target.checked
                      ? [...previous, group.group_id]
                      : previous.filter((id) => id !== group.group_id),
                  );
                }}
              />
              {group.name}
            </label>
          ))}
        <Button type="submit" disabled={groups.length === 0}>
          所属を保存
        </Button>
      </fieldset>
      {loading && <p role="status">読み込み中…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <Button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            再読み込み
          </Button>
        </p>
      )}
    </form>
  );
}
