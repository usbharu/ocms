import { Button } from '../ui/button';

export function AppHeader({
  authenticated,
  onLogout,
}: {
  authenticated: boolean;
  onLogout: () => void;
}) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="OCMS ホーム">
        <span aria-hidden="true">◈</span> OCMS
      </a>
      <span className="workspace-name">メディアライブラリ</span>
      {authenticated && (
        <Button
          variant="ghost"
          type="button"
          className="quiet"
          onClick={onLogout}
        >
          ログアウト
        </Button>
      )}
    </header>
  );
}
