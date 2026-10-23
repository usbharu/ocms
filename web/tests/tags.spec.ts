import { expect, test } from '@playwright/test';
import type { Core } from 'cytoscape';

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

test('library graph supports selection, zoom and keyboard navigation', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  const graph = page.getByRole('img', {
    name: 'タグの関係グラフ：3タグ、1本の線',
  });
  await expect(graph.locator('canvas').first()).toBeVisible();
  await expect(graph).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('combobox', { name: 'タグを選択' }).selectOption('旅行');
  await expect(page.getByText('20件のファイル · 関連タグ 1件')).toBeVisible();
  await page.getByRole('button', { name: '拡大', exact: true }).click();
  await expect(page.getByRole('button', { name: '全体を表示' })).toHaveText(
    '150%',
  );
  await page.getByRole('button', { name: '全体を表示' }).click();
  await expect(page.getByRole('button', { name: '全体を表示' })).toHaveText(
    '100%',
  );
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/tags-graph.png', fullPage: true });
  await page.getByRole('button', { name: 'ファイルを表示' }).click();
  await expect(page.getByRole('heading', { name: 'タグ：旅行' })).toBeVisible();
});

test('recovers from load failure and ignores old search responses', async ({
  page,
}) => {
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
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
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
  await page.getByRole('searchbox').fill('古い');
  await page.waitForRequest('**/api/v1/tags?q=*');
  await page.getByRole('searchbox').fill('旅行');
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
  await page.waitForTimeout(700);
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
});

test('tag views fit narrow screens and retain navigation', async ({ page }) => {
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
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
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
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
  await expect(
    page.getByRole('combobox', { name: 'タグを選択' }).locator('option'),
  ).toHaveCount(71);
  await expect(
    page.getByText(
      '被リンク数の上位70タグを表示しています。検索で絞り込めます。',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  await expect(
    page.getByRole('img', { name: 'タグの関係グラフ：60タグ、59本の線' }),
  ).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'タグを選択' }).locator('option'),
  ).toHaveCount(61);
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

test('navigation and upload share one header without stacked page headings', async ({
  page,
}) => {
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.locator('header nav')).toHaveCount(1);
  await expect(page.locator('.workspace-heading')).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'ライブラリ' })
    .click();
  await expect(
    page.locator('header').getByRole('button', { name: '＋ アップロード' }),
  ).toBeVisible();
  await expect(page.locator('main > nav')).toHaveCount(0);
  await expect(page.locator('.workspace-heading')).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const header = await page.locator('header').boundingBox();
    expect(header?.height).toBeLessThanOrEqual(68);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test('dense graph separates labels and relaxes after dragging without resetting zoom', async ({
  page,
}) => {
  await expect(page.locator('.tag-cloud [role=button]')).toHaveCount(3);
  const dense = Array.from({ length: 60 }, (_, i) => ({
    name: `関連する長めのタグ${i}`,
    asset_count: 80 - i,
  }));
  const links = dense.flatMap((source, i) =>
    dense.slice(i + 1).map((target) => ({
      source: source.name,
      target: target.name,
      asset_count: 2,
    })),
  );
  await page.route('**/api/v1/tags?*', (route) =>
    route.fulfill({ json: { tags: dense, total: dense.length, links } }),
  );
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'タグを選択' }).locator('option'),
  ).toHaveCount(61);
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  const graph = page.getByRole('img', { name: /タグの関係グラフ/ });
  await expect(graph).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  // Inspect the actual rendered graph through Cytoscape's container registry.
  // Bounds include labels; counting DOM canvases would miss the reported overlap.
  const inspect = () =>
    graph.evaluate((element) => {
      const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
      const nodes = cy.nodes().toArray();
      let overlaps = 0;
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i].boundingBox({
            includeLabels: true,
            includeOverlays: false,
          });
          const b = nodes[j].boundingBox({
            includeLabels: true,
            includeOverlays: false,
          });
          if (
            Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1 &&
            Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 1
          )
            overlaps++;
        }
      return {
        overlaps,
        positions: nodes.map((node) => ({ id: node.id(), ...node.position() })),
        zoom: cy.zoom(),
        widths: nodes.map((node) => node.width()),
      };
    });
  const initial = await inspect();
  await expect.poll(async () => (await inspect()).overlaps).toBe(0);
  expect(initial.widths[0]).toBeGreaterThan(initial.widths[59]);
  await page.getByRole('button', { name: '再配置', exact: true }).click();
  await expect(graph).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  await expect.poll(async () => (await inspect()).overlaps).toBe(0);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({
      path: '../docs/tags-graph-dense.png',
      fullPage: true,
    });
  await page.getByRole('button', { name: '拡大', exact: true }).click();
  const before = await inspect();
  const center = await graph.evaluate((element) => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    const node = cy.nodes().sort((a, b) => {
      const p = a.renderedPosition();
      const q = b.renderedPosition();
      return (
        Math.hypot(p.x - cy.width() / 2, p.y - cy.height() / 2) -
        Math.hypot(q.x - cy.width() / 2, q.y - cy.height() / 2)
      );
    })[0];
    return { id: node.id(), ...node.renderedPosition() };
  });
  const bounds = await graph.boundingBox();
  if (!bounds) throw new Error('missing graph');
  await page.mouse.move(bounds.x + center.x, bounds.y + center.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + center.x + 80, bounds.y + center.y + 60, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(graph).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  await expect
    .poll(async () =>
      (await inspect()).positions.some(
        (node, i) =>
          node.id !== center.id &&
          Math.hypot(
            node.x - before.positions[i].x,
            node.y - before.positions[i].y,
          ) > 0.5,
      ),
    )
    .toBe(true);
  await expect.poll(async () => (await inspect()).overlaps).toBe(0);
  const after = await inspect();
  expect(after.zoom).toBeCloseTo(before.zoom, 4);
  await page.getByRole('button', { name: '動きを停止', exact: true }).click();
  const paused = await inspect();
  await page.waitForTimeout(250);
  expect((await inspect()).positions).toEqual(paused.positions);
  await page.getByRole('button', { name: '動きを再開', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '動きを停止', exact: true }),
  ).toBeVisible();

  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'ライブラリ' })
    .click();
  await expect(page.locator('.tag-graph')).toHaveCount(0);
});

test('reduced motion starts with a still graph and allows explicit simulation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'グラフ', exact: true }).click();
  const graph = page.getByRole('img', { name: /タグの関係グラフ/ });
  await expect(graph).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByRole('button', { name: '動きを再開', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '動きを再開', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '動きを停止', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '動きを停止', exact: true }).click();
});
