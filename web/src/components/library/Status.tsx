import { statuses } from '../../lib/assets';

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span aria-hidden="true" />
      {statuses[value] ?? value}
    </span>
  );
}
