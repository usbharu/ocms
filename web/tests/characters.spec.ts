import { expect, test } from '@playwright/test';

const characters = [
  { name: 'character_a', asset_count: 20 },
  { name: 'character_b', asset_count: 8 },
];

test.beforeEach(async ({ page }) => {
  await page.route('**/auth/config', (r) =>
    r.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/me'))
      return route.fulfill({ json: { principal_id: 'demo' } });
    if (url.pathname.endsWith('/characters')) {
      const matching = characters.filter((c) =>
        c.name.includes(url.searchParams.get('q') || ''),
      );
      return route.fulfill({
        json: {
          characters: matching,
          total: matching.length,
          links:
            matching.length === 2
              ? [
                  {
                    source: 'character_a',
                    target: 'character_b',
                    asset_count: 4,
                  },
                ]
              : [],
        },
      });
    }
    return route.fulfill({ json: { assets: [], total: 0 } });
  });
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'キャラクター', exact: true })
    .click();
});

test('character cloud, list, search and graph open an independent exact filter', async ({
  page,
}) => {
  const cloud = page.getByRole('region', {
    name: 'キャラクターのワードクラウド',
  });
  await expect(cloud.getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: '一覧', exact: true }).click();
  await expect(page.locator('.tag-list li')).toHaveCount(2);
  await page
    .getByRole('searchbox', { name: 'キャラクターを検索' })
    .fill('missing');
  await expect(
    page.getByText('一致するキャラクターがありません。'),
  ).toBeVisible();
  await page.getByRole('searchbox').fill('character_b');
  await expect(page.locator('.tag-list li')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  const graph = page.getByRole('img', {
    name: 'キャラクターの関係グラフ：2キャラクター、1本の線',
  });
  await expect(graph).toHaveAttribute('aria-busy', 'false');
  await page
    .getByRole('combobox', { name: 'キャラクターを選択' })
    .selectOption('character_a');
  await expect(
    page.getByText('20件のファイル · 関連キャラクター 1件'),
  ).toBeVisible();
  await page.screenshot({
    path: '../docs/characters-graph.png',
    fullPage: true,
  });
  const request = page.waitForRequest(
    (r) => new URL(r.url()).searchParams.get('character') === 'character_a',
  );
  await page.getByRole('button', { name: 'ファイルを表示' }).click();
  const url = new URL((await request).url());
  expect(url.searchParams.has('tag')).toBe(false);
  await expect(
    page.getByRole('heading', { name: 'キャラクター：character_a' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '検索を解除' }).click();
  await expect(
    page.getByRole('heading', { name: 'すべてのファイル' }),
  ).toBeVisible();
});

test('character views fit mobile widths', async ({ page }) => {
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(2);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ['一覧', 'グラフ', 'ワードクラウド']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await expect(page.getByRole('searchbox')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
  }
});

test('characters can be edited separately from tags', async ({ page }) => {
  const asset = {
    asset_id: 'test',
    filename: 'generated.png',
    mime_type: 'image/png',
    status: 'ready',
    tags: ['general'],
    characters: ['character_a'],
  };
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PATCH') {
      const changes = route.request().postDataJSON();
      expect(changes.tags).toBeUndefined();
      Object.assign(asset, changes);
      return route.fulfill({ json: asset });
    }
    if (url.pathname.endsWith('/assets'))
      return route.fulfill({ json: { assets: [asset], total: 1 } });
    if (url.pathname.endsWith('/assets/test'))
      return route.fulfill({ json: asset });
    return route.fulfill({ json: { renditions: [], jobs: [] } });
  });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'ライブラリ' })
    .click();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByText('generated.png', { exact: true }).first().click();
  await page
    .getByRole('textbox', { name: 'キャラクター', exact: true })
    .fill('character_b');
  await page
    .getByRole('button', { name: 'キャラクターを追加', exact: true })
    .click();
  await expect(
    page.getByRole('list', { name: '登録済みキャラクター' }),
  ).toContainText('character_b');
  await page
    .getByRole('button', { name: 'キャラクター「character_a」を削除' })
    .click();
  await expect(
    page.getByRole('list', { name: '登録済みキャラクター' }),
  ).not.toContainText('character_a');
  await expect(page.getByRole('list', { name: '登録済みタグ' })).toContainText(
    'general',
  );
});
