import { expect, type Page, test } from '@playwright/test';

const groupId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const asset = {
  asset_id: assetId,
  filename: 'Group image.png',
  mime_type: 'image/png',
  tags: [],
  characters: [],
  status: 'ready',
  rating: 'general',
};

async function setup(page: Page) {
  let groups = [
    { group_id: 'default', name: 'default', builtin: true },
    { group_id: 'all', name: 'all', builtin: true },
    { group_id: groupId, name: '旅行', builtin: false },
  ];
  let ids = ['default', 'all', groupId];
  const scopes: string[] = [];
  const uploads: { group_id?: string }[] = [];
  await page.route('**/auth/config', (route) =>
    route.fulfill({ json: { development: true } }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path.endsWith('/me'))
      return route.fulfill({
        json: { principal_id: 'demo', csrf_token: 'test' },
      });
    if (path === '/api/v1/groups') {
      if (req.method() === 'POST') {
        groups = [
          ...groups,
          {
            group_id: '33333333-3333-4333-8333-333333333333',
            name: req.postDataJSON().name,
            builtin: false,
          },
        ];
        return route.fulfill({ status: 201, json: groups.at(-1) });
      }
      return route.fulfill({ json: { groups } });
    }
    if (path.startsWith('/api/v1/groups/')) {
      if (req.method() === 'DELETE') {
        groups = groups.filter((group) => group.group_id !== groupId);
        return route.fulfill({ status: 204 });
      }
      groups = groups.map((group) =>
        group.group_id === groupId
          ? { ...group, name: req.postDataJSON().name }
          : group,
      );
      return route.fulfill({
        json: groups.find((group) => group.group_id === groupId),
      });
    }
    if (path === `/api/v1/assets/${assetId}/groups`) {
      if (req.method() === 'PUT') ids = req.postDataJSON().group_ids;
      return route.fulfill({ json: { group_ids: ids } });
    }
    if (path === '/api/v1/uploads') {
      uploads.push(req.postDataJSON());
      return route.fulfill({
        status: 201,
        json: { upload_id: 'upload', asset_id: assetId },
      });
    }
    if (path === '/api/v1/uploads/upload/content')
      return route.fulfill({ json: { asset_id: assetId } });
    if (path === '/api/v1/search') {
      scopes.push(req.postDataJSON().group_id);
      return route.fulfill({ json: { assets: [asset] } });
    }
    if (
      path === '/api/v1/assets' ||
      /\/(similar|duplicates|recommendations)$/.test(path)
    ) {
      scopes.push(url.searchParams.get('group_id') ?? '');
      return route.fulfill({ json: { assets: [asset], total: 1 } });
    }
    if (path.endsWith('/preview') || path.endsWith('/content'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>',
      });
    if (path.endsWith('/renditions'))
      return route.fulfill({ json: { renditions: [] } });
    if (path.endsWith('/jobs')) return route.fulfill({ json: { jobs: [] } });
    if (path === `/api/v1/assets/${assetId}`)
      return route.fulfill({ json: asset });
    return route.fulfill({ json: {} });
  });
  return { scopes, uploads, membership: () => ids };
}

for (const width of [1440, 390]) {
  test(`group CRUD and membership at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await setup(page);
    await page.goto('/groups');
    await expect(
      page.getByRole('heading', { name: 'グループ', exact: true }),
    ).toBeVisible();
    await page.getByLabel('グループ名', { exact: true }).fill('資料');
    await page.getByRole('button', { name: '作成', exact: true }).click();
    await expect(
      page.getByRole('link', { name: '資料', exact: true }),
    ).toBeVisible();
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: '旅行', exact: true }) });
    await row.getByRole('button', { name: '改名' }).click();
    await row.getByLabel('グループ名').fill('旅の写真');
    await row.getByRole('button', { name: '保存', exact: true }).click();
    if (process.env.UI_SCREENSHOTS && width === 1440)
      await page.screenshot({
        path: '../docs/groups-list-1440.png',
        fullPage: true,
      });
    await page.getByRole('link', { name: '旅の写真', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '旅の写真', exact: true }),
    ).toBeVisible();
    await expect.poll(() => state.scopes.at(-1)).toBe(groupId);
    await page.goto(`/assets/${assetId}?from=groups&group_id=${groupId}`);
    await expect(
      page.getByRole('checkbox', { name: 'all', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('checkbox', { name: 'default', exact: true })
      .uncheck();
    await page.getByRole('button', { name: '所属を保存' }).click();
    await expect(page.getByText('所属を保存しました')).toBeVisible();
    expect(state.membership()).toEqual(['all', groupId]);
    if (process.env.UI_SCREENSHOTS && width === 390)
      await page.screenshot({
        path: '../docs/groups-details-390.png',
        fullPage: true,
      });
    await page.goto('/groups');
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('listitem')
      .filter({
        has: page.getByRole('link', { name: '旅の写真', exact: true }),
      })
      .getByRole('button', { name: '削除' })
      .click();
    await expect(
      page.getByRole('link', { name: '旅の写真', exact: true }),
    ).toHaveCount(0);
  });
}

test('top uses default and group upload preserves destination', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto('/library');
  await expect.poll(() => state.scopes.at(-1)).toBe('default');
  await page.goto(`/groups/${groupId}`);
  await expect.poll(() => state.scopes.at(-1)).toBe(groupId);
  await page.locator('input[type=file]').setInputFiles({
    name: 'new.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fixture'),
  });
  await expect.poll(() => state.uploads.length).toBe(1);
  expect(state.uploads[0].group_id).toBe(groupId);
  await expect(page).toHaveURL(new RegExp(`group_id=${groupId}`));
});

test('group search, comparison and history retain the scope', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto(`/groups/${groupId}`);
  await page.getByRole('searchbox', { name: '検索クエリ' }).fill('trip');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page).toHaveURL(/q=trip/);
  await expect.poll(() => state.scopes.at(-1)).toBe(groupId);
  await page.goto(`/assets/${assetId}?from=groups&group_id=${groupId}&q=trip`);
  await page.getByRole('button', { name: '類似ファイル', exact: true }).click();
  await expect(page).toHaveURL(/mode=perceptual/);
  await expect.poll(() => state.scopes.at(-1)).toBe(groupId);
  await page.goBack();
  await expect(page).toHaveURL(/q=trip/);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '旅行', exact: true }),
  ).toBeVisible();
});

test('failed membership save retains edits for retry', async ({ page }) => {
  await setup(page);
  let fail = true;
  await page.route(`**/api/v1/assets/${assetId}/groups`, async (route) => {
    if (route.request().method() === 'PUT' && fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        json: { error: 'SERVICE_UNAVAILABLE' },
      });
    }
    return route.fallback();
  });
  await page.goto(`/assets/${assetId}?from=groups&group_id=${groupId}`);
  const checkbox = page.getByRole('checkbox', { name: 'default', exact: true });
  await checkbox.uncheck();
  await page.getByRole('button', { name: '所属を保存' }).click();
  await expect(page.getByRole('alert')).toContainText(
    '所属を保存できませんでした',
  );
  await expect(checkbox).not.toBeChecked();
  await page.getByRole('button', { name: '所属を保存' }).click();
  await expect(page.getByText('所属を保存しました')).toBeVisible();
});
