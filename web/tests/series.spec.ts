import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const a = {
  asset_id: 'page-a',
  filename: '漫画 001.png',
  mime_type: 'image/png',
  tags: ['漫画'],
  characters: ['人物A'],
  rating: 'general',
  status: 'ready',
};
const b = { ...a, asset_id: 'page-b', filename: '漫画 002.png' };
const video = {
  ...a,
  asset_id: 'movie',
  filename: '動画.mp4',
  mime_type: 'video/mp4',
};
const composite = {
  ...a,
  asset_id: 'comic',
  filename: '漫画',
  mime_type: 'application/vnd.ocms.series',
  series_kind: 'composite',
  series_version: 1,
  member_ids: [a.asset_id, b.asset_id],
  cover_asset_id: a.asset_id,
  members: [a, b],
  editable: true,
};
const collection = {
  ...composite,
  asset_id: 'collection',
  filename: '作品集',
  series_kind: 'collection',
  members: [video, composite],
  member_ids: [video.asset_id, composite.asset_id],
};
const preview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="#dce9e5"/><path d="M20 600 240 50 460 600Z" fill="#527d67"/></svg>';

async function setup(page: Page, failure = false, logicalLibrary = false) {
  const saves: { name: string; kind: string; member_ids: string[] }[] = [];
  let saved = composite;
  let grouped = false;
  await page.route('**/auth/config', (r) =>
    r.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/me'))
      return route.fulfill({
        json: { principal_id: 'demo', csrf_token: 'test' },
      });
    if (path === '/api/v1/assets/movie/content')
      return route.fulfill({
        contentType: 'video/mp4',
        body: readFileSync(new URL('./fixtures/series.mp4', import.meta.url)),
      });
    if (path.endsWith('/preview') || path.endsWith('/content'))
      return route.fulfill({ contentType: 'image/svg+xml', body: preview });
    if (path.endsWith('/renditions'))
      return route.fulfill({ json: { renditions: [] } });
    if (path.endsWith('/jobs')) return route.fulfill({ json: { jobs: [] } });
    if (path.endsWith('/suggestions')) {
      if (failure)
        return route.fulfill({
          status: 503,
          json: { error: 'SERVICE_UNAVAILABLE' },
        });
      const body = req.postDataJSON();
      return route.fulfill({
        json: {
          assets: [a, b]
            .filter((asset) => !body.member_ids.includes(asset.asset_id))
            .map((asset) => ({ ...asset, reasons: ['タイトルが近い'] })),
        },
      });
    }
    if (path === '/api/v1/series' && req.method() === 'POST') {
      const body = req.postDataJSON();
      saves.push(body);
      grouped = true;
      saved = {
        ...composite,
        filename: body.name,
        members: body.member_ids.map((id: string) =>
          id === a.asset_id ? a : b,
        ),
        member_ids: body.member_ids,
      };
      return route.fulfill({ json: saved });
    }
    if (path === '/api/v1/series') {
      const query = new URL(req.url()).searchParams;
      const filtered = [saved, collection].filter(
        (asset) =>
          !query.get('series_kind') ||
          asset.series_kind === query.get('series_kind'),
      );
      const offset = Number(query.get('offset'));
      return route.fulfill({
        json: {
          assets: filtered.slice(offset, offset + 200),
          total: filtered.length,
        },
      });
    }
    if (path === '/api/v1/series/comic') return route.fulfill({ json: saved });
    if (path === '/api/v1/series/collection')
      return route.fulfill({ json: collection });
    if (path === '/api/v1/assets/comic') return route.fulfill({ json: saved });
    if (path === '/api/v1/assets/collection')
      return route.fulfill({ json: collection });
    if (path === '/api/v1/assets')
      return route.fulfill({
        json: {
          assets: grouped
            ? [saved]
            : logicalLibrary
              ? [saved, collection]
              : [a, b],
          total: grouped ? 1 : 2,
        },
      });
    if (path === '/api/v1/search')
      return route.fulfill({ json: { assets: [composite] } });
    if (path.endsWith('/favorite')) return route.fulfill({ status: 204 });
    return route.fulfill({
      json: grouped
        ? {
            ...(path.endsWith('/page-b') ? b : a),
            composite_id: saved.asset_id,
          }
        : path.endsWith('/page-b')
          ? b
          : a,
    });
  });
  return saves;
}

test('create from details, reorder and view in saved order', async ({
  page,
}) => {
  const saves = await setup(page);
  await page.goto('/assets/page-a');
  await page.getByRole('link', { name: 'シリーズを作成' }).click();
  await expect(page).toHaveURL(/series\/new\?source=page-a/);
  await page.getByLabel('種類', { exact: true }).selectOption('composite');
  await page.getByLabel('シリーズ名').fill('漫画まとめ');
  await expect(page.getByText('タイトルが近い')).toBeVisible();
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await page
    .getByRole('button', { name: '漫画 002.pngを上へ', exact: true })
    .click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(/\/assets\/comic$/);
  expect(saves[0]).toMatchObject({
    name: '漫画まとめ',
    kind: 'composite',
    member_ids: ['page-b', 'page-a'],
  });
  await page.getByRole('button', { name: 'ファイルを閲覧' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
    b.filename,
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
    a.filename,
  );
  await expect(
    page.getByRole('button', { name: '次のファイル' }),
  ).toBeDisabled();
});

test('video ended advances into nested composite and member URL survives reload', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/series/collection/view');
  await expect(page.locator('video')).toBeVisible();
  await expect(page.locator('video')).toHaveAttribute('autoplay', '');
  await page.locator('video').dispatchEvent('ended');
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
    a.filename,
  );
  await expect(page).toHaveURL(/member=page-a/);
  await page.reload();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
    a.filename,
  );
  await page.getByRole('button', { name: '次のファイル' }).click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
    b.filename,
  );
  await page.getByRole('button', { name: '閲覧を閉じる' }).click();
  await expect(page).toHaveURL(/\/assets\/collection$/);
  await page.getByRole('button', { name: 'ファイルを閲覧' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('header, kind filter and direct routes', async ({ page }) => {
  await setup(page);
  await page.goto('/library?kind=series');
  await expect(
    page
      .getByRole('group', { name: 'ファイルの種類' })
      .getByRole('button', { name: 'シリーズ', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'シリーズ', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'シリーズ', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: '作品集', exact: true }).click();
  await expect(page).toHaveURL(/\/assets\/collection$/);
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '作品集', exact: true }),
  ).toBeVisible();
});

test('suggestion failure preserves the draft', async ({ page }) => {
  await setup(page, true);
  await page.goto('/series/new?source=page-a');
  await page.getByLabel('シリーズ名').fill('作成中');
  await expect(page.getByRole('alert')).toContainText('候補を取得できません');
  await expect(
    page.getByRole('heading', { name: '選択済み（1）' }),
  ).toBeVisible();
  await expect(page.getByLabel('シリーズ名')).toHaveValue('作成中');
  await expect(
    page.getByRole('button', { name: '保存', exact: true }),
  ).toBeDisabled();
});

for (const width of [1440, 390]) {
  test(`editor keyboard and layout ${width}px`, async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/series/comic/edit');
    await expect(page.getByLabel('シリーズ名')).toHaveValue('漫画');
    await page
      .getByRole('button', { name: '漫画 002.pngを上へ', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(
      page.locator('.series-editor section').first().locator('li').first(),
    ).toContainText(b.filename);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole('status')).toHaveCount(0);
    if (process.env.OCMS_CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../docs/series-editor-${width}.png`,
        fullPage: true,
      });
  });
}

test('returning to the library after grouping discards old page snapshots', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/library');
  await page.getByRole('button', { name: a.filename, exact: true }).click();
  await page.getByRole('link', { name: 'シリーズを作成' }).click();
  await page.getByLabel('種類', { exact: true }).selectOption('composite');
  await page.getByLabel('シリーズ名').fill('漫画まとめ');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(/assets\/comic$/);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/assets\/comic/);
  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('.file')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: '漫画まとめ', exact: true }),
  ).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`series selection uses ordinary details and viewer at ${width}px`, async ({
    page,
  }) => {
    await setup(page, false, true);
    const paths: string[] = [];
    page.on('request', (r) => paths.push(new URL(r.url()).pathname));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/library?kind=series');
    await page.getByRole('button', { name: '漫画', exact: true }).click();
    await expect(page).toHaveURL(/\/assets\/comic\?kind=series/);
    const detail = page.getByRole('region', { name: 'ファイル詳細' });
    await expect(
      detail.getByRole('heading', { name: '漫画', exact: true }),
    ).toBeVisible();
    await expect(detail.locator('.preview img')).toHaveAttribute(
      'src',
      /page-a\/(?:content|preview)$/,
    );
    await expect(detail.getByLabel('コンテンツレーティング')).toBeDisabled();
    await expect(
      detail.getByRole('button', { name: 'タグ「漫画」で検索', exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole('button', { name: 'タグ「漫画」を削除' }),
    ).toHaveCount(0);
    await expect(
      detail.getByRole('link', { name: 'シリーズを編集' }),
    ).toHaveAttribute('href', '/series/comic/edit');
    expect(paths).not.toContain('/api/v1/assets/comic/renditions');
    expect(paths).not.toContain('/api/v1/assets/comic/jobs');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.OCMS_CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../docs/series-details-${width}.png`,
        fullPage: true,
      });
    await detail.getByRole('button', { name: 'ファイルを閲覧' }).click();
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
      a.filename,
    );
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
      b.filename,
    );
    await expect(page).toHaveURL(/\/assets\/comic\/view.*member=page-b/);
    await page.reload();
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
      b.filename,
    );
    await page.getByRole('button', { name: '閲覧を閉じる' }).click();
    await expect(detail).toBeVisible();
    await expect(page).toHaveURL(/\/assets\/comic\?kind=series/);
  });
}

test('series playback failures can retry inside the standard viewer', async ({
  page,
}) => {
  await setup(page, false, true);
  await page.goto('/assets/comic');
  await expect(page.locator('.preview img')).toBeVisible();
  let failed = true;
  await page.route('**/api/v1/series/comic', async (route) => {
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: 'SERVICE_UNAVAILABLE' },
      });
    return route.fallback();
  });
  await page.getByRole('button', { name: 'ファイルを閲覧' }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText('シリーズを読み込めません。', { exact: true }),
  ).toHaveText('シリーズを読み込めません。');
  failed = false;
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '再試行', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
    a.filename,
  );
});

for (const width of [1440, 390]) {
  test(`save stays directly below the name with long lists at ${width}px`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 740 });
    await page.route('**/api/v1/series/suggestions', (route) =>
      route.fulfill({
        json: {
          assets: Array.from({ length: 120 }, (_, i) => ({
            ...a,
            asset_id: `candidate-${i}`,
            filename: `候補 ${i}.png`,
          })),
        },
      }),
    );
    await page.goto('/series/comic/edit');
    await expect(
      page
        .locator('.series-editor > section')
        .nth(1)
        .locator('.series-members > li'),
    ).toHaveCount(120);
    const save = page.getByRole('button', { name: '保存', exact: true });
    await expect(save).toBeEnabled();
    const nameBox = await page.getByLabel('シリーズ名').boundingBox();
    const saveBox = await save.boundingBox();
    const listBox = await page
      .getByRole('heading', { name: '選択済み（2）' })
      .boundingBox();
    if (!nameBox || !saveBox || !listBox)
      throw new Error('Editor controls must be visible');
    expect(saveBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(listBox.y);
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(740);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeGreaterThan(740);
  });
}

test('series tab shows a composite-only library and keeps its type filter in the URL', async ({
  page,
}) => {
  await setup(page);
  await page.route('**/api/v1/series?**', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('series_kind');
    return route.fulfill({
      json: {
        assets: kind === 'collection' ? [] : [composite],
        total: kind === 'collection' ? 0 : 1,
      },
    });
  });
  await page.goto('/series');
  await expect(
    page.getByRole('link', { name: '漫画', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('シリーズがありません', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('シリーズの種類')).toHaveValue('');
  await page.getByLabel('シリーズの種類').selectOption('collection');
  await expect(
    page.getByText('通常シリーズがありません', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('シリーズの種類').selectOption('composite');
  await expect(page).toHaveURL(/series_kind=composite/);
  await expect(
    page.getByRole('link', { name: '漫画', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('シリーズの種類')).toHaveValue('composite');
  await page.getByLabel('シリーズの種類').selectOption('');
  await expect(page).toHaveURL(/\/series$/);
  await page.goBack();
  await expect(page.getByLabel('シリーズの種類')).toHaveValue('composite');
});

test('series type is applied before pagination and changing type returns to the first page', async ({
  page,
}) => {
  await setup(page);
  const entries = Array.from({ length: 402 }, (_, i) => ({
    ...composite,
    asset_id: `series-${i}`,
    filename: `シリーズ ${i}`,
    series_kind: i % 2 ? 'collection' : 'composite',
  }));
  await page.route('**/api/v1/series?**', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const kind = query.get('series_kind');
    const filtered = entries.filter(
      (asset) => !kind || asset.series_kind === kind,
    );
    const offset = Number(query.get('offset'));
    return route.fulfill({
      json: {
        assets: filtered.slice(offset, offset + 200),
        total: filtered.length,
      },
    });
  });
  await page.goto('/series?series_kind=composite');
  await expect(
    page.getByRole('link', { name: 'シリーズ 0', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'シリーズ 1', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: '次へ', exact: true }).click();
  await expect(page).toHaveURL(/series_kind=composite&page=2/);
  await expect(
    page.getByRole('link', { name: 'シリーズ 400', exact: true }),
  ).toBeVisible();
  await page.getByLabel('シリーズの種類').selectOption('collection');
  await expect(page).toHaveURL(/series_kind=collection$/);
  await expect(
    page.getByRole('link', { name: 'シリーズ 1', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '前へ', exact: true }),
  ).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`series list shows both kinds at ${width}px`, async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/series');
    await expect(
      page.getByRole('link', { name: '漫画', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: '作品集', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('シリーズの種類')).toHaveValue('');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.OCMS_CAPTURE_SCREENSHOTS)
      await page.screenshot({
        path: `../docs/series-list-${width}.png`,
        fullPage: true,
      });
  });
}

for (const width of [1440, 390, 320]) {
  for (const view of ['list', 'grid', 'detailed-grid']) {
    test(`series badges remain distinct from rating and favorites in ${view} at ${width}px`, async ({
      page,
    }) => {
      await setup(page, false, true);
      await page.route('**/api/v1/assets?**', (route) =>
        route.fulfill({
          json: {
            assets: [{ ...composite, rating: 'explicit' }, collection, a],
            total: 3,
          },
        }),
      );
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/library');
      await page.getByLabel('表示方法').selectOption(view);
      for (const name of ['漫画', '作品集']) {
        const card = page.getByRole('button', { name, exact: true });
        await expect(card.locator('.series-badge')).toBeVisible();
        await expect(card).toHaveAccessibleDescription('シリーズ');
      }
      await expect(
        page
          .getByRole('button', { name: a.filename, exact: true })
          .locator('.series-badge'),
      ).toHaveCount(0);
      const card = page.getByRole('button', { name: '漫画', exact: true });
      const badge = await card.locator('.series-badge').boundingBox();
      const cardBox = await card.boundingBox();
      if (!badge || !cardBox)
        throw new Error('Series badge and card must be visible');
      expect(badge.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(badge.y).toBeGreaterThanOrEqual(cardBox.y);
      expect(badge.x + badge.width).toBeLessThanOrEqual(
        cardBox.x + cardBox.width,
      );
      expect(badge.y + badge.height).toBeLessThanOrEqual(
        cardBox.y + cardBox.height,
      );
      for (const indicator of [
        card.locator('.rating-badge'),
        card.locator('..').locator('.favorite-button'),
      ]) {
        const other = await indicator.boundingBox();
        if (!other)
          throw new Error('Rating and favorite indicators must be visible');
        expect(
          badge.x + badge.width <= other.x ||
            other.x + other.width <= badge.x ||
            badge.y + badge.height <= other.y ||
            other.y + other.height <= badge.y,
        ).toBe(true);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (
        process.env.OCMS_CAPTURE_SCREENSHOTS &&
        (width === 1440 || (width === 390 && view === 'grid'))
      )
        await page.screenshot({
          path: `../docs/series-badges-${view}-${width}.png`,
          fullPage: true,
        });
    });
  }
}

test('series badge is visible even when its cover preview is unavailable', async ({
  page,
}) => {
  await setup(page, false, true);
  await page.route('**/preview**', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await page.goto('/library');
  await page.getByLabel('表示方法').selectOption('grid');
  const card = page.getByRole('button', { name: '漫画', exact: true });
  await expect(card.locator('.thumbnail-placeholder')).toBeVisible();
  await expect(card.locator('.series-badge')).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`composite page controls match PDF pagination at ${width}px`, async ({
    page,
  }) => {
    await setup(page, false, true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/assets/comic/view');
    const navigation = page.getByRole('navigation', {
      name: 'シリーズページ操作',
    });
    await expect(navigation).toHaveText('‹1 / 2 ページ›');
    await expect(
      navigation.getByRole('button', { name: '前のシリーズページ' }),
    ).toBeDisabled();
    await navigation
      .getByRole('button', { name: '次のシリーズページ' })
      .click();
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(
      b.filename,
    );
    await expect(navigation).toContainText('2 / 2 ページ');
    await expect(
      navigation.getByRole('button', { name: '次のシリーズページ' }),
    ).toBeDisabled();
    await expect(page).toHaveURL(/member=page-b/);
    await page.reload();
    await expect(navigation).toContainText('2 / 2 ページ');
    await navigation
      .getByRole('button', { name: '前のシリーズページ' })
      .click();
    await expect(navigation).toContainText('1 / 2 ページ');
    await page.keyboard.press('ArrowRight');
    await expect(navigation).toContainText('2 / 2 ページ');
    await page.getByRole('button', { name: '拡大', exact: true }).click();
    await expect(navigation).toBeVisible();
    const image = await page.locator('.viewer-page-image').boundingBox();
    const controls = await navigation.boundingBox();
    if (!image || !controls)
      throw new Error('Image and page controls must be visible');
    expect(controls.x).toBeGreaterThanOrEqual(0);
    expect(controls.x + controls.width).toBeLessThanOrEqual(width);
    expect(controls.y + controls.height).toBeLessThanOrEqual(900);
    await page.getByRole('button', { name: '画面に合わせる' }).click();
    if (process.env.OCMS_CAPTURE_SCREENSHOTS)
      await page.screenshot({ path: `../docs/series-viewer-${width}.png` });
  });
}

test('nested composite page numbers exclude other collection members', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/assets/collection/view');
  await expect(page.locator('video')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'シリーズページ操作' }),
  ).toHaveCount(0);
  await page.locator('video').dispatchEvent('ended');
  const navigation = page.getByRole('navigation', {
    name: 'シリーズページ操作',
  });
  await expect(navigation).toContainText('1 / 2 ページ');
  await expect(
    navigation.getByRole('button', { name: '前のシリーズページ' }),
  ).toBeDisabled();
  await navigation.getByRole('button', { name: '次のシリーズページ' }).click();
  await expect(navigation).toContainText('2 / 2 ページ');
  await page.keyboard.press('ArrowLeft');
  await expect(navigation).toContainText('1 / 2 ページ');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('video')).toBeVisible();
  await expect(navigation).toHaveCount(0);
});
