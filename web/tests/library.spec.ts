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
        a.asset_id === id ? { ...a, ...route.request().postDataJSON() } : a,
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

test('shows WD14 tagging as a separate job', async ({ page }) => {
  await page.route('**/api/v1/assets/image/jobs', (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            job_id: 'tags-1',
            job_type: 'tags.generate',
            status: 'completed',
            attempts: 1,
          },
        ],
      },
    }),
  );
  await page
    .getByRole('button', { name: fixtures[0].filename, exact: true })
    .click();
  await page.getByText('処理状況', { exact: false }).click();
  await expect(page.getByText('自動タグ付け', { exact: true })).toBeVisible();
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/wd14-tagging.png', fullPage: true });
});

test('remembers each library view after reload and opening a new tab', async ({
  page,
  context,
}) => {
  for (const view of ['grid', 'detailed-grid', 'list']) {
    await page.getByLabel('表示方法').selectOption(view);
    await page.reload();
    await expect(page.getByLabel('表示方法')).toHaveValue(view);
    await expect(page.locator(`.view-${view} .file`)).toHaveCount(4);
    const nextPage = await context.newPage();
    await mockAPI(nextPage);
    await nextPage.goto('/');
    await expect(nextPage.getByLabel('表示方法')).toHaveValue(view);
    await nextPage.close();
  }
});

test('uses the list view when the saved preference is invalid', async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem('ocms.library.view', 'unknown'),
  );
  await page.reload();
  await expect(page.getByLabel('表示方法')).toHaveValue('list');
  await expect(page.locator('.view-list .file')).toHaveCount(4);
});

test('allows view changes when browser storage is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    });
  });
  await page.reload();
  await expect(page.getByLabel('表示方法')).toHaveValue('list');
  await page.getByLabel('表示方法').selectOption('grid');
  await expect(page.locator('.view-grid .file')).toHaveCount(4);
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
  await page.getByLabel('タグ', { exact: true }).fill('新しいタグ');
  const save = page.waitForRequest((r) => r.method() === 'PATCH');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  expect((await save).postDataJSON()).toEqual({ tags: ['旅行', '新しいタグ'] });
  await expect(page.getByRole('status')).toContainText('保存しました');
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
  await expect(
    page.getByRole('heading', { name: 'ライブラリ', exact: true }),
  ).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page
    .locator('.app-header')
    .getByRole('button', { name: '＋ アップロード', exact: true })
    .click();
  expect((await chooser).isMultiple()).toBe(true);
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
  const ssoLogin = page.getByRole('link', { name: 'SSOでログイン' });
  await expect(ssoLogin).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(ssoLogin).toHaveCSS('background-color', 'rgb(21, 128, 61)');
  await ssoLogin.hover();
  await expect(ssoLogin).toHaveCSS('color', 'rgb(255, 255, 255)');
  await ssoLogin.focus();
  await expect(ssoLogin).toBeFocused();
  await expect(ssoLogin).toHaveCSS('color', 'rgb(255, 255, 255)');
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/login-sso.png', fullPage: true });
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
  await page.route('**/api/v1/assets?**', (route) =>
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

// Track the library layout across views and responsive breakpoints.
test('library wireframe retains its geometry across views and breakpoints', async ({
  page,
}) => {
  const geometry: string[] = [];
  for (const width of [1440, 1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .getByRole('button', { name: '山の風景.png', exact: true })
      .click();
    await expect(page.locator('.preview img')).toHaveJSProperty(
      'naturalWidth',
      640,
    );
    for (const view of ['list', 'grid', 'detailed-grid']) {
      await page.getByLabel('表示方法').selectOption(view);
      for (const selector of [
        '.app-header',
        '.search',
        '.library-toolbar',
        '.files',
        '.details',
      ]) {
        const box = await page.locator(selector).boundingBox();
        if (!box) throw new Error(`${selector} must be visible`);
        geometry.push(
          `${width} ${view} ${selector}: ${[box.x, box.y, box.width, box.height].map(Math.round).join(',')}`,
        );
      }
    }
    await page.getByRole('button', { name: '詳細を閉じる' }).click();
  }
  expect(geometry.join('\n')).toMatchSnapshot('library-wireframe.txt');
});

test('upload progress exposes its value and disables duplicate uploads', async ({
  page,
}) => {
  let finishUpload: () => void = () => {};
  const pendingUpload = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  await page.route('**/api/v1/uploads/upload-1/content', async (route) => {
    await pendingUpload;
    await route.fallback();
  });
  try {
    await page.getByLabel('アップロードするファイル').setInputFiles({
      name: '追加画像.png',
      mimeType: 'image/png',
      buffer: Buffer.from('test image'),
    });
    const progress = page.getByRole('progressbar', {
      name: 'アップロード進捗',
    });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuemax', '100');
    await expect(progress).toHaveAttribute('aria-valuenow', /^(100|\d{1,2})$/);
    await expect(progress).toHaveCSS('height', '6px');
    await expect(
      page.getByRole('button', { name: '＋ アップロード', exact: true }),
    ).toBeDisabled();
  } finally {
    finishUpload();
  }
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.file')).toHaveCount(5);
});

async function mockPaginatedLibrary(page: Page, count = 217) {
  let assets = Array.from({ length: count }, (_, i) => ({
    ...fixtures[i % 4],
    asset_id: `item-${i}`,
    filename: `ファイル ${i + 1}`,
  }));
  await page.route('**/api/v1/assets?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const kind = params.get('kind');
    const filtered = assets.filter(
      (a) =>
        !kind ||
        (kind === 'document'
          ? !/^(image|video|audio)\//.test(a.mime_type)
          : a.mime_type.startsWith(`${kind}/`)),
    );
    const offset = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    return route.fulfill({
      json: {
        assets: filtered.slice(offset, offset + limit),
        total: filtered.length,
      },
    });
  });
  await page.route('**/api/v1/assets/item-*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    if (route.request().method() === 'DELETE') {
      assets = assets.filter((a) => a.asset_id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: assets.find((a) => a.asset_id === id) });
  });
  await page.goto('/');
}

test('paginates beyond 200 files, preserves selection and resets filters', async ({
  page,
}) => {
  await mockPaginatedLibrary(page);
  const nav = page.getByRole('navigation', { name: 'ページネーション' });
  await expect(page.locator('.file')).toHaveCount(24);
  await expect(nav).toContainText('1–24 / 217 件');
  await expect(nav.getByRole('button', { name: '前へ' })).toBeDisabled();
  await page.getByRole('button', { name: 'ファイル 1', exact: true }).click();
  await nav.getByRole('button', { name: '次へ' }).click();
  await expect(nav).toContainText('25–48 / 217 件');
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText('ファイル 1');
  await page.getByLabel('表示方法').selectOption('detailed-grid');
  for (let i = 2; i < 10; i++) {
    await nav.getByRole('button', { name: '次へ' }).click();
    await expect(nav).toContainText(`${i + 1} / 10 ページ`);
  }
  await expect(page.locator('.file')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'ファイル 217', exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole('button', { name: '次へ' })).toBeDisabled();
  await page.getByRole('button', { name: '画像', exact: true }).click();
  await expect(nav).toContainText('1–24 / 55 件');
});

test('deleting the last file on the last page returns to an existing page', async ({
  page,
}) => {
  await mockPaginatedLibrary(page, 25);
  const nav = page.getByRole('navigation', { name: 'ページネーション' });
  await nav.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('button', { name: 'ファイル 25', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'ファイルを削除' }).click();
  await expect(page.locator('.file')).toHaveCount(24);
  await expect(nav).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'ファイル 1', exact: true }),
  ).toBeVisible();
});

test('search and comparison results paginate and filters reset the page', async ({
  page,
}) => {
  const results = Array.from({ length: 49 }, (_, i) => ({
    ...fixtures[i % 4],
    asset_id: `result-${i}`,
    filename: `結果 ${i + 1}`,
    page_number: 2,
  }));
  await page.route('**/api/v1/search', (route) =>
    route.fulfill({ json: { assets: results } }),
  );
  await page.route('**/api/v1/assets/*/duplicates', (route) =>
    route.fulfill({ json: { assets: results } }),
  );
  await page.getByRole('searchbox').fill('pdf');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'ページネーション' });
  await expect(nav).toContainText('1–24 / 49 件');
  await nav.getByRole('button', { name: '次へ' }).click();
  await expect(
    page.getByRole('button', { name: '結果 25', exact: true }),
  ).toBeVisible();
  await nav.getByRole('button', { name: '前へ' }).click();
  await expect(nav).toContainText('1–24 / 49 件');
  await nav.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('button', { name: '画像', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(13);
  await page.getByRole('button', { name: '結果 1', exact: true }).click();
  await page
    .getByRole('button', { name: '完全一致ファイル', exact: true })
    .click();
  await expect(nav).toContainText('1–24 / 49 件');
  await nav.getByRole('button', { name: '次へ' }).click();
  await expect(nav).toContainText('25–48 / 49 件');
});

test('desktop details stay in the viewport and scroll independently', async ({
  page,
}) => {
  await mockPaginatedLibrary(page, 49);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.getByRole('button', { name: 'ファイル 1', exact: true }).click();
  const details = page.getByRole('region', { name: 'ファイル詳細' });
  await details.locator('summary').first().click();
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(async () => (await details.boundingBox())?.y).toBe(16);
  const box = await details.boundingBox();
  expect(box && box.y + box.height).toBeLessThanOrEqual(684);
  await details.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(
    details.getByRole('button', { name: 'ファイルを削除' }),
  ).toBeVisible();
  expect(await details.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  if (process.env.UI_SCREENSHOTS) {
    await details.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page
      .getByRole('navigation', { name: 'ページネーション' })
      .scrollIntoViewIfNeeded();
    await expect.poll(async () => (await details.boundingBox())?.y).toBe(16);
    await page.screenshot({ path: '../docs/library-pagination.png' });
  }
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect.poll(async () => (await details.boundingBox())?.y).toBe(16);
  for (const width of [800, 390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(details).toHaveCSS('position', 'static');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

// Generated two-page PDF, with real PDF parsing and rendering (no private media).
function viewerPDF() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    ...[1, 2].map((page) => {
      const stream = `0.2 0.5 0.3 rg 40 40 520 600 re f BT /F1 32 Tf 40 700 Td (Page ${page}) Tj ET\n`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  return Buffer.from(
    `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

async function swipeViewer(page: Page, direction: number) {
  const bounds = await page.locator('.viewer-stage').boundingBox();
  if (!bounds) throw new Error('Viewer stage missing');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + direction * 120, y, { steps: 8 });
  await page.mouse.up();
}

test('viewer opens from preview, repeated selection and double click in all views', async ({
  page,
}) => {
  const viewer = page.getByRole('dialog', { name: 'ファイル閲覧' });
  const image = page.getByRole('button', {
    name: fixtures[0].filename,
    exact: true,
  });
  await image.click();
  await expect(viewer).not.toBeVisible();
  await page
    .getByRole('button', { name: 'ファイルを閲覧', exact: true })
    .click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img')).toHaveAttribute(
    'src',
    '/api/v1/assets/image/content',
  );
  expect(await viewer.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 1440,
    height: 1000,
  });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'ファイルを閲覧', exact: true }),
  ).toBeFocused();
  await image.click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: '閲覧を閉じる' }).click();
  for (const view of ['grid', 'detailed-grid', 'list']) {
    await page.getByLabel('表示方法').selectOption(view);
    await page
      .getByRole('button', { name: fixtures[1].filename, exact: true })
      .dblclick();
    await expect(
      viewer.getByRole('heading', { name: fixtures[1].filename }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await image.click();
  }
});

test('image zoom pans without changing files; reset restores swipe and focus stays in cover', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: fixtures[0].filename, exact: true })
    .dblclick();
  const viewer = page.getByRole('dialog');
  await expect(
    viewer.getByRole('button', { name: '前のファイル' }),
  ).toBeDisabled();
  await viewer.getByRole('button', { name: '拡大', exact: true }).click();
  await expect(
    viewer.getByRole('button', { name: '画面に合わせる' }),
  ).toHaveText('125%');
  await swipeViewer(page, -1);
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[0].filename);
  await expect(viewer.locator('.viewer-content')).toHaveAttribute(
    'style',
    /translate\(-120px/,
  );
  await viewer.getByRole('button', { name: '画面に合わせる' }).click();
  await swipeViewer(page, -1);
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[1].filename);
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[0].filename);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('.asset-viewer')),
      ),
    ).toBe(true);
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      viewer.getByRole('button', { name: '閲覧を閉じる' }),
    ).toBeInViewport();
    await expect(
      viewer.getByRole('button', { name: '拡大', exact: true }),
    ).toBeInViewport();
    expect((await viewer.boundingBox())?.width).toBe(width);
  }
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/library-viewer-mobile.png' });
});

test('PDF renders real pages under the BFF CSP, zooms and navigates files', async ({
  page,
}) => {
  await page.route('**/api/v1/assets/pdf/content', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: viewerPDF() }),
  );
  await page.route('http://127.0.0.1:4173/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self' blob:; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
      },
    });
  });
  await page.reload();
  await page.getByLabel('検索クエリ').fill('pdf');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page
    .getByRole('button', { name: fixtures[3].filename, exact: true })
    .dblclick();
  const viewer = page.getByRole('dialog');
  await expect(
    viewer.getByRole('img', { name: 'PDF 2ページ目' }),
  ).toBeVisible();
  await expect(
    viewer.getByRole('navigation', { name: 'PDFページ操作' }),
  ).toContainText('2 / 2 ページ');
  await expect(
    viewer.getByRole('button', { name: '次のPDFページ' }),
  ).toBeDisabled();
  await viewer.getByRole('button', { name: '前のPDFページ' }).click();
  await expect(
    viewer.getByRole('img', { name: 'PDF 1ページ目' }),
  ).toBeVisible();
  await viewer.getByRole('button', { name: '拡大', exact: true }).click();
  await expect(viewer.getByRole('img')).toHaveAttribute(
    'style',
    /scale\(1.25\)/,
  );
  await expect(
    viewer.getByRole('button', { name: '次のPDFページ' }),
  ).toBeInViewport();
  expect(
    await viewer
      .locator('canvas')
      .evaluate(
        (canvas: HTMLCanvasElement) =>
          canvas.getContext('2d')?.getImageData(100, 100, 1, 1).data[3],
      ),
  ).toBe(255);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/library-viewer-pdf.png' });
  await page.keyboard.press('Escape');
});

test('viewer crosses API page boundaries and keeps the displayed page on return', async ({
  page,
}) => {
  await mockPaginatedLibrary(page, 25);
  let failNextPage = true;
  await page.route('**/api/v1/assets?**', (route) => {
    if (
      new URL(route.request().url()).searchParams.get('offset') === '24' &&
      failNextPage
    ) {
      failNextPage = false;
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    }
    return route.fallback();
  });
  await page
    .getByRole('button', { name: 'ファイル 24', exact: true })
    .dblclick();
  const viewer = page.getByRole('dialog');
  await viewer.getByRole('button', { name: '次のファイル' }).click();
  await expect(
    viewer
      .getByRole('alert')
      .filter({ hasText: '次のファイルを読み込めません' }),
  ).toBeVisible();
  await expect(viewer.getByRole('heading')).toHaveText('ファイル 24');
  await viewer.getByRole('button', { name: '次のファイル' }).click();
  await expect(viewer.getByRole('heading')).toHaveText('ファイル 25');
  await expect(
    viewer.getByRole('button', { name: '次のファイル' }),
  ).toBeDisabled();
  await swipeViewer(page, 1);
  await expect(viewer.getByRole('heading')).toHaveText('ファイル 24');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('navigation', { name: 'ページネーション' }),
  ).toContainText('1–24 / 25 件');
});

test('unsupported and broken files retain navigation and original links', async ({
  page,
}) => {
  await page.route('**/api/v1/assets/image/content', (route) =>
    route.fulfill({ status: 403 }),
  );
  await page
    .getByRole('button', { name: fixtures[0].filename, exact: true })
    .dblclick();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByRole('alert')).toContainText('画像を表示できません');
  await expect(
    viewer.getByRole('link', { name: '元ファイル' }),
  ).toHaveAttribute('href', '/api/v1/assets/image/content');
  await swipeViewer(page, -1);
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[1].filename);
  await page.keyboard.press('Escape');
  const unsupported = {
    ...fixtures[0],
    asset_id: 'other',
    filename: 'notes.txt',
    mime_type: 'text/plain',
  };
  await page.route('**/api/v1/assets?**', (route) =>
    route.fulfill({ json: { assets: [unsupported] } }),
  );
  await page.route('**/api/v1/assets/other', (route) =>
    route.fulfill({ json: unsupported }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'notes.txt', exact: true }).dblclick();
  await expect(viewer).toContainText('この形式はプレビューに対応していません');
  await expect(
    viewer.getByRole('link', { name: '元ファイル' }),
  ).toHaveAttribute('href', '/api/v1/assets/other/content');
});

test('pinch zoom does not accidentally navigate, then a touch swipe changes files', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: fixtures[0].filename, exact: true })
    .click();
  await page
    .getByRole('button', { name: 'ファイルを閲覧', exact: true })
    .click();
  const viewer = page.getByRole('dialog');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 150, y: 300, id: 1 },
      { x: 250, y: 300, id: 2 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 100, y: 300, id: 1 },
      { x: 300, y: 300, id: 2 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(
    viewer.getByRole('button', { name: '画面に合わせる' }),
  ).toHaveText('200%');
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[0].filename);
  await viewer.getByRole('button', { name: '画面に合わせる' }).click();
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 300, y: 300, id: 1 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 100, y: 300, id: 1 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[1].filename);
  await session.detach();
});

test('video and audio play generated media and swiping unmounts the previous player', async ({
  page,
}) => {
  const video = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    const result = new Promise<number[]>((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = async () =>
        resolve(
          Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())),
        );
    });
    recorder.start();
    const draw = setInterval(() => {
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = Date.now() % 2 ? '#527d67' : '#86a594';
        context.fillRect(0, 0, 160, 90);
      }
    }, 40);
    setTimeout(() => {
      clearInterval(draw);
      recorder.stop();
      for (const track of stream.getTracks()) track.stop();
    }, 1200);
    return result;
  });
  await page.route('**/api/v1/assets/video/renditions/mp4/content', (route) =>
    route.fulfill({ contentType: 'video/webm', body: Buffer.from(video) }),
  );
  const audio = Buffer.alloc(44 + 16000);
  audio.write('RIFF');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(16000, 40);
  await page.route('**/api/v1/assets/audio/content', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: audio }),
  );
  await page
    .getByRole('button', { name: fixtures[1].filename, exact: true })
    .dblclick();
  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('video')).toHaveAttribute(
    'src',
    '/api/v1/assets/video/renditions/mp4/content',
  );
  await viewer.locator('video').evaluate(async (element: HTMLVideoElement) => {
    await element.play();
  });
  await expect
    .poll(() =>
      viewer
        .locator('video')
        .evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await swipeViewer(page, -1);
  await expect(viewer.locator('video')).toHaveCount(0);
  await viewer.locator('audio').evaluate(async (element: HTMLAudioElement) => {
    await element.play();
  });
  await expect
    .poll(() =>
      viewer
        .locator('audio')
        .evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await swipeViewer(page, -1);
  await expect(viewer.getByRole('heading')).toHaveText(fixtures[3].filename);
  await expect(viewer.locator('audio')).toHaveCount(0);
});

test('metadata autosaves, validates and keeps tags as individual chips', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  await page.getByText('名前を変更', { exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ファイル名', exact: true });
  const tag = page.getByRole('textbox', { name: 'タグ', exact: true });
  const patches: unknown[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH') patches.push(r.postDataJSON());
  });
  await name.fill('新しい名前.png');
  await name.press('Enter');
  await expect(name).toBeEnabled();
  await expect(page.locator('.detail-heading')).toContainText('新しい名前.png');
  await tag.focus();
  expect(patches).toEqual([{ filename: '新しい名前.png' }]);
  await name.fill('取り消す.png');
  await name.press('Escape');
  await expect(name).toHaveValue('新しい名前.png');
  await name.fill('   ');
  await name.press('Enter');
  await expect(page.locator('.metadata-error')).toContainText('1024バイト');
  await name.press('Escape');
  await tag.fill('旅行');
  await tag.press('Enter');
  await expect(page.locator('.metadata-error')).toContainText('追加済み');
  await tag.fill('  カンマ,も一つのタグ  ');
  await tag.press('Enter');
  await expect(
    page.getByRole('button', { name: 'タグ「カンマ,も一つのタグ」を削除' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'タグ「旅行」を削除' }).click();
  await expect(
    page.getByRole('button', { name: 'タグ「旅行」を削除' }),
  ).toHaveCount(0);
  expect(patches).toEqual([
    { filename: '新しい名前.png' },
    { tags: ['旅行', '風景', 'カンマ,も一つのタグ'] },
    { tags: ['風景', 'カンマ,も一つのタグ'] },
  ]);
  await tag.fill('未確定');
  await tag.blur();
  expect(patches).toHaveLength(3);
});

test('metadata failure retains input and retries, pending response stays with its asset', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  let attempts = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/assets/image', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    attempts++;
    if (attempts === 1)
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    await pending;
    return route.fulfill({
      json: { ...fixtures[0], filename: '保存する名前.png' },
    });
  });
  await page.getByText('名前を変更', { exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ファイル名', exact: true });
  await name.fill('保存する名前.png');
  await name.press('Enter');
  await expect(
    page.getByRole('button', { name: '保存を再試行' }),
  ).toBeVisible();
  await expect(name).toHaveValue('保存する名前.png');
  await page.getByRole('button', { name: '保存を再試行' }).click();
  await expect(name).toBeDisabled();
  await expect(
    page.getByRole('textbox', { name: 'タグ', exact: true }),
  ).toBeDisabled();
  await page.locator('.file').filter({ hasText: '散歩の記録.mp4' }).click();
  release();
  await expect(
    page.locator('.file').filter({ hasText: '保存する名前.png' }),
  ).toHaveCount(1);
  await page.getByText('名前を変更', { exact: true }).click();
  await expect(name).toHaveValue('散歩の記録.mp4');
  await expect(page.locator('.metadata-status')).toBeEmpty();
  expect(attempts).toBe(2);
});

test('metadata byte limits and Japanese composition do not submit invalid drafts', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  let patches = 0;
  page.on('request', (r) => {
    if (r.method() === 'PATCH') patches++;
  });
  await page.getByText('名前を変更', { exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ファイル名', exact: true });
  await name.fill('あ'.repeat(342));
  await name.press('Enter');
  await expect(page.locator('.metadata-error')).toContainText('1024バイト');
  await name.press('Escape');
  await name.fill('変換中.png');
  await name.dispatchEvent('compositionstart');
  await name.press('Enter');
  expect(patches).toBe(0);
  await name.dispatchEvent('compositionend');
  await name.press('Escape');
  const tag = page.getByRole('textbox', { name: 'タグ', exact: true });
  await tag.fill('あ'.repeat(86));
  await tag.press('Enter');
  await expect(page.locator('.metadata-error')).toContainText('256バイト');
  await tag.fill('変換中');
  await tag.dispatchEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    bubbles: true,
  });
  expect(patches).toBe(0);
});

for (const width of [1440, 390, 320]) {
  test(`metadata chips wrap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const asset = {
      ...fixtures[0],
      filename: `${'長い名前'.repeat(35)}.png`,
      tags: Array.from(
        { length: 30 },
        (_, i) => `${i}-${'長いタグ'.repeat(15)}`,
      ),
    };
    await page.route('**/api/v1/assets*', (route) =>
      route.fulfill({ json: { assets: [asset] } }),
    );
    await page.reload();
    await page.locator('.file').click();
    await expect(page.locator('.tag-chip')).toHaveCount(30);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.metadata-editor')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    if (process.env.UI_SCREENSHOTS) {
      await page.locator('.metadata-editor').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `../docs/library-metadata-${width}.png` });
    }
  });
}

test('blur saves filename, comparison heading updates and refresh failure is separate', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  await page.getByRole('button', { name: '類似ファイル', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '類似ファイル：山の風景.png' }),
  ).toBeVisible();
  await page.getByText('名前を変更', { exact: true }).click();
  const name = page.getByRole('textbox', { name: 'ファイル名', exact: true });
  await name.fill('比較元の新しい名前.png');
  await name.blur();
  await expect(
    page.getByRole('heading', { name: '類似ファイル：比較元の新しい名前.png' }),
  ).toBeVisible();
  await expect(page.locator('.metadata-status')).toHaveText('保存しました');
  await page.route('**/api/v1/assets/image/similar', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await name.fill('保存は成功.png');
  await name.press('Enter');
  await expect(page.locator('.metadata-status')).toHaveText('保存しました');
  await expect(page.locator('.error')).toContainText(
    '変更は保存しましたが、一覧を更新できませんでした',
  );
  await expect(page.getByRole('button', { name: '保存を再試行' })).toHaveCount(
    0,
  );
});

test('metadata edits preserve the matching PDF page', async ({ page }) => {
  await page.getByLabel('検索クエリ').fill('pdf');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(1);
  await page.locator('.file').click();
  await page
    .getByRole('textbox', { name: 'タグ', exact: true })
    .fill('ページ付き');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('.metadata-status')).toHaveText('保存しました');
  await expect(page.getByRole('img', { name: 'PDF 2ページ目' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: '元ファイルを開く' }),
  ).toHaveAttribute('href', /#page=2$/);
});

test('library exposes search modes directly and keeps secondary controls on demand', async ({
  page,
}) => {
  await expect(
    page.getByRole('heading', { level: 1, name: 'ライブラリ' }),
  ).toBeVisible();
  await expect(
    page
      .locator('.app-header')
      .getByRole('button', { name: '＋ アップロード' }),
  ).toBeVisible();
  await expect(page.locator('.collection').getByRole('search')).toBeVisible();
  const mode = page.getByRole('combobox', { name: '検索方法' });
  await expect(mode).toBeVisible();
  await expect(mode).toHaveValue('keyword');
  await page.getByRole('searchbox').focus();
  await page.keyboard.press('Tab');
  await expect(mode).toBeFocused();
  await mode.selectOption('semantic');
  await expect(mode).toHaveValue('semantic');
  await expect(mode.locator('option:checked')).toHaveText('意味');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: '検索', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '山の風景.png', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'ファイル名', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('textbox', { name: 'タグ', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('プレビュー・文字抽出', { exact: true }),
  ).toBeHidden();
  await expect(page.getByText('Enterまたは', { exact: false })).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(width);
    await expect(mode).toBeVisible();
    if (process.env.UI_SCREENSHOTS && width !== 320) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `../docs/library-search-mode-${width}.png`,
        fullPage: true,
      });
    }
  }
});

for (const [field, label] of [
  ['tag', 'タグ'],
  ['character', 'キャラクター'],
] as const) {
  for (const context of ['search', 'comparison', 'page'] as const) {
    test(`detail ${field} search resets ${context} context and filters`, async ({
      page,
    }) => {
      const tag = '旅行, 日本語 & + #?';
      const assets = Array.from({ length: 49 }, (_, i) => ({
        ...fixtures[0],
        asset_id: `tag-${i}`,
        filename: `タグ検索 ${i + 1}`,
        tags: [tag],
        characters: [tag],
      }));
      await page.route('**/api/v1/assets?**', (route) => {
        const params = new URL(route.request().url()).searchParams;
        const offset = Number(params.get('offset'));
        return route.fulfill({
          json: {
            assets: assets.slice(offset, offset + 24),
            total: assets.length,
          },
        });
      });
      await page.route('**/api/v1/search', (route) =>
        route.fulfill({ json: { assets } }),
      );
      await page.route('**/api/v1/assets/*/duplicates', (route) =>
        route.fulfill({ json: { assets } }),
      );
      await page.reload();
      if (context === 'search') {
        await page.getByRole('searchbox').fill('以前の検索');
        await page
          .getByRole('combobox', { name: '検索方法' })
          .selectOption('semantic');
        await page.getByRole('button', { name: '検索', exact: true }).click();
      }
      if (context === 'comparison') {
        await page.locator('.file').first().click();
        await page
          .getByRole('button', { name: '完全一致ファイル', exact: true })
          .click();
      }
      await page.getByRole('button', { name: '画像', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'ページネーション' })
        .getByRole('button', { name: '次へ' })
        .click();
      await expect(
        page.getByRole('button', { name: 'タグ検索 25', exact: true }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'タグ検索 25', exact: true })
        .click();
      const request = page.waitForRequest((r) =>
        new URL(r.url()).searchParams.has(field),
      );
      await page
        .getByRole('button', { name: `${label}「${tag}」で検索` })
        .click();
      const params = new URL((await request).url()).searchParams;
      expect(Object.fromEntries(params)).toEqual({
        [field]: tag,
        limit: '24',
        offset: '0',
      });
      await expect(
        page.getByRole('heading', { name: `${label}：${tag}`, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'ファイル詳細' }),
      ).toHaveCount(0);
      await expect(page.getByRole('searchbox')).toHaveValue('');
      await expect(
        page.getByRole('combobox', { name: '検索方法' }),
      ).toHaveValue('keyword');
      await expect(
        page
          .getByRole('group', { name: 'ファイルの種類' })
          .getByRole('button', { name: 'すべて', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page.getByRole('navigation', { name: 'ページネーション' }),
      ).toContainText('1–24 / 49 件');
    });
  }
}

test('detail tag deletion does not search and keyboard opens tag results', async ({
  page,
}) => {
  await page.locator('.file').filter({ hasText: '山の風景.png' }).click();
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).searchParams.has('tag'))
      requests.push(request.url());
  });
  await page.getByRole('button', { name: 'タグ「旅行」を削除' }).click();
  await expect(
    page.getByRole('button', { name: 'タグ「旅行」で検索' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  const button = page.getByRole('button', { name: 'タグ「風景」で検索' });
  await button.focus();
  if (process.env.UI_SCREENSHOTS) {
    await page.screenshot({ path: '../docs/library-tag-search.png' });
    await page.setViewportSize({ width: 320, height: 1000 });
    await button.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '../docs/library-tag-search-mobile.png' });
  }
  await button.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'タグ：風景', exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('detail character deletion stays separate and long names support keyboard search', async ({
  page,
}) => {
  const character = '長いキャラクター,日本語 & + #?'.repeat(4);
  const asset = { ...fixtures[0], characters: ['削除対象', character] };
  await page.route('**/api/v1/assets?**', (route) =>
    route.fulfill({ json: { assets: [asset], total: 1 } }),
  );
  await page.route('**/api/v1/assets/image', (route) => {
    if (route.request().method() === 'PATCH') {
      const changes = route.request().postDataJSON();
      expect(changes).toEqual({ characters: [character] });
      Object.assign(asset, changes);
    }
    return route.fulfill({ json: asset });
  });
  await page.reload();
  await page.locator('.file').first().click();
  const requests: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).searchParams.has('character')) requests.push(r.url());
  });
  await page
    .getByRole('button', { name: 'キャラクター「削除対象」を削除' })
    .click();
  await expect(
    page.getByRole('button', { name: 'キャラクター「削除対象」で検索' }),
  ).toHaveCount(0);
  await expect(page.getByRole('list', { name: '登録済みタグ' })).toContainText(
    '旅行',
  );
  expect(requests).toHaveLength(0);
  const button = page.getByRole('button', {
    name: `キャラクター「${character}」で検索`,
  });
  await button.focus();
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({ path: '../docs/library-character-search.png' });
  await page.setViewportSize({ width: 320, height: 1000 });
  await button.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  expect(
    await page
      .locator('.metadata-editor')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  if (process.env.UI_SCREENSHOTS)
    await page.screenshot({
      path: '../docs/library-character-search-mobile.png',
    });
  await button.press('Space');
  await expect(
    page.getByRole('heading', {
      name: `キャラクター：${character}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'ファイル詳細' })).toHaveCount(
    0,
  );
  expect(requests).toHaveLength(1);
  const params = new URL(requests[0]).searchParams;
  expect(Object.fromEntries(params)).toEqual({
    character,
    limit: '24',
    offset: '0',
  });
});
