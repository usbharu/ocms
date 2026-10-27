import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '../ui/button';

export function AppHeader({
  authenticated,
  onLogout,
  children,
  section = 'library',
  onSectionChange,
}: {
  children?: ReactNode;
  section?: 'library' | 'tags' | 'characters' | 'favorites' | 'recommendations';
  onSectionChange?: (
    section:
      | 'library'
      | 'tags'
      | 'characters'
      | 'favorites'
      | 'recommendations',
  ) => void;
  authenticated: boolean;
  onLogout: () => void;
}) {
  return (
    <header className="app-header">
      <Link className="brand" to="/library" aria-label="OCMS ホーム">
        <span aria-hidden="true">◈</span>
        <span className="brand-name">OCMS</span>
      </Link>
      {authenticated && (
        <nav className="workspace-nav" aria-label="ワークスペース">
          {(
            [
              ['library', 'ライブラリ'],
              ['tags', 'タグ'],
              ['characters', 'キャラクター'],
              ['favorites', 'お気に入り'],
              ['recommendations', 'おすすめ'],
            ] as const
          ).map(([id, label]) => (
            <Button key={id} variant="ghost" asChild>
              <Link
                to={`/${id}`}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => onSectionChange?.(id)}
              >
                {label}
              </Link>
            </Button>
          ))}
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
