import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

const image = readFileSync(
  new URL('../../.cache/fixtures/car.png', import.meta.url),
);

async function login(page: Page, user: 'alice' | 'bob') {
  const response = await page.request.post('/auth/dev-login', {
    headers: { Origin: 'http://localhost:8080' },
    data: { user },
  });
  expect(response.status()).toBe(200);
}

async function oidcLogin(page: Page, destination: string) {
  await page.getByRole('link', { name: 'SSOでログイン' }).click();
  await page
    .getByRole('button', { name: 'Aliceでログイン', exact: true })
    .click();
  await page
    .getByRole('button', { name: '同意してOCMSへ進む', exact: true })
    .click();
  // Compare a boolean so a failed assertion never prints an OAuth URL or code.
  await expect.poll(() => page.url() === destination).toBe(true);
}

async function upload(page: Page, origin = 'http://localhost:8080') {
  const me = await page.request.get(`${origin}/api/v1/me`);
  expect(me.status()).toBe(200);
  const identity = await me.json();
  const headers = { Origin: origin, 'X-CSRF-Token': identity.csrf_token };
  const filename = `routing-live-${randomUUID()}.png`;
  const tag = `ルーティング-${randomUUID()}`;
  const created = await page.request.post(`${origin}/api/v1/uploads`, {
    headers,
    data: { filename, mime_type: 'image/png', size_bytes: image.length },
  });
  expect(created.status()).toBe(201);
  const session = await created.json();
  const uploaded = await page.request.put(
    `${origin}/api/v1/uploads/${session.upload_id}/content`,
    {
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      data: image,
    },
  );
  expect(uploaded.status()).toBe(200);
  const changed = await page.request.patch(
    `${origin}/api/v1/assets/${session.asset_id}`,
    { headers, data: { tags: [tag] } },
  );
  expect(changed.status()).toBe(200);
  return { id: session.asset_id as string, filename, tag };
}

test('built BFF serves deep links, live search, tag filtering, history and viewer content', async ({
  page,
}) => {
  await login(page, 'alice');
  const asset = await upload(page);
  await page.goto(`/library?${new URLSearchParams({ q: asset.filename })}`);
  await expect(
    page.getByRole('button', { name: asset.filename, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: asset.filename, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/assets/${asset.id}\\?`));
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toContainText(asset.filename);
  await page
    .getByRole('button', { name: `タグ「${asset.tag}」で検索` })
    .click();
  await expect(
    page.getByRole('heading', { name: `タグ：${asset.tag}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.file')).toHaveCount(1);
  await page.goBack();
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'ファイルを閲覧', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(asset.filename);
  await expect(page.getByRole('dialog').getByRole('img')).toHaveJSProperty(
    'naturalWidth',
    640,
  );
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('region', { name: 'ファイル詳細' }),
  ).toBeVisible();
  const head = await page.request.head(`/assets/${asset.id}/view`);
  expect(head.status()).toBe(200);
  expect((await head.body()).length).toBe(0);
});

test('real ACL rejects another user at the same asset and viewer URLs', async ({
  page,
  context,
}) => {
  await login(page, 'alice');
  const asset = await upload(page);
  await page.goto(`/assets/${asset.id}/view`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await login(page, 'bob');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'ファイルが見つかりません' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.request.get(`/api/v1/assets/${asset.id}`)).status()).toBe(
    404,
  );
  const anonymous = await context.browser()?.newContext();
  if (!anonymous) throw new Error('browser unavailable');
  const other = await anonymous.newPage();
  await other.goto(`http://localhost:8080/assets/${asset.id}/view`);
  await expect(
    other.getByRole('heading', { name: 'ライブラリにログイン' }),
  ).toBeVisible();
  await expect(other.getByRole('dialog')).toHaveCount(0);
  await anonymous.close();
});

test('actual Hydra restores a Japanese tag URL and a private viewer after logout', async ({
  page,
}) => {
  const origin = 'http://localhost:8081';
  const target = `/tags?${new URLSearchParams({ q: '日本語 & + #?', view: 'list' })}`;
  await page.goto(origin + target);
  await oidcLogin(page, origin + target);
  await expect(page.getByRole('searchbox')).toHaveValue('日本語 & + #?');
  const asset = await upload(page, origin);
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('link', { name: 'SSOでログイン' })).toBeVisible();
  const viewer = `/assets/${asset.id}/view?from=favorites`;
  await page.goto(origin + viewer);
  await oidcLogin(page, origin + viewer);
  await expect(page.getByRole('dialog')).toContainText(asset.filename);
  await expect(page.getByRole('dialog').getByRole('img')).toHaveJSProperty(
    'naturalWidth',
    640,
  );
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
});
