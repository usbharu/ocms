import { Button } from '../ui/button';

export function PageNavigation({
  page,
  total,
  label,
  onChange,
}: {
  page: number;
  total: number;
  label: string;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="pdf-navigation" aria-label={`${label}ページ操作`}>
      <Button
        variant="ghost"
        aria-label={`前の${label}ページ`}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        ‹
      </Button>
      <span aria-live="polite">
        {page} / {total} ページ
      </span>
      <Button
        variant="ghost"
        aria-label={`次の${label}ページ`}
        disabled={page >= total}
        onClick={() => onChange(page + 1)}
      >
        ›
      </Button>
    </nav>
  );
}
