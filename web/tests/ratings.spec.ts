import { expect, test } from '@playwright/test';

const image =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#b6cec4"/></svg>';

for (const section of ['library', 'favorites']) {
  test(`ratings filter, all-off selection, three badge views and manual edits in ${section}`, async ({
    page,
  }) => {
    let assets = [
      'general',
      'sensitive',
      'questionable',
      'explicit',
      'unrated',
    ].map((rating, index) => ({
      asset_id: `rating-${index}`,
      filename: `生成サンプル${index + 1}.png`,
      mime_type: 'image/png',
      tags: ['synthetic'],
      characters: [],
      status: 'ready',
      is_favorite: true,
      rating,
    }));
    let selectedRatings: string[] | undefined;
    let favoritesOnly = false;
    await page.route('**/auth/config', (route) =>
      route.fulfill({ json: { development: true } }),
    );
    await page.route('**/api/v1/**', (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === '/api/v1/me')
        return route.fulfill({
          json: { principal_id: 'demo', csrf_token: 'synthetic' },
        });
      if (path === '/api/v1/assets' || path === '/api/v1/search') {
        const body = path.endsWith('/search')
          ? route.request().postDataJSON()
          : null;
        favoritesOnly = body
          ? Boolean(body.favorites)
          : url.searchParams.get('favorites') === 'true';
        selectedRatings = body
          ? body.ratings
          : url.searchParams.has('ratings')
            ? url.searchParams.get('ratings')?.split(',').filter(Boolean)
            : undefined;
        const visible = assets.filter(
          (asset) => !selectedRatings || selectedRatings.includes(asset.rating),
        );
        return route.fulfill({
          json: { assets: visible, ...(body ? {} : { total: visible.length }) },
        });
      }
      if (path.endsWith('/preview') || path.endsWith('/content'))
        return route.fulfill({ contentType: 'image/svg+xml', body: image });
      if (path.endsWith('/renditions'))
        return route.fulfill({ json: { renditions: [] } });
      if (path.endsWith('/jobs')) return route.fulfill({ json: { jobs: [] } });
      const id = path.split('/').at(-1);
      if (route.request().method() === 'PATCH') {
        assets = assets.map((asset) =>
          asset.asset_id === id
            ? { ...asset, ...route.request().postDataJSON() }
            : asset,
        );
      }
      return route.fulfill({
        json: assets.find((asset) => asset.asset_id === id),
      });
    });
    await page.goto('/');
    if (section === 'favorites') {
      await page
        .getByRole('navigation', { name: 'ワークスペース' })
        .getByRole('button', { name: 'お気に入り', exact: true })
        .click();
    }
    await expect(page.locator('.file')).toHaveCount(5);
    for (const view of ['list', 'grid', 'detailed-grid']) {
      await page.getByRole('combobox', { name: '表示方法' }).selectOption(view);
      await expect(page.locator('.rating-badge')).toHaveCount(3);
      await expect(page.locator('.rating-badge').first()).toBeVisible();
    }
    await page
      .getByRole('button', { name: '生成サンプル2.png', exact: true })
      .click();
    await expect(page.getByLabel('コンテンツレーティング')).toHaveValue(
      'sensitive',
    );
    await page.getByLabel('コンテンツレーティング').selectOption('general');
    await expect(
      page.getByRole('status').filter({ hasText: '保存しました' }),
    ).toBeVisible();
    await expect(page.locator('.rating-badge')).toHaveCount(2);
    for (const rating of ['sensitive', 'questionable', 'explicit', 'unrated']) {
      await page
        .getByRole('checkbox', {
          name: rating === 'unrated' ? '未判定' : rating,
          exact: true,
        })
        .uncheck();
      await expect(
        page.getByRole('checkbox', { name: 'general', exact: true }),
      ).toBeEnabled();
    }
    await expect(page.locator('.file')).toHaveCount(2);
    expect(selectedRatings).toEqual(['general']);
    await page.getByRole('searchbox').fill('synthetic');
    await page.getByRole('button', { name: '検索', exact: true }).click();
    await expect(page.locator('.file')).toHaveCount(2);
    expect(selectedRatings).toEqual(['general']);
    expect(favoritesOnly).toBe(section === 'favorites');
    await page
      .getByRole('checkbox', { name: 'general', exact: true })
      .uncheck();
    await expect(page.locator('.file')).toHaveCount(0);
    expect(selectedRatings).toEqual([]);
    await page.getByRole('checkbox', { name: 'explicit', exact: true }).check();
    await expect(page.locator('.file')).toHaveCount(1);
    await page
      .getByRole('button', { name: '生成サンプル4.png', exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 1000 });
    await expect(page.getByLabel('コンテンツレーティング')).toHaveValue(
      'explicit',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('.preview img')).toHaveJSProperty(
      'naturalWidth',
      320,
    );
    if (section === 'library')
      await page.screenshot({
        path: '../docs/content-ratings.png',
        fullPage: true,
      });
  });
}
