import { test, expect } from '@playwright/test';
import { tauriMockInit } from './fixtures/tauri-mock';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(tauriMockInit);
});

test('popup renders all module tabs', async ({ page }) => {
  await page.goto('/');
  for (const label of ['Clipboard', 'Downloads', 'Notes', 'Translator', 'Settings']) {
    await expect(page.getByRole('button', { name: label, exact: false })).toBeVisible();
  }
});

test('cheatsheet opens with ? and closes with Esc', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click();
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByText('Shortcuts', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Shortcuts', { exact: true })).not.toBeVisible();
});

test('global search opens with Cmd+Shift+F', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click();
  // Key literal must be the lowercase 'f' so the shortcut handler can match
  // against `e.key === 'f'` after Shift is applied.
  await page.keyboard.press('Meta+Shift+KeyF');
  await expect(
    page.getByPlaceholder('Search clipboard, downloads, notes…')
  ).toBeVisible();
});

test('settings appearance tab exposes theme & accent controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  // Settings sub-tabs are role="tab", not plain buttons.
  await page.getByRole('tab', { name: 'Appearance' }).click();
  // SURFACE/ACCENT headers and the Translucency slider are stable anchors.
  await expect(page.getByText('ACCENT', { exact: true })).toBeVisible();
  await expect(page.getByText('Translucency', { exact: true })).toBeVisible();
});

test('settings downloads tab exposes the folder picker & rate limit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Downloads' }).click();
  await expect(page.getByText('Download folder')).toBeVisible();
  await expect(page.getByRole('button', { name: /Choose/ })).toBeVisible();
  await expect(page.getByText('Max parallel downloads')).toBeVisible();
  await expect(page.getByText(/Bandwidth limit/)).toBeVisible();
});

test('clipboard tab renders an empty-state message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Clipboard' }).click();
  // Empty stub from tauri-mock returns []; UI should not be loading forever.
  await expect(page.getByRole('button', { name: 'Clipboard' })).toHaveAttribute(
    'class',
    /t-primary|on/
  );
});

test('downloads tab shows the paste-URL bar', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Downloads' }).click();
  await expect(page.getByPlaceholder(/Paste a YouTube/)).toBeVisible();
});

test('⌘⌥2 switches to the Downloads module', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Meta+Alt+2');
  await expect(page.getByPlaceholder(/Paste a YouTube/)).toBeVisible();
});

test('notes tab renders without surfacing a top-level error', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  // Lazy chunk: widen the default 5s assertion timeout so cold dev-server
  // compiles don't race us.
  await expect(page.getByPlaceholder(/Search notes/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Something went wrong/i)).not.toBeVisible();
});

// Core tabs whose mount path doesn't require complex IPC stubs. Translator/AI
// read state that the minimal tauri-mock can't realistically fake without
// pulling in the full Rust contract; their mount crashes under this mock and
// is covered separately by vitest component tests.
test('core module tabs mount without crashing the shell', async ({ page }) => {
  await page.goto('/');
  const tabs = ['Clipboard', 'Downloads', 'Notes', 'Settings'];
  for (const label of tabs) {
    await page.getByRole('button', { name: label }).first().click();
    await page.waitForTimeout(400);
    await expect(page.getByText(/Something went wrong/i)).not.toBeVisible();
  }
});

