import { expect, type Page, test } from '@playwright/test';

const source = {
  asset_id: 'source',
  filename: '比較元.png',
  mime_type: 'image/png',
  tags: ['風景'],
  characters: ['キャラクターA'],
  status: 'ready',
};
const recommendations = Array.from({ length: 27 }, (_, i) => ({
  ...source,
  asset_id: `related-${i}`,
  filename: `関連ファイル${i}.png`,
  score: 96.25 - i,
  common_tags: ['風景'],
  common_characters: ['キャラクターA'],
  perceptual: 'visual',
  page_number: 7,
}));
const preview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#dce9e5"/><path d="M0 400 210 80 440 400Z" fill="#527d67"/></svg>';

async function setup(
  page: Page,
  state: {
    failure?: boolean;
    empty?: boolean;
    pending?: boolean;
    delay?: boolean;
  } = {},
) {
  await page.route('**/auth/config', (r) =>
    r.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/me'))
      return route.fulfill({ json: { principal_id: 'demo' } });
    if (path.endsWith('/recommendations')) {
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, 500));
      if (state.failure)
        return route.fulfill({
          status: 503,
          json: { error: 'SERVICE_UNAVAILABLE' },
        });
      return route.fulfill({
        json: {
          source_asset_id: path.split('/')[4],
          hash_status: state.pending ? 'pending' : 'ready',
          assets: state.empty ? [] : recommendations,
        },
      });
    }
    if (path.endsWith('/preview') || path.endsWith('/content'))
      return route.fulfill({ contentType: 'image/svg+xml', body: preview });
    if (path.endsWith('/renditions'))
      return route.fulfill({ json: { renditions: [] } });
    if (path.endsWith('/jobs')) return route.fulfill({ json: { jobs: [] } });
    if (path === '/api/v1/assets')
      return route.fulfill({ json: { assets: [source], total: 1 } });
    return route.fulfill({
      json:
        recommendations.find((a) => path.endsWith(`/${a.asset_id}`)) ?? source,
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: source.filename, exact: true })
    .click();
}

async function open(page: Page) {
  await page
    .getByRole('button', { name: '関連コンテンツ', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '関連コンテンツ', exact: true }),
  ).toBeVisible();
}

test('ranking, keyboard selection, pagination, chained exploration and restoration', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('searchbox').fill('未送信の条件');
  await open(page);
  await expect(page.locator('.file')).toHaveCount(24);
  await expect(page.locator('.file').first()).toHaveAttribute(
    'aria-label',
    '関連ファイル0.png',
  );
  await expect(page.getByText('評価 96.3')).toBeVisible();
  await expect(page.locator('.file').first()).toContainText(
    '共通キャラクター：キャラクターA',
  );
  await expect(page.locator('.file').first()).toContainText('共通タグ：風景');
  await expect(page.locator('.file').first()).toContainText('見た目が近い');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page
    .getByRole('button', { name: '関連ファイル24.png', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await open(page);
  await expect(page.locator('.recommendation-source')).toHaveText(
    '関連ファイル24.png',
  );
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '関連ファイル24.png', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('未送信の条件');
  await expect(
    page.getByRole('heading', { name: source.filename, exact: true }),
  ).toBeVisible();
});

test('viewer order across pages and kind filter', async ({ page }) => {
  await setup(page);
  await open(page);
  await page
    .getByRole('combobox', { name: '関連コンテンツの種類' })
    .selectOption('audio');
  await expect(page.getByText('関連コンテンツがありません。')).toBeVisible();
  await page
    .getByRole('combobox', { name: '関連コンテンツの種類' })
    .selectOption('image');
  await page
    .getByRole('button', { name: '関連ファイル23.png', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'ファイルを閲覧', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog')).toContainText('関連ファイル24.png');
  await page.keyboard.press('Escape');
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
});

test('loading, pending hash, failure retry and empty state', async ({
  page,
}) => {
  const state = { failure: true, empty: false, pending: true, delay: true };
  await setup(page, state);
  await open(page);
  await expect(
    page.getByRole('heading', { name: '読み込み中…' }),
  ).toBeVisible();
  await expect(
    page.getByText('関連コンテンツを取得できません。'),
  ).toBeVisible();
  state.failure = false;
  await page.getByRole('button', { name: '再試行', exact: true }).click();
  await expect(page.getByText('類似解析待ち')).toBeVisible();
  await expect(page.locator('.file')).toHaveCount(24);
  state.empty = true;
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByText('関連コンテンツがありません。')).toBeVisible();
});

test('back while loading discards stale response', async ({ page }) => {
  await setup(page, { delay: true });
  await open(page);
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await page.waitForTimeout(600);
  await expect(
    page.getByRole('heading', { name: 'すべてのファイル' }),
  ).toBeVisible();
  await expect(page.locator('.file')).toHaveCount(1);
});

test('responsive cards and details', async ({ page }) => {
  await setup(page);
  await open(page);
  for (const width of [1440, 1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByText('評価 96.3')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({
      path: '../docs/recommendations.png',
      fullPage: true,
    });
  await page
    .getByRole('button', { name: '関連ファイル0.png', exact: true })
    .click();
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole('button', { name: '関連コンテンツ', exact: true }),
    ).toBeVisible();
  }
});
