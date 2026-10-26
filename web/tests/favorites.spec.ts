import { expect, test } from '@playwright/test';

for (const section of ['library', 'favorites']) {
  test(`favorite changes survive recommendation back navigation from ${section}`, async ({
    page,
  }) => {
    const items = [
      {
        asset_id: 'source',
        filename: '元.png',
        mime_type: 'image/png',
        tags: [],
        status: 'ready',
        is_favorite: true,
      },
      {
        asset_id: 'related',
        filename: '関連.png',
        mime_type: 'image/png',
        tags: [],
        status: 'ready',
        is_favorite: true,
      },
    ];
    await page.route('**/auth/config', (r) => r.fulfill({ json: {} }));
    await page.route('**/api/v1/**', (r) => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/me'))
        return r.fulfill({ json: { principal_id: 'alice' } });
      if (url.pathname.endsWith('/favorite')) {
        items[1].is_favorite = false;
        return r.fulfill({ status: 204 });
      }
      if (url.pathname.endsWith('/recommendations'))
        return r.fulfill({
          json: {
            assets: [
              {
                ...items[1],
                score: 80,
                common_tags: [],
                common_characters: [],
              },
            ],
          },
        });
      if (url.pathname === '/api/v1/assets') {
        const assets =
          url.searchParams.get('favorites') === 'true'
            ? items.filter((a) => a.is_favorite)
            : items;
        return r.fulfill({ json: { assets, total: assets.length } });
      }
      if (url.pathname.endsWith('/renditions'))
        return r.fulfill({ json: { renditions: [] } });
      if (url.pathname.endsWith('/jobs'))
        return r.fulfill({ json: { jobs: [] } });
      return r.fulfill({ json: items[0] });
    });
    await page.goto('/');
    if (section === 'favorites')
      await page
        .getByRole('navigation', { name: 'ワークスペース' })
        .getByRole('link', { name: 'お気に入り', exact: true })
        .click();
    await page.getByRole('button', { name: '元.png', exact: true }).click();
    await page
      .getByRole('button', { name: '関連コンテンツ', exact: true })
      .click();
    await page
      .getByRole('button', { name: '関連.png：お気に入りを解除' })
      .click();
    await expect(
      page.getByRole('button', { name: '関連.png：お気に入りに登録' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '戻る', exact: true }).click();
    const list = page.getByRole('region', { name: 'ファイル一覧' });
    if (section === 'favorites')
      await expect(list.locator('.file')).toHaveCount(1);
    else
      await expect(
        list.getByRole('button', { name: '関連.png：お気に入りに登録' }),
      ).toBeVisible();
  });
}

for (const view of ['list', 'grid', 'detailed-grid']) {
  test(`favorites in ${view}`, async ({ page }) => {
    let favorite = false;
    let fail = true;
    let puts = 0;
    const asset = () => ({
      asset_id: 'image',
      filename: '風景.png',
      mime_type: 'image/png',
      tags: [],
      status: 'ready',
      is_favorite: favorite,
    });
    await page.addInitScript(
      (value) => localStorage.setItem('ocms.library.view', value),
      view,
    );
    await page.route('**/auth/config', (r) =>
      r.fulfill({ json: { development: true } }),
    );
    await page.route('**/api/v1/**', async (r) => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/me'))
        return r.fulfill({
          json: { principal_id: 'alice', csrf_token: 'test' },
        });
      if (url.pathname.endsWith('/favorite')) {
        expect(r.request().headers()['x-csrf-token']).toBe('test');
        if (fail) {
          fail = false;
          return r.fulfill({ status: 503, json: { error: 'FAILED' } });
        }
        if (r.request().method() === 'PUT') puts++;
        await new Promise((resolve) => setTimeout(resolve, 150));
        favorite = r.request().method() === 'PUT';
        return r.fulfill({ status: 204 });
      }
      if (url.pathname === '/api/v1/assets') {
        const assets =
          url.searchParams.get('favorites') === 'true' && !favorite
            ? []
            : [asset()];
        return r.fulfill({ json: { assets, total: assets.length } });
      }
      if (url.pathname === '/api/v1/search') {
        expect(r.request().postDataJSON().favorites).toBe(true);
        return r.fulfill({ json: { assets: favorite ? [asset()] : [] } });
      }
      if (url.pathname.endsWith('/renditions'))
        return r.fulfill({ json: { renditions: [] } });
      if (url.pathname.endsWith('/jobs'))
        return r.fulfill({ json: { jobs: [] } });
      if (
        url.pathname.endsWith('/content') ||
        url.pathname.endsWith('/preview')
      )
        return r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>',
        });
      return r.fulfill({ json: asset() });
    });
    await page.goto('/');
    const register = page.getByRole('button', {
      name: '風景.png：お気に入りに登録',
    });
    await register.click();
    await expect(page.getByRole('alert')).toContainText('保存できません');
    await expect(register).toHaveAttribute('aria-pressed', 'false');
    await register.click();
    await expect(register).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '風景.png：お気に入りを解除' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('button', { name: '風景.png：お気に入りを解除' }),
    ).toHaveCSS('color', 'rgb(234, 179, 8)');
    expect(puts).toBe(1);
    await expect(
      page.getByRole('region', { name: 'ファイル詳細' }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('button', { name: '風景.png：お気に入りを解除' }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'ワークスペース' })
      .getByRole('link', { name: 'お気に入り', exact: true })
      .click();
    for (const mode of ['keyword', 'semantic', 'hybrid']) {
      await page.getByRole('searchbox').fill('風景');
      await page.getByRole('combobox', { name: '検索方法' }).selectOption(mode);
      await page.getByRole('button', { name: '検索', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '風景.png', exact: true }),
      ).toBeVisible();
    }
    await page.getByRole('button', { name: '検索を解除' }).click();
    await expect(
      page.getByRole('region', { name: 'ファイル一覧' }),
    ).toHaveAttribute('aria-busy', 'false');
    await expect(
      page.getByRole('heading', { level: 2, name: 'お気に入り', exact: true }),
    ).toBeVisible();
    if (view === 'list') {
      const status = await page.locator('.file > .status').boundingBox();
      const star = await page
        .locator('.file-entry > .favorite-button')
        .boundingBox();
      expect(status && star && status.x + status.width <= star.x).toBe(true);
    }
    await page.screenshot({ path: `../.cache/favorites-${view}.png` });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.screenshot({
      path: `../.cache/favorites-${view}-filled-mobile.png`,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '風景.png', exact: true }).click();
    const details = page.getByRole('region', { name: 'ファイル詳細' });
    await expect(
      details.getByRole('button', { name: '風景.png：お気に入りを解除' }),
    ).toBeVisible();
    await details.getByRole('button', { name: 'ファイルを閲覧' }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: '風景.png：お気に入りを解除' })
      .click();
    await expect(
      dialog.getByRole('button', { name: '風景.png：お気に入りに登録' }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: '閲覧を閉じる' }).click();
    await expect(page.getByText('お気に入りはまだありません')).toBeVisible();
    await details.getByRole('button', { name: '詳細を閉じる' }).click();
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(
      page.getByRole('button', { name: 'ライブラリを開く' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `../.cache/favorites-${view}-mobile.png` });
    await page.getByRole('button', { name: 'ライブラリを開く' }).click();
    await expect(
      page.getByRole('heading', { name: 'ライブラリ', exact: true }),
    ).toBeAttached();
  });
}

test('removing the last favorite on a page corrects pagination and keeps detail focus', async ({
  page,
}) => {
  let items = Array.from({ length: 25 }, (_, i) => ({
    asset_id: String(i),
    filename: `file-${i}.png`,
    mime_type: 'image/png',
    tags: [],
    status: 'ready',
    is_favorite: true,
  }));
  const allItems = [...items];
  await page.route('**/auth/config', (r) => r.fulfill({ json: {} }));
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/me'))
      return r.fulfill({ json: { principal_id: 'alice' } });
    if (url.pathname.endsWith('/favorite')) {
      items = items.filter((a) => a.asset_id !== url.pathname.split('/')[4]);
      return r.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/v1/assets') {
      const offset = Number(url.searchParams.get('offset'));
      return r.fulfill({
        json: { assets: items.slice(offset, offset + 24), total: items.length },
      });
    }
    return r.fulfill({
      json: {
        ...(allItems.find((asset) =>
          url.pathname.endsWith(`/${asset.asset_id}`),
        ) ?? items[0]),
        is_favorite: items.some((asset) =>
          url.pathname.endsWith(`/${asset.asset_id}`),
        ),
        renditions: [],
        jobs: [],
      },
    });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'ワークスペース' })
    .getByRole('link', { name: 'お気に入り', exact: true })
    .click();
  await page.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('button', { name: 'file-24.png', exact: true }).click();
  const star = page
    .getByRole('region', { name: 'ファイル一覧' })
    .getByRole('button', { name: 'file-24.png：お気に入りを解除' });
  await star.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'ファイル一覧' }).locator('.file'),
  ).toHaveCount(24);
  await expect(
    page
      .getByRole('region', { name: 'ファイル詳細' })
      .getByRole('button', { name: 'file-24.png：お気に入りに登録' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  await expect(
    page.getByRole('button', { name: 'file-0.png', exact: true }),
  ).toBeFocused();
});
