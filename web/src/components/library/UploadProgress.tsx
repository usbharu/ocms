import { Progress } from '../ui/progress';

export function UploadProgress({ value }: { value: number }) {
  return (
    <div className="upload-progress" role="status">
      <span>アップロード中</span>
      <Progress max={100} value={value} aria-label="アップロード進捗" />
      <span>{value}%</span>
    </div>
  );
}
