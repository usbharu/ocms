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

async function setup(page: Page, failure = false) {
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
    if (path === '/api/v1/series')
      return route.fulfill({ json: { assets: [collection], total: 1 } });
    if (path === '/api/v1/series/comic') return route.fulfill({ json: saved });
    if (path === '/api/v1/series/collection')
      return route.fulfill({ json: collection });
    if (path === '/api/v1/assets')
      return route.fulfill({
        json: { assets: grouped ? [saved] : [a, b], total: grouped ? 1 : 2 },
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
  await expect(page).toHaveURL(/\/series\/comic$/);
  expect(saves[0]).toMatchObject({
    name: '漫画まとめ',
    kind: 'composite',
    member_ids: ['page-b', 'page-a'],
  });
  await page.getByRole('link', { name: '順番に見る' }).click();
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
  await expect(page).toHaveURL(/\/series\/collection$/);
  await page.goBack();
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
  await expect(page).toHaveURL(/series\/comic$/);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/series\/comic/);
  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('.file')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: '漫画まとめ', exact: true }),
  ).toBeVisible();
});
