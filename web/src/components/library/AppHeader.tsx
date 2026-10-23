import type { ReactNode } from 'react';
import { Button } from '../ui/button';

export function AppHeader({
  authenticated,
  onLogout,
  children,
  section = 'library',
  onSectionChange,
}: {
  children?: ReactNode;
  section?: 'library' | 'tags';
  onSectionChange?: (section: 'library' | 'tags') => void;
  authenticated: boolean;
  onLogout: () => void;
}) {
  return (
    <header className="app-header">
      <a className="brand" href="/" aria-label="OCMS ホーム">
        <span aria-hidden="true">◈</span>
        <span className="brand-name">OCMS</span>
      </a>
      {authenticated && (
        <nav className="workspace-nav" aria-label="ワークスペース">
          <Button
            variant="ghost"
            aria-current={section === 'library' ? 'page' : undefined}
            onClick={() => onSectionChange?.('library')}
          >
            ライブラリ
          </Button>
          <Button
            variant="ghost"
            aria-current={section === 'tags' ? 'page' : undefined}
            onClick={() => onSectionChange?.('tags')}
          >
            タグ
          </Button>
        </nav>
      )}
      {authenticated && (
        <div className="header-actions">
          {children}
          <Button
            variant="ghost"
            type="button"
            className="quiet"
            onClick={onLogout}
          >
            ログアウト
          </Button>
        </div>
      )}
    </header>
  );
}
