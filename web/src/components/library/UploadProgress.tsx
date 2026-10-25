import type { UploadTask } from '../../lib/uploads';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';

export function UploadProgress({
  value,
  tasks,
  busy,
  onRetry,
}: {
  value: number;
  tasks?: UploadTask[];
  busy?: boolean;
  onRetry?: (task: UploadTask) => void;
}) {
  if (tasks)
    return (
      <section className="upload-queue" aria-label="アップロード状況">
        <div role="status">
          {tasks.filter((task) => task.state === 'completed').length} /{' '}
          {tasks.length} 件完了
        </div>
        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <span className="upload-filename">{task.file.name}</span>
              {task.state === 'uploading' && (
                <Progress
                  max={100}
                  value={task.progress}
                  aria-label={`${task.file.name}のアップロード進捗`}
                />
              )}
              <span>
                {task.state === 'completed'
                  ? '完了'
                  : task.state === 'failed'
                    ? '失敗'
                    : task.state === 'waiting'
                      ? '待機中'
                      : task.progress >= 99
                        ? '保存中'
                        : `${task.progress}%`}
              </span>
              {task.state === 'failed' && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onRetry?.(task)}
                  aria-label={`${task.file.name}を再試行`}
                >
                  再試行
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="upload-progress" role="status">
      <span>アップロード中</span>
      <Progress max={100} value={value} aria-label="アップロード進捗" />
      <span>{value}%</span>
    </div>
  );
}
