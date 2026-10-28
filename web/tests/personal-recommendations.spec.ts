import { expect, test } from '@playwright/test';

const items = Array.from({ length: 30 }, (_, i) => ({
  asset_id: `asset-${i}`,
  filename: `おすすめ${i}.png`,
  mime_type: 'image/png',
  tags: ['風景'],
  characters: ['キャラクターA'],
  rating: 'general',
  status: 'ready',
  is_favorite: false,
  score: 80,
  common_tags: ['風景'],
  common_characters: ['キャラクターA'],
}));
const preview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#dce9e5"/><path d="M0 400 210 80 440 400Z" fill="#527d67"/></svg>';

for (const width of [1440, 375, 320]) {
  test(`personal recommendations preserve pages and exploration at ${width}px`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    let generation = 0;
    const state = {
      failed: false,
      insufficient: false,
      empty: false,
      stale: false,
    };
    const sessions = new Map<string, typeof items>();
    const calls: URL[] = [];
    await page.route('**/auth/config', (r) =>
      r.fulfill({ json: { development: true } }),
    );
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith('/me'))
        return route.fulfill({
          json: { principal_id: 'demo', csrf_token: 'test' },
        });
      if (path === '/api/v1/recommendations') {
        calls.push(url);
        if (state.failed)
          return route.fulfill({
            status: 503,
            json: { error: 'SERVICE_UNAVAILABLE' },
          });
        if (state.stale)
          return route.fulfill({
            status: 409,
            json: { error: 'RECOMMENDATION_SESSION_STALE' },
          });
        let id = url.searchParams.get('session_id');
        if (!id) {
          id = `session-${++generation}`;
          const shift = generation % items.length;
          sessions.set(id, [...items.slice(shift), ...items.slice(0, shift)]);
        }
        const ordered =
          state.insufficient || state.empty ? [] : (sessions.get(id) ?? items);
        const offset = (Number(url.searchParams.get('page') ?? 1) - 1) * 200;
        return route.fulfill({
          json: {
            status: state.insufficient ? 'insufficient_information' : 'ready',
            session_id: id,
            total: ordered.length,
            assets: ordered.slice(offset, offset + 200),
          },
        });
      }
      if (path.endsWith('/recommendations'))
        return route.fulfill({
          json: {
            source_asset_id: 'asset-1',
            hash_status: 'pending',
            assets: [items[0]],
          },
        });
      if (path.endsWith('/favorite')) return route.fulfill({ status: 204 });
      if (path.endsWith('/preview') || path.endsWith('/content'))
        return route.fulfill({ contentType: 'image/svg+xml', body: preview });
      if (path.endsWith('/jobs')) return route.fulfill({ json: { jobs: [] } });
      if (path.endsWith('/renditions'))
        return route.fulfill({ json: { renditions: [] } });
      if (path === '/api/v1/assets')
        return route.fulfill({ json: { assets: [items[0]], total: 1 } });
      return route.fulfill({
        json: items.find((a) => path.endsWith(a.asset_id)) ?? items[0],
      });
    });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'ワークスペース' });
    state.failed = true;
    await nav.getByRole('link', { name: 'おすすめ', exact: true }).click();
    await expect(
      page.getByText('おすすめを取得できません。', { exact: true }),
    ).toBeVisible();
    state.failed = false;
    await page.getByRole('button', { name: '再試行', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'おすすめ1.png', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'おすすめ25.png', exact: true }),
    ).toBeVisible();
    expect(generation).toBe(1);
    await page
      .getByRole('button', { name: 'おすすめ25.png', exact: true })
      .click();
    await page
      .getByRole('button', { name: '関連コンテンツ', exact: true })
      .click();
    await page.getByRole('button', { name: '戻る', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'おすすめ25.png', exact: true }),
    ).toBeVisible();
    expect(generation).toBe(1);
    await page.getByRole('button', { name: '更新', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'おすすめ2.png', exact: true }),
    ).toBeVisible();
    expect(generation).toBe(2);
    await page.getByLabel('おすすめの種類').selectOption('image');
    await expect.poll(() => generation).toBe(3);
    expect(calls.at(-1)?.searchParams.get('kind')).toBe('image');
    await page
      .getByRole('checkbox', { name: 'explicit', exact: true })
      .uncheck();
    await expect.poll(() => generation).toBe(4);
    expect(calls.at(-1)?.searchParams.get('ratings')).not.toContain('explicit');
    await page
      .getByRole('button', { name: 'おすすめ4.png：お気に入りに登録' })
      .click();
    await expect.poll(() => generation).toBe(5);
    if (process.env.UI_SCREENSHOTS === '1')
      await page.screenshot({
        path: `../docs/personal-recommendations-${width}.png`,
        fullPage: true,
      });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await nav.getByRole('link', { name: 'ライブラリ', exact: true }).click();
    await nav.getByRole('link', { name: 'おすすめ', exact: true }).click();
    await expect.poll(() => generation).toBe(6);
    state.failed = true;
    await page.getByRole('button', { name: '更新', exact: true }).click();
    await expect(
      page.getByText('おすすめを取得できません。', { exact: true }),
    ).toBeVisible();
    state.failed = false;
    state.insufficient = true;
    await page.getByRole('button', { name: '再試行', exact: true }).click();
    await expect(
      page.getByText('情報が足りません', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'お気に入りを開く', exact: true })
      .click();
    await expect(
      nav.getByRole('link', { name: 'お気に入り', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    state.insufficient = false;
    state.empty = true;
    await nav.getByRole('link', { name: 'おすすめ', exact: true }).click();
    await expect(
      page.getByText('おすすめがありません', { exact: true }),
    ).toBeVisible();
    state.empty = false;
    state.stale = true;
    await page.getByRole('button', { name: '更新', exact: true }).click();
    await expect(
      page.getByText(
        'おすすめの情報が更新されました。更新ボタンで取得し直してください。',
      ),
    ).toBeVisible();
    state.stale = false;
    await page.getByRole('button', { name: '再試行', exact: true }).click();
    await expect(
      page
        .getByRole('button', { name: /おすすめ\d+\.png$/, exact: true })
        .first(),
    ).toBeVisible();
    await nav.getByRole('link', { name: 'ライブラリ', exact: true }).focus();
    // Safari's native keyboard preference uses Option+Tab to include links.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(
      nav.getByRole('link', { name: 'シリーズ', exact: true }),
    ).toBeFocused();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(
      nav.getByRole('link', { name: 'タグ', exact: true }),
    ).toBeFocused();
  });
}
