export default async function artifactReview({ page, origin, step, shot }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reply = page.locator('[data-message-role="assistant"]').last();
  const panel = page.getByRole('complementary', { name: 'Artifact', exact: true });

  async function chat(tag) {
    const response = await page.request.post(`${origin}/api/chats`);
    const { id } = await response.json();
    await page.goto(`${origin}/c/${id}`);
    const composer = page.getByPlaceholder('Ask anything');
    await composer.fill(`[qa:${tag}]`);
    await composer.press('Enter');
    await reply.getByRole('button', { name: 'Regenerate', exact: true }).waitFor({ timeout: 30_000 });
    return id;
  }

  async function open(index = 0) {
    await reply.getByRole('button', { name: /^Open / }).nth(index).click();
    await page.locator('iframe').waitFor();
  }

  async function check(name, run) {
    try { await run(); }
    catch (error) { step(name, false, error.message.split('\n')[0]); }
  }

  await check('handled editor Escape keeps the preview open', async () => {
    await chat('artifact-html');
    await open();
    const url = page.url();
    await reply.getByRole('button', { name: 'Edit code', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Edit html block', exact: true });
    await editor.press('Escape');
    await editor.waitFor({ state: 'hidden' });
    step('handled editor Escape keeps the preview open', page.url() === url && await panel.isVisible());
    await shot('editor-escape');
  });

  await check('an older branch preview survives reload', async () => {
    await chat('artifact-html');
    const firstId = await reply.getAttribute('data-message-id');
    await reply.getByRole('button', { name: 'Regenerate', exact: true }).click();
    const picker = reply.locator('[data-branch-picker]');
    await picker.getByText('2 / 2', { exact: true }).waitFor();
    await picker.getByRole('button', { name: 'Previous', exact: true }).click();
    await picker.getByText('1 / 2', { exact: true }).waitFor();
    await open();
    const url = page.url();
    await page.reload();
    await reply.getByRole('button', { name: 'Regenerate', exact: true }).waitFor();
    const visible = await page.locator('iframe').waitFor({ timeout: 3000 }).then(() => true, () => false);
    step('an older branch preview survives reload', visible && await reply.getAttribute('data-message-id') === firstId && page.url() === url);
    await shot('older-branch');
  });

  await check('editing an earlier block keeps the selected preview', async () => {
    await chat('artifact-multiple');
    await open(1);
    await page.frameLocator('iframe').getByRole('heading', { name: 'Second artifact', exact: true }).waitFor();
    await reply.getByRole('button', { name: 'Edit code', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: 'Edit html block', exact: true });
    // The fixture puts the third block 38 characters after the second, so this growth moves the second onto the third's old offset.
    await editor.fill((await editor.inputValue()).replace('First artifact', 'First artifact' + 'x'.repeat(38)));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    const visible = await page.locator('iframe').waitFor({ timeout: 3000 }).then(() => true, () => false);
    const heading = visible && await page.frameLocator('iframe').getByRole('heading', { name: 'Second artifact', exact: true }).isVisible();
    step('editing an earlier block keeps the selected preview', heading);
    if (heading) {
      await page.reload();
      await page.frameLocator('iframe').getByRole('heading', { name: 'Second artifact', exact: true }).waitFor({ timeout: 5000 });
      step('the moved preview survives reload', true);
      await reply.getByRole('button', { name: 'Edit code', exact: true }).first().click();
      const shorter = page.getByRole('textbox', { name: 'Edit html block', exact: true });
      await shorter.fill('<h1>F</h1>');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await shorter.waitFor({ state: 'hidden' });
      await page.frameLocator('iframe').getByRole('heading', { name: 'Second artifact', exact: true }).waitFor({ timeout: 5000 });
      step('shrinking an earlier block keeps the selected preview', true);
      await reply.getByRole('button', { name: 'Edit code', exact: true }).nth(1).click();
      const later = page.getByRole('textbox', { name: 'Edit html block', exact: true });
      await later.fill((await later.inputValue()).replace('Second artifact', 'Second edited'));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await later.waitFor({ state: 'hidden' });
      await page.frameLocator('iframe').getByRole('heading', { name: 'Second edited', exact: true }).waitFor({ timeout: 5000 });
      step('the earlier block keeps its shortened code', (await reply.getByRole('button', { name: 'Open F', exact: true }).count()) === 1);
      await page.reload();
      await page.frameLocator('iframe').getByRole('heading', { name: 'Second edited', exact: true }).waitFor({ timeout: 5000 });
      step('the shortened preview survives reload', true);
    }
    await shot('earlier-edit');
  });

  await check('preview reload keeps later turns on its saved branch', async () => {
    await chat('artifact-html');
    const composer = page.getByPlaceholder('Ask anything');
    await composer.fill('[qa:artifact-svg]');
    await composer.press('Enter');
    await page.locator('[data-message-role="assistant"]').nth(1).waitFor();
    await reply.getByRole('button', { name: 'Regenerate', exact: true }).waitFor();
    await page.locator('[data-message-role="assistant"]').first().getByRole('button', { name: /^Open / }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Artifact HTML', exact: true }).waitFor();
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Artifact HTML', exact: true }).waitFor({ timeout: 5000 });
    step('preview reload keeps later turns on its saved branch', await page.locator('[data-message-role="assistant"]').count() === 2);
  });

  await check('TSX downloads preserve their extension and source', async () => {
    await chat('artifact-tsx');
    await open();
    await page.frameLocator('iframe').getByRole('button', { name: 'Typed button', exact: true }).waitFor({ timeout: 30_000 });
    const event = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await event;
    const stream = await download.createReadStream();
    let source = '';
    for await (const chunk of stream) source += chunk.toString();
    step('TSX downloads preserve their extension and source', download.suggestedFilename() === 'typed.tsx' && source.includes('type Label'), download.suggestedFilename());
    await shot('tsx-download');
  });

  await check('tabs support arrow keys and a single tab stop', async () => {
    await chat('artifact-html');
    await open();
    const preview = panel.getByRole('tab', { name: 'Preview', exact: true });
    const code = panel.getByRole('tab', { name: 'Code', exact: true });
    await preview.focus();
    await preview.press('ArrowRight');
    const right = await code.getAttribute('aria-selected') === 'true' && await code.evaluate(node => node === document.activeElement);
    await code.press('ArrowLeft');
    const left = await preview.getAttribute('aria-selected') === 'true' && await preview.evaluate(node => node === document.activeElement);
    const oneStop = await preview.evaluate(node => node.tabIndex === 0) && await code.evaluate(node => node.tabIndex === -1);
    step('tabs support arrow keys and a single tab stop', right && left && oneStop);
    await shot('keyboard-tabs');
  });

  await check('long runtime errors show fades at their hidden edges', async () => {
    await chat('artifact-long-error');
    await open();
    const alert = panel.getByRole('alert').filter({ hasText: 'Error line 1' });
    await alert.waitFor();
    async function state(scrollToEnd) {
      return alert.evaluate(async (node, end) => {
        const nodes = [node, ...node.querySelectorAll('div')];
        const scroller = nodes.find(el => el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
        if (!scroller) return { scrolls: false, fade: false };
        if (end) {
          scroller.scrollTop = scroller.scrollHeight;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished));
        const fade = nodes.some(el => getComputedStyle(el).backgroundImage.includes('linear-gradient') && Number(getComputedStyle(el).opacity) > 0.99);
        return { scrolls: true, fade };
      }, scrollToEnd);
    }
    const start = await state(false);
    const end = await state(true);
    step('long runtime errors show fades at their hidden edges', start.scrolls && start.fade && end.fade, JSON.stringify({ start, end }));
    await shot('error-fades');
  });

  await check('phone Fix reveals and focuses the filled composer', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chat('artifact-error');
    await open();
    const dialog = page.getByRole('dialog');
    const alert = dialog.getByRole('alert').filter({ hasText: 'Artifact exploded' });
    await alert.waitFor();
    await dialog.getByRole('button', { name: 'Fix', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    const composer = page.getByPlaceholder('Ask anything');
    await page.waitForFunction(() => document.activeElement?.getAttribute('placeholder') === 'Ask anything', null, { timeout: 3000 });
    step('phone Fix reveals and focuses the filled composer', !await dialog.isVisible() && await composer.isVisible() && await composer.evaluate(node => node === document.activeElement) && (await composer.inputValue()).includes('Artifact exploded'));
    await shot('phone-fix');
    await page.setViewportSize({ width: 1440, height: 900 });
  });
}
