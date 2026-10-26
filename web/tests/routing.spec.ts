import { expect, type Page, test } from '@playwright/test';

const files = Array.from({ length: 50 }, (_, i) => ({
  asset_id: `file-${i}`,
  filename: `サンプル${i}.png`,
  mime_type: 'image/png',
  tags: ['旅行, 日本語 & + #?'],
  characters: ['人物A'],
  rating: 'general',
  status: 'ready',
  is_favorite: true,
}));
const picture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#8dbba8"/></svg>';

async function setup(
  page: Page,
  state = { authenticated: true, denied: false },
) {
  const searches: string[] = [];
  await page.route('**/auth/config', (r) =>
    r.fulfill({ json: { development: true } }),
  );
  await page.route('**/auth/dev-login', (r) => {
    state.authenticated = true;
    return r.fulfill({ status: 204 });
  });
  await page.route('**/api/v1/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname;
    if (path.endsWith('/me'))
      return r.fulfill(
        state.authenticated
          ? { json: { principal_id: 'demo', csrf_token: 'test' } }
          : { status: 401, json: { error: 'AUTH_REQUIRED' } },
      );
    if (path === '/api/v1/search') {
      const query = r.request().postDataJSON().query;
      searches.push(query);
      if (query === 'slow')
        await new Promise((resolve) => setTimeout(resolve, 400));
      return r.fulfill({
        json: { assets: query === 'slow' ? [files[0]] : files },
      });
    }
    if (path === '/api/v1/tags' || path === '/api/v1/characters') {
      const field = path.endsWith('/tags') ? 'tags' : 'characters';
      return r.fulfill({
        json: {
          [field]: [{ name: '旅行', asset_count: 2 }],
          total: 1,
          links: [],
        },
      });
    }
    if (path === '/api/v1/assets') {
      const offset = Number(url.searchParams.get('offset'));
      return r.fulfill({
        json: { assets: files.slice(offset, offset + 24), total: files.length },
      });
    }
    if (
      path.endsWith('/recommendations') ||
      path.endsWith('/similar') ||
      path.endsWith('/duplicates')
    )
      return r.fulfill({
        json: {
          assets: files.map((asset) => ({
            ...asset,
            score: 80,
            common_tags: [],
            common_characters: [],
          })),
          hash_status: 'ready',
        },
      });
    if (path.endsWith('/renditions'))
      return r.fulfill({ json: { renditions: [] } });
    if (path.endsWith('/jobs')) return r.fulfill({ json: { jobs: [] } });
    if (path.endsWith('/preview') || path.endsWith('/content'))
      return r.fulfill({ contentType: 'image/svg+xml', body: picture });
    const asset = files.find(
      (asset) => path === `/api/v1/assets/${asset.asset_id}`,
    );
    return r.fulfill(
      asset && !state.denied
        ? { json: asset }
        : { status: 404, json: { error: 'NOT_FOUND' } },
    );
  });
  return searches;
}

test('URLs restore Japanese filters, pagination, selection and browser history', async ({
  page,
}) => {
  await setup(page);
  const tag = files[0].tags[0];
  await page.goto(`/library?${new URLSearchParams({ tag, page: '2' })}`);
  await expect(
    page.getByRole('heading', { name: `タグ：${tag}` }),
  ).toBeVisible();
  await expect(page.getByText('2 / 3 ページ')).toBeVisible();
  await page
    .getByRole('button', { name: files[24].filename, exact: true })
    .click();
  await expect(page).toHaveURL(/\/assets\/file-24\?/);
  expect(new URL(page.url()).searchParams.get('tag')).toBe(tag);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText(files[24].filename);
  await page.goBack();
  await expect(page).toHaveURL(/\/library\?/);
  await expect(page.getByRole('region', { name: 'ファイル詳細' })).toHaveCount(
    0,
  );
  await page.goForward();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'ファイルを閲覧', exact: true })
    .click();
  await expect(page).toHaveURL(/\/assets\/file-24\/view\?/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/assets\/file-25\/view\?/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('2 / 3 ページ')).toBeVisible();
});

test('direct viewer and comparison links load authorized assets and parent conditions', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/assets/file-25/view?from=favorites&page=2');
  await expect(page.getByRole('dialog')).toContainText(files[25].filename);
  await expect(
    page.getByRole('link', { name: 'お気に入り', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/assets\/file-25\?page=2&from=favorites$/);
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  await expect(page).toHaveURL(/\/favorites\?page=2$/);
  await page.goto('/library?mode=recommendation&source=file-0&page=2');
  await expect(
    page.getByRole('heading', { name: '関連コンテンツ', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('2 / 3 ページ')).toBeVisible();
  if (process.env.UI_SCREENSHOTS === '1')
    await page.screenshot({ path: '../docs/path-routing.png', fullPage: true });
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});

test('search input is committed on submit; ratings and malformed values are normalized', async ({
  page,
}) => {
  const searches = await setup(page);
  await page.goto('/library?mode=invalid&kind=invalid&page=-2&ratings=none');
  await expect(page).toHaveURL(/\/library\?ratings=none$/);
  await expect(
    page.getByRole('checkbox', { name: 'general', exact: true }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'general', exact: true }).check();
  await page.getByRole('searchbox').fill('日本語 & + #?');
  expect(new URL(page.url()).searchParams.has('q')).toBe(false);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect.poll(() => searches.at(-1)).toBe('日本語 & + #?');
  expect(new URL(page.url()).searchParams.get('q')).toBe('日本語 & + #?');
  await page.reload();
  await expect(page.getByRole('searchbox')).toHaveValue('日本語 & + #?');
  await expect(page.locator('.file')).toHaveCount(24);
});

test('tag and character view URLs survive reload and history traversal', async ({
  page,
}) => {
  await setup(page);
  for (const section of ['tags', 'characters']) {
    await page.goto(`/${section}?q=旅行&view=list`);
    await expect(page.getByRole('searchbox')).toHaveValue('旅行');
    await expect(
      page.getByRole('button', { name: '一覧', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('searchbox').fill('日本語');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('日本語');
    await page.reload();
    await expect(page.getByRole('searchbox')).toHaveValue('日本語');
    await page.getByRole('link', { name: 'ライブラリ', exact: true }).click();
    await page.goBack();
    await expect(page.getByRole('searchbox')).toHaveValue('日本語');
  }
});

test('login resumes the current deep link and missing assets have one message', async ({
  page,
}) => {
  const state = { authenticated: false, denied: false };
  await setup(page, state);
  await page.goto('/assets/file-1?from=favorites');
  await page.getByRole('button', { name: 'alice でログイン' }).click();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText(files[1].filename);
  await expect(page).toHaveURL(/\/assets\/file-1\?from=favorites$/);
  state.denied = true;
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'ファイルが見つかりません' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'ファイル詳細' })).toHaveCount(
    0,
  );
  await page.goto('/assets/missing');
  await expect(
    page.getByRole('heading', { name: 'ファイルが見つかりません' }),
  ).toBeVisible();
  await page.goto('/missing-page');
  await expect(
    page.getByRole('heading', { name: 'ページが見つかりません' }),
  ).toBeVisible();
});

test('navigation discards late search responses', async ({ page }) => {
  const searches = await setup(page);
  await page.goto('/library');
  await expect(page.locator('.file')).toHaveCount(24);
  await page.getByRole('searchbox').fill('slow');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect.poll(() => searches.length).toBe(1);
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(24);
  await page.waitForTimeout(500);
  await expect(page.locator('.file')).toHaveCount(24);
  await expect(page.getByRole('searchbox')).toHaveValue('');
});

test('asset retrieval failures can retry without changing the deep link', async ({
  page,
}) => {
  await setup(page);
  let failed = true;
  await page.route('**/api/v1/assets/file-1', (r) =>
    r.fulfill(
      failed
        ? { status: 503, json: { error: 'UNAVAILABLE' } }
        : { json: files[1] },
    ),
  );
  await page.goto('/assets/file-1/view?from=favorites');
  await expect(
    page.getByRole('heading', { name: 'ファイルを読み込めません' }),
  ).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: '再試行', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(files[1].filename);
  await expect(page).toHaveURL(/\/assets\/file-1\/view\?from=favorites$/);
});

test('a fresh recommendation link starts a new session on page one and preserves its asset', async ({
  page,
}) => {
  await setup(page);
  let generations = 0;
  await page.route('**/api/v1/recommendations?**', (r) => {
    const params = new URL(r.request().url()).searchParams;
    if (!params.has('session_id')) generations++;
    return r.fulfill({
      json: {
        status: 'ready',
        session_id: 'fixture-session',
        total: 50,
        assets: files.slice(0, 24).map((asset) => ({
          ...asset,
          score: 80,
          common_tags: [],
          common_characters: [],
        })),
      },
    });
  });
  await page.goto('/assets/file-25/view?from=recommendations&page=2');
  await expect(page.getByRole('dialog')).toContainText(files[25].filename);
  await expect(page).toHaveURL(
    /\/assets\/file-25\/view\?from=recommendations$/,
  );
  expect(generations).toBe(1);
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(generations).toBe(2);
});
