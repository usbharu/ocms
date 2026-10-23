import { expect, test } from '@playwright/test';

const tags = [
  { name: '旅行', asset_count: 20 },
  { name: '風景', asset_count: 8 },
  { name: '資料', asset_count: 1 },
];

test.beforeEach(async ({ page }) => {
  await page.route('**/auth/config', (route) =>
    route.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/me'))
      return route.fulfill({ json: { principal_id: 'demo' } });
    if (url.pathname.endsWith('/tags')) {
      const matching = tags.filter((tag) =>
        tag.name.includes(url.searchParams.get('q') || ''),
      );
      return route.fulfill({
        json: {
          tags: matching,
          total: matching.length,
          links:
            matching.length === 3
              ? [{ source: '旅行', target: '風景', asset_count: 4 }]
              : [],
        },
      });
    }
    return route.fulfill({ json: { assets: [], total: 0 } });
  });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'ワークスペース' })
    .getByRole('button', { name: 'タグ', exact: true })
    .click();
});

test('tag cloud sizes follow backlinks and opens exact tag filtering', async ({
  page,
}) => {
  const cloud = page.getByRole('region', { name: 'タグのワードクラウド' });
  await expect(cloud.getByRole('button')).toHaveCount(3);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/tags-cloud.png', fullPage: true });
  const size = (name: string) =>
    cloud
      .getByRole('button', { name })
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(await size('旅行：20件')).toBeGreaterThan(await size('資料：1件'));
  const request = page.waitForRequest(
    (r) => new URL(r.url()).searchParams.get('tag') === '旅行',
  );
  await cloud.getByRole('button', { name: '旅行：20件' }).click();
  await request;
  await expect(page.getByRole('heading', { name: 'タグ：旅行' })).toBeVisible();
  await page.getByRole('button', { name: '検索を解除' }).click();
  await expect(
    page.getByRole('heading', { name: 'すべてのファイル' }),
  ).toBeVisible();
});

test('searches tags, switches list and handles empty results', async ({
  page,
}) => {
  await page.getByRole('button', { name: '一覧', exact: true }).click();
  await expect(page.locator('.tag-list li')).toHaveCount(3);
  await page.getByRole('searchbox', { name: 'タグを検索' }).fill('風');
  await expect(page.locator('.tag-list li')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '風景 8件' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'タグを検索' }).fill('なし');
  await expect(page.getByText('一致するタグがありません。')).toBeVisible();
  await page.getByRole('searchbox', { name: 'タグを検索' }).fill('');
  await expect(page.locator('.tag-list li')).toHaveCount(3);
});

test('graph shows weighted edges, selection, zoom and keyboard activation', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  const graph = page.getByRole('region', { name: 'タグの関係グラフ' });
  await expect(graph.getByRole('button')).toHaveCount(3);
  await expect(graph.locator('line')).toHaveCount(1);
  const big = await graph
    .locator('.tag-node-circle')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  const small = await graph
    .locator('.tag-node-circle')
    .last()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(big).toBeGreaterThan(small);
  await graph.getByRole('button', { name: '旅行：20件' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('20件のファイル · 関連タグ 1件')).toBeVisible();
  await page.getByRole('button', { name: '拡大', exact: true }).click();
  await expect(page.getByRole('button', { name: '150%' })).toBeVisible();
  await page.getByRole('button', { name: '150%' }).click();
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/tags-graph.png', fullPage: true });
  await page.getByRole('button', { name: 'ファイルを表示' }).click();
  await expect(page.getByRole('heading', { name: 'タグ：旅行' })).toBeVisible();
});

test('recovers from load failure and ignores old search responses', async ({
  page,
}) => {
  await expect(page.locator('.tag-cloud button')).toHaveCount(3);
  let fail = true;
  await page.route('**/api/v1/tags?*', async (route) => {
    if (fail) return route.fulfill({ status: 503, json: {} });
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === '古い') await new Promise((resolve) => setTimeout(resolve, 600));
    return route.fulfill({
      json: {
        tags: q === '古い' ? [] : tags,
        total: q === '古い' ? 0 : 3,
        links: [],
      },
    });
  });
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('タグを読み込めません');
  fail = false;
  await page.getByRole('button', { name: '再試行' }).click();
  await expect(page.locator('.tag-cloud button')).toHaveCount(3);
  await page.getByRole('searchbox').fill('古い');
  await page.waitForRequest('**/api/v1/tags?q=*');
  await page.getByRole('searchbox').fill('旅行');
  await expect(page.locator('.tag-cloud button')).toHaveCount(3);
  await page.waitForTimeout(700);
  await expect(page.locator('.tag-cloud button')).toHaveCount(3);
});

test('tag views fit narrow screens and retain navigation', async ({ page }) => {
  await expect(page.locator('.tag-cloud button')).toHaveCount(3);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ['ワードクラウド', '一覧', 'グラフ']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await expect(page.getByRole('searchbox')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
  }
  await page
    .getByRole('button', { name: 'ワードクラウド', exact: true })
    .click();
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/tags-mobile.png', fullPage: true });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'ライブラリ' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'ライブラリ', exact: true }),
  ).toBeVisible();
});

test('graph bounds large tag sets and long labels stay inside narrow layouts', async ({
  page,
}) => {
  await expect(page.locator('.tag-cloud button')).toHaveCount(3);
  const many = Array.from({ length: 70 }, (_, i) => ({
    name: i === 0 ? '長いタグ'.repeat(20) : `タグ${i}`,
    asset_count: 70 - i,
  }));
  await page.route('**/api/v1/tags?*', (route) =>
    route.fulfill({
      json: {
        tags: many,
        total: 220,
        links: many.slice(1, 60).map((tag) => ({
          source: many[0].name,
          target: tag.name,
          asset_count: 1,
        })),
      },
    }),
  );
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.locator('.tag-cloud button')).toHaveCount(70);
  await expect(
    page.getByText(
      '被リンク数の上位70タグを表示しています。検索で絞り込めます。',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  await expect(page.locator('.tag-node')).toHaveCount(60);
  await expect(page.locator('.tag-graph-scroll line')).toHaveCount(59);
  await expect(
    page.getByText(
      'グラフは被リンク数の上位60タグを表示しています。検索で絞り込めます。',
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  for (const view of ['ワードクラウド', '一覧', 'グラフ']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  }
});
