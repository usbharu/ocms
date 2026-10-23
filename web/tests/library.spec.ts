import { expect, type Page, test } from '@playwright/test';

// Synthetic data only. These tests verify UI behavior and API contracts, not the services.
const fixtures = [
  {
    asset_id: 'image',
    filename: '山の風景.png',
    mime_type: 'image/png',
    tags: ['旅行', '風景'],
    status: 'ready',
  },
  {
    asset_id: 'video',
    filename: '散歩の記録.mp4',
    mime_type: 'video/mp4',
    tags: ['旅行'],
    status: 'processing',
  },
  {
    asset_id: 'audio',
    filename: 'インタビュー.ogg',
    mime_type: 'audio/ogg',
    tags: [],
    status: 'stored',
  },
  {
    asset_id: 'pdf',
    filename: '展示会ガイド.pdf',
    mime_type: 'application/pdf',
    tags: ['資料'],
    status: 'failed',
  },
];
const preview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#dce9e5"/><circle cx="470" cy="100" r="38" fill="#f6e6b9"/><path d="M0 310 210 80 430 350 530 200 640 320V400H0Z" fill="#86a594"/><path d="m130 168 80-88 73 90-70-22Z" fill="#f4f7f4"/><path d="M0 340 170 250 330 350 510 290 640 350V400H0Z" fill="#527d67"/></svg>';

async function mockAPI(page: Page) {
  let assets = structuredClone(fixtures);
  await page.route('**/auth/config', (route) =>
    route.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === '/api/v1/uploads')
      return route.fulfill({
        json: { upload_id: 'upload-1', asset_id: 'new-image' },
      });
    if (path === '/api/v1/uploads/upload-1/content') {
      assets.push({
        ...fixtures[0],
        asset_id: 'new-image',
        filename: '追加画像.png',
      });
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/v1/me')
      return route.fulfill({
        json: { principal_id: 'demo', csrf_token: 'test-csrf' },
      });
    if (path === '/api/v1/assets') return route.fulfill({ json: { assets } });
    if (path === '/api/v1/search') {
      const { query } = route.request().postDataJSON();
      if (query === 'empty') return route.fulfill({ json: { assets: [] } });
      if (query === 'error')
        return route.fulfill({
          status: 503,
          json: { error: '検索できません。再度お試しください。' },
        });
      return route.fulfill({
        json: {
          assets: [
            {
              ...assets.find(
                (a) => a.asset_id === (query === 'pdf' ? 'pdf' : 'video'),
              ),
              snippet: '検索の一致箇所',
              ...(query === 'pdf'
                ? { page_number: 2 }
                : { start_ms: 65000, end_ms: 70000 }),
            },
          ],
        },
      });
    }
    if (/\/(similar|duplicates)$/.test(path))
      return route.fulfill({ json: { assets: [assets[0]] } });
    if (path.endsWith('/renditions') && method === 'POST')
      return route.fulfill({ json: {} });
    if (path.endsWith('/renditions'))
      return route.fulfill({
        json: {
          renditions: path.includes('/pdf/')
            ? [
                {
                  rendition_id: 'page-1',
                  profile_id: 'pdf.page-1-v1',
                  mime_type: 'image/png',
                },
                {
                  rendition_id: 'page-2',
                  profile_id: 'pdf.page-2-v1',
                  mime_type: 'image/png',
                },
              ]
            : path.includes('/video/')
              ? [
                  {
                    rendition_id: 'mp4',
                    profile_id: 'video.mp4-v1',
                    mime_type: 'video/mp4',
                  },
                ]
              : [],
        },
      });
    if (path.endsWith('/jobs'))
      return route.fulfill({
        json: {
          jobs: [
            {
              job_id: 'job-1',
              job_type: 'media.process',
              status: 'failed',
              attempts: 2,
              error_code: 'TRANSCODE_FAILED',
            },
          ],
        },
      });
    if (path.endsWith('/content') || path.endsWith('/preview'))
      return route.fulfill({ contentType: 'image/svg+xml', body: preview });
    const id = path.split('/').at(-1);
    if (method === 'PATCH') {
      assets = assets.map((a) =>
        a.asset_id === id
          ? { ...a, tags: route.request().postDataJSON().tags }
          : a,
      );
    }
    if (method === 'DELETE') {
      assets = assets.filter((a) => a.asset_id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: assets.find((a) => a.asset_id === id) });
  });
}

test.beforeEach(async ({ page }) => {
  await mockAPI(page);
  await page.goto('/');
});

test('filters the current list and closes details', async ({ page }) => {
  await expect(page.locator('.file')).toHaveCount(4);
  await page.getByRole('button', { name: '画像', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(1);
  await expect(page.locator('.result-heading')).toContainText('1 件 / 4 件');
  await page.locator('.file').click();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toBeVisible();
  await expect(
    page.getByText('プレビュー・文字抽出', { exact: true }),
  ).toBeHidden();
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  await expect(page.getByRole('region', { name: 'ファイル詳細' })).toHaveCount(
    0,
  );
});

test('search modes use text API; tag editing preserves the match time', async ({
  page,
}) => {
  for (const mode of ['keyword', 'semantic', 'hybrid']) {
    await page.getByLabel('検索方法').selectOption(mode);
    await page.getByLabel('検索クエリ').fill('sample');
    const search = page.waitForRequest((r) => r.url().endsWith('/search'));
    await page.getByRole('button', { name: '検索', exact: true }).click();
    expect((await search).postDataJSON()).toEqual({
      query: 'sample',
      mode,
      limit: 200,
    });
    await expect(page.locator('.file')).toHaveCount(1);
  }
  await page.locator('.file').click();
  await expect(page.locator('video')).toHaveAttribute(
    'src',
    '/api/v1/assets/video/renditions/mp4/content#t=65',
  );
  await page.getByLabel('タグ', { exact: true }).fill('新しいタグ, 旅行');
  const save = page.waitForRequest((r) => r.method() === 'PATCH');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await save).postDataJSON()).toEqual({ tags: ['新しいタグ', '旅行'] });
  await expect(page.getByRole('status')).toContainText('タグを保存しました');
  await expect(page.locator('video')).toHaveAttribute('src', /#t=65$/);
  await page.getByRole('button', { name: '検索を解除' }).click();
  await expect(page.locator('.file')).toHaveCount(4);
});

test('comparison actions stay attached to the selected source', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  for (const [label, endpoint] of [
    ['類似ファイル', 'similar'],
    ['完全一致ファイル', 'duplicates'],
  ]) {
    const comparison = page.waitForRequest((r) =>
      r.url().endsWith(`/image/${endpoint}`),
    );
    await page.getByRole('button', { name: label, exact: true }).click();
    await comparison;
    await expect(
      page.getByRole('heading', { name: `${label}：山の風景.png` }),
    ).toBeVisible();
    await expect(page.getByLabel('検索クエリ')).toBeEnabled();
  }
  await page.getByRole('button', { name: '検索を解除' }).click();
  await expect(page.locator('.file')).toHaveCount(4);
});

test('PDF results preview the matching page and expose retry under processing', async ({
  page,
}) => {
  await page.getByLabel('検索クエリ').fill('pdf');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('.file').filter({ hasText: '2 ページ' }).click();
  await expect(page.getByAltText('PDF 2ページ目')).toHaveAttribute(
    'src',
    '/api/v1/assets/pdf/renditions/page-2/content',
  );
  await expect(
    page.getByRole('link', { name: '元ファイルを開く' }),
  ).toHaveAttribute('href', '/api/v1/assets/pdf/content#page=2');
  await page.getByText('処理状況', { exact: false }).click();
  await expect(
    page.getByText('TRANSCODE_FAILED', { exact: false }),
  ).toBeVisible();
  const retry = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/pdf/renditions'),
  );
  await page.getByRole('button', { name: '再試行', exact: true }).click();
  await retry;
  await expect(page.getByRole('status')).toContainText(
    '処理をリクエストしました',
  );
});

test('empty results and errors retain a way back', async ({ page }) => {
  await page.getByLabel('検索クエリ').fill('empty');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '検索結果がありません' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'すべてのファイル', exact: true })
    .click();
  await expect(page.locator('.file')).toHaveCount(4);
  await page.getByLabel('検索クエリ').fill('error');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('検索できません');
  await expect(page.locator('.file')).toHaveCount(4);
});

test('deletes only after confirmation', async ({ page }) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'ファイルを削除' }).click();
  await expect(page.locator('.file')).toHaveCount(4);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'ファイルを削除' }).click();
  await expect(page.locator('.file')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'ファイル詳細' })).toHaveCount(
    0,
  );
});

test('desktop and narrow layouts fit without horizontal scrolling', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  await expect(page.locator('.preview img')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/library-ia.png', fullPage: true });
  for (const width of [1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole('button', { name: '類似ファイル', exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({
      path: '../docs/library-ia-mobile.png',
      fullPage: true,
    });
});

test('upload resets filters and opens the uploaded file', async ({ page }) => {
  await page.getByRole('button', { name: '音声', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(1);
  const content = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().endsWith('/upload-1/content'),
  );
  await page.getByLabel('アップロードするファイル').setInputFiles({
    name: '追加画像.png',
    mimeType: 'image/png',
    buffer: Buffer.from('test image'),
  });
  expect((await content).headers()['x-csrf-token']).toBe('test-csrf');
  await expect(
    page
      .getByRole('region', { name: 'ファイル詳細' })
      .getByRole('heading', { name: '追加画像.png' }),
  ).toBeVisible();
  await expect(page.locator('.file')).toHaveCount(5);
  await expect(
    page.getByRole('button', { name: 'すべて', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('login offers only the configured authentication method', async ({
  page,
}) => {
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401 }));
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'ライブラリにログイン' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'alice でログイン' }),
  ).toBeVisible();
  await expect(page.getByRole('search')).toHaveCount(0);
  await page.route('**/auth/config', (route) =>
    route.fulfill({ json: { development: false } }),
  );
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'SSOでログイン' }),
  ).toHaveAttribute('href', '/auth/login');
  await expect(
    page.getByRole('button', { name: 'alice でログイン' }),
  ).toHaveCount(0);
});

test('narrow layout moves focus into details and returns it on close', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const file = page.locator('.file').filter({ hasText: '山の風景.png' });
  await file.click();
  await expect(
    page
      .getByRole('region', { name: 'ファイル詳細' })
      .getByRole('heading', { level: 2 }),
  ).toBeFocused();
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  await expect(file).toBeFocused();
});

test('view menu follows refresh and list rows use authenticated thumbnails', async ({
  page,
}) => {
  await expect(page.getByLabel('表示方法')).toHaveValue('list');
  const refresh = await page
    .getByRole('button', { name: '更新', exact: true })
    .boundingBox();
  const menu = await page.getByLabel('表示方法').boundingBox();
  if (!refresh || !menu) throw new Error('View controls must be visible');
  expect(menu.x).toBeGreaterThan(refresh.x + refresh.width);
  await expect(page.getByLabel('表示方法').locator('option')).toHaveText([
    'リスト表示',
    'グリッド表示',
    '詳細グリッド表示',
  ]);
  const image = page.getByRole('button', { name: '山の風景.png', exact: true });
  await expect(image.locator('.thumbnail img')).toHaveAttribute(
    'src',
    '/api/v1/assets/image/preview',
  );
  await expect(image.locator('.thumbnail img')).toHaveJSProperty(
    'naturalWidth',
    640,
  );
  await expect(
    page
      .getByRole('button', { name: '散歩の記録.mp4', exact: true })
      .locator('.thumbnail img'),
  ).toHaveAttribute('src', '/api/v1/assets/video/preview');
  await expect(
    page
      .getByRole('button', { name: '展示会ガイド.pdf', exact: true })
      .locator('.thumbnail img'),
  ).toHaveAttribute('src', '/api/v1/assets/pdf/preview');
  await expect(
    page
      .getByRole('button', { name: 'インタビュー.ogg', exact: true })
      .locator('.thumbnail-placeholder'),
  ).toHaveText('音声');
  await expect(page.locator('.file-icon')).toHaveCount(0);
});

test('square grids show only thumbnails or a contained thumbnail with title', async ({
  page,
}) => {
  // Portrait and landscape sources catch accidental image stretching.
  await page.route('**/api/v1/assets/pdf/preview', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#dbe3ed"/><rect x="30" y="50" width="240" height="10" fill="#6f849a"/></svg>',
    }),
  );
  await page.reload();
  for (const view of ['grid', 'detailed-grid']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('表示方法').selectOption(view);
    const image = page.getByRole('button', {
      name: '山の風景.png',
      exact: true,
    });
    expect(
      await image
        .locator('.file-info')
        .evaluate((el) => el.classList.contains('visually-hidden')),
    ).toBe(view === 'grid');
    await expect(
      page.locator('.file .status, .file .file-meta, .list-header'),
    ).toHaveCount(0);
    await expect(image.locator('.thumbnail img')).toHaveCSS(
      'object-fit',
      view === 'grid' ? 'cover' : 'contain',
    );
    for (const width of [1440, 1024, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const card of await page.locator('.file').all()) {
        const box = await card.boundingBox();
        if (!box) throw new Error('File card must be visible');
        expect(Math.abs(box.width - box.height)).toBeLessThan(1);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      page
        .getByRole('button', { name: '展示会ガイド.pdf', exact: true })
        .locator('.thumbnail img'),
    ).toHaveJSProperty('naturalHeight', 600);
    if (process.env.UI_SCREENSHOTS) {
      await page.screenshot({
        path: `../docs/library-${view}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: `../docs/library-${view}-mobile.png`,
        fullPage: true,
      });
    }
  }
});

test('switching view preserves selection, filtering and comparison context', async ({
  page,
}) => {
  await page.getByRole('button', { name: '画像', exact: true }).click();
  await page.getByRole('button', { name: '山の風景.png', exact: true }).click();
  for (const view of ['grid', 'detailed-grid', 'list']) {
    await page.getByLabel('表示方法').selectOption(view);
    await expect(page.locator('.file')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: '山の風景.png', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('region', { name: 'ファイル詳細' }),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: '類似ファイル', exact: true }).click();
  await page.getByLabel('表示方法').selectOption('grid');
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '類似ファイル：山の風景.png' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '検索を解除' }).click();
  await expect(page.getByLabel('表示方法')).toHaveValue('grid');
  await expect(page.locator('.file')).toHaveCount(4);
  await page
    .getByRole('button', { name: '展示会ガイド.pdf', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'ファイル詳細' })
      .getByRole('heading', { level: 2 }),
  ).toHaveText('展示会ガイド.pdf');
  for (const view of ['grid', 'detailed-grid']) {
    await page.getByLabel('表示方法').selectOption(view);
    for (const width of [1440, 1024, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const box = await page.locator('.file').first().boundingBox();
      if (!box) throw new Error('File card must be visible');
      expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    }
  }
});

test('missing thumbnails fall back and retry when processing status changes', async ({
  page,
}) => {
  let ready = false;
  let previews = 0;
  await page.route('**/api/v1/assets', (route) =>
    route.fulfill({
      json: {
        assets: [{ ...fixtures[0], status: ready ? 'ready' : 'processing' }],
      },
    }),
  );
  await page.route('**/api/v1/assets/image/preview', (route) => {
    previews++;
    return route.fulfill(
      ready ? { contentType: 'image/svg+xml', body: preview } : { status: 404 },
    );
  });
  await page.reload();
  await expect(page.locator('.thumbnail-placeholder')).toHaveText('準備中');
  await page.getByLabel('表示方法').selectOption('grid');
  await expect(page.locator('.thumbnail-placeholder')).toHaveText('準備中');
  ready = true;
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.locator('.thumbnail img')).toHaveJSProperty(
    'naturalWidth',
    640,
  );
  expect(previews).toBe(2);
});

test('PDF search thumbnails use the matched page in every view', async ({
  page,
}) => {
  await page.getByLabel('検索クエリ').fill('pdf');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(1);
  for (const view of ['list', 'grid', 'detailed-grid']) {
    await page.getByLabel('表示方法').selectOption(view);
    await expect(page.locator('.file .thumbnail img')).toHaveAttribute(
      'src',
      '/api/v1/assets/pdf/preview?page=2',
    );
  }
});
