import { Button } from '../ui/button';

export function LoginPanel({
  development,
  onDevLogin,
}: {
  development: boolean;
  onDevLogin: (user: string) => void;
}) {
  return (
    <section className="login">
      <span className="login-mark" aria-hidden="true">
        ◈
      </span>
      <h1>ライブラリにログイン</h1>
      {development ? (
        <>
          <p className="muted">開発用アカウント</p>
          <div className="login-actions">
            {['alice', 'bob'].map((user) => (
              <Button
                variant="outline"
                type="button"
                key={user}
                onClick={() => onDevLogin(user)}
              >
                {user} でログイン
              </Button>
            ))}
          </div>
        </>
      ) : (
        <Button asChild>
          <a
            href={`/auth/login?${new URLSearchParams({ return_to: window.location.pathname + window.location.search })}`}
          >
            SSOでログイン
          </a>
        </Button>
      )}
    </section>
  );
}
