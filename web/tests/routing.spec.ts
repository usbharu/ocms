import { expect, type Page, test } from '@playwright/test';

const files = Array.from({ length: 202 }, (_, i) => ({
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

for (const start of [0, 199]) {
  test(`viewer stays open during delayed forward and backward navigation from ${start}`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/assets/file-${start}/view`);
    const viewer = page.getByRole('dialog', { name: 'ファイル閲覧' });
    await expect(viewer.getByRole('heading')).toHaveText(files[start].filename);
    const original = await viewer.elementHandle();
    if (!original) throw new Error('Viewer did not open');

    for (const [target, direction] of [
      [start + 1, '次のファイル'],
      [start, '前のファイル'],
    ] as const) {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;
      const endpoint = `**/api/v1/assets/file-${target}`;
      await page.route(endpoint, async (route) => {
        started = true;
        await held;
        await route.fulfill({ json: files[target] });
      });
      await viewer.getByRole('button', { name: direction }).click();
      await expect.poll(() => started).toBe(true);
      // The original top-layer dialog must remain open while the response is held.
      expect(
        await original.evaluate(
          (element: HTMLDialogElement) =>
            element.isConnected && element.open && element.matches(':modal'),
        ),
      ).toBe(true);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe(
        'hidden',
      );
      await expect(
        viewer.getByRole('button', { name: direction }),
      ).toBeDisabled();
      if (start === 0 && target === 1)
        await page.screenshot({
          path: 'test-results/viewer-navigation-pending.png',
        });
      release();
      await expect(viewer.getByRole('heading')).toHaveText(
        files[target].filename,
      );
      expect(
        await original.evaluate(
          (element: HTMLDialogElement) => element.isConnected && element.open,
        ),
      ).toBe(true);
      await page.unroute(endpoint);
    }
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe('');
  });
}

for (const status of [403, 404, 503]) {
  test(`failed viewer navigation (${status}) closes the previous asset`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/assets/file-0/view');
    const viewer = page.getByRole('dialog');
    await expect(viewer).toBeVisible();
    await page.route('**/api/v1/assets/file-1', (route) =>
      route.fulfill({ status, json: { error: 'unavailable' } }),
    );
    await viewer.getByRole('button', { name: '次のファイル' }).click();
    await expect(viewer).toHaveCount(0);
    await expect(page.locator('.details')).toHaveCount(0);
    await expect(
      page.getByRole('heading', {
        name:
          status === 503
            ? 'ファイルを読み込めません'
            : 'ファイルが見つかりません',
      }),
    ).toBeVisible();
  });
}

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
        json: {
          assets: files.slice(offset, offset + 200),
          total: files.length,
        },
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
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
  await page
    .getByRole('button', { name: files[200].filename, exact: true })
    .click();
  await expect(page).toHaveURL(/\/assets\/file-200\?/);
  expect(new URL(page.url()).searchParams.get('tag')).toBe(tag);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText(files[200].filename);
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
  await expect(page).toHaveURL(/\/assets\/file-200\/view\?/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/assets\/file-201\/view\?/);
  await expect(page.getByRole('dialog')).toContainText(files[201].filename);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
});

test('direct viewer and comparison links load authorized assets and parent conditions', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/assets/file-201/view?from=favorites&page=2');
  await expect(page.getByRole('dialog')).toContainText(files[201].filename);
  await expect(
    page.getByRole('link', { name: 'お気に入り', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/assets\/file-201\?page=2&from=favorites$/);
  await page.getByRole('button', { name: '詳細を閉じる' }).click();
  await expect(page).toHaveURL(/\/favorites\?page=2$/);
  await page.goto('/library?mode=recommendation&source=file-0&page=2');
  await expect(
    page.getByRole('heading', { name: '関連コンテンツ', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
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
  await expect(page.locator('.file')).toHaveCount(200);
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
  await expect(page.locator('.file')).toHaveCount(200);
  await page.getByRole('searchbox').fill('slow');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect.poll(() => searches.length).toBe(1);
  await page.getByRole('link', { name: 'お気に入り', exact: true }).click();
  await expect(page.locator('.file')).toHaveCount(200);
  await page.waitForTimeout(500);
  await expect(page.locator('.file')).toHaveCount(200);
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
        total: 201,
        assets: files.slice(0, 200).map((asset) => ({
          ...asset,
          score: 80,
          common_tags: [],
          common_characters: [],
        })),
      },
    });
  });
  await page.goto('/assets/file-201/view?from=recommendations&page=2');
  await expect(page.getByRole('dialog')).toContainText(files[201].filename);
  await expect(page).toHaveURL(
    /\/assets\/file-201\/view\?from=recommendations$/,
  );
  expect(generations).toBe(1);
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(generations).toBe(2);
});

test('late detail responses cannot reopen an asset after leaving its URL', async ({
  page,
}) => {
  await setup(page);
  let started = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/assets/file-1', async (r) => {
    started = true;
    await held;
    await r.fulfill({ json: files[1] });
  });
  await page.goto('/library');
  await page
    .getByRole('button', { name: files[1].filename, exact: true })
    .click();
  await expect.poll(() => started).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
  release();
  await page
    .getByRole('button', { name: files[2].filename, exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText(files[2].filename);
  await expect(page).toHaveURL(/\/assets\/file-2$/);
});

test('permission loss during detail polling closes both detail and viewer', async ({
  page,
}) => {
  const state = { authenticated: true, denied: false };
  await setup(page, state);
  await page.clock.install();
  await page.goto('/assets/file-1/view');
  await expect(page.getByRole('dialog')).toBeVisible();
  // Wait for the initial metadata poll before advancing to the next poll.
  await expect(page.locator('.details')).toBeAttached();
  state.denied = true;
  await page.clock.fastForward(5001);
  await expect(
    page.getByRole('heading', { name: 'ファイルが見つかりません' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.details')).toHaveCount(0);
});

test('a search page past the final result is corrected in the URL', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/library?q=sample&page=999');
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
  await expect(page).toHaveURL(/\/library\?q=sample&page=2$/);
  await page.reload();
  await expect(page.locator('.file')).toHaveCount(2);
});

test('recommendation viewer crosses pages using the same session', async ({
  page,
}) => {
  await setup(page);
  let generations = 0;
  await page.route('**/api/v1/recommendations?**', (r) => {
    const params = new URL(r.request().url()).searchParams;
    if (!params.has('session_id')) generations++;
    const offset = (Number(params.get('page') ?? '1') - 1) * 200;
    return r.fulfill({
      json: {
        status: 'ready',
        session_id: 'fixture-session',
        total: files.length,
        assets: files.slice(offset, offset + 200).map((asset) => ({
          ...asset,
          score: 80,
          common_tags: [],
          common_characters: [],
        })),
      },
    });
  });
  await page.goto('/recommendations');
  await page
    .getByRole('button', { name: files[199].filename, exact: true })
    .click();
  await page
    .getByRole('button', { name: 'ファイルを閲覧', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(files[199].filename);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog')).toContainText(files[200].filename);
  await expect(page).toHaveURL(
    /\/assets\/file-200\/view\?page=2&from=recommendations$/,
  );
  expect(generations).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByText('2 / 2 ページ')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText(files[200].filename);
});

test('draft input follows the latest visit to a history entry', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/library');
  await expect(page.locator('.file')).toHaveCount(200);
  await page.getByRole('searchbox').fill('first draft');
  await page.getByRole('link', { name: 'タグ', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('first draft');
  await page.getByRole('searchbox').fill('second draft');
  await page.getByRole('link', { name: 'キャラクター', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('second draft');
});

test('header links navigate without reloading the document and open independently', async ({
  page,
  context,
}) => {
  await setup(page);
  await page.goto('/library');
  await page.evaluate(() => {
    (window as Window & { routingMarker?: string }).routingMarker =
      'same-document';
  });
  const link = page.getByRole('link', { name: 'お気に入り', exact: true });
  const href = await link.getAttribute('href');
  await link.click();
  await expect(page).toHaveURL(/\/favorites$/);
  expect(
    await page.evaluate(
      () => (window as Window & { routingMarker?: string }).routingMarker,
    ),
  ).toBe('same-document');
  const other = await context.newPage();
  await setup(other);
  if (!href) throw new Error('navigation link is missing its URL');
  await other.goto(href);
  await expect(
    other.getByRole('heading', { name: 'お気に入り', exact: true, level: 1 }),
  ).toBeAttached();
  await expect(page).toHaveURL(/\/favorites$/);
  await other.close();
});

// Synthetic events cover restore handling, not browser bfcache eligibility.
test('bfcache restore checks the session and clears expired private UI', async ({
  page,
}) => {
  const state = { authenticated: true, denied: false };
  await setup(page, state);
  await page.goto('/library');
  await expect(page.locator('.file').first()).toBeVisible();
  let checks = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/me') checks++;
  });
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/assets',
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    ),
  );
  await refreshed;
  await expect.poll(() => checks).toBe(1);
  await expect(page.locator('.file').first()).toBeVisible();
  state.authenticated = false;
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    ),
  );
  await expect.poll(() => checks).toBe(2);
  await expect(
    page.getByRole('heading', { name: 'ライブラリにログイン' }),
  ).toBeVisible();
  await expect(page.locator('.file')).toHaveCount(0);
  await expect(page).toHaveURL(/\/library$/);
});

test('navigation intent preloads code without fetching private data', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/library');
  const link = page.getByRole('link', { name: 'タグ', exact: true });
  await expect(link).toBeVisible();
  const requests: string[] = [];
  page.on('request', (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  await link.focus();
  await expect
    .poll(() =>
      requests.some((path) => /\/assets\/TagsPage-.*\.js$/.test(path)),
    )
    .toBe(true);
  expect(requests.includes('/api/v1/tags')).toBe(false);
  await link.click();
  await expect.poll(() => requests.includes('/api/v1/tags')).toBe(true);
});
