export default async function artifactsReal({ page, origin, step, shot }) {
  const { ORBIT_API_KEY, ORBIT_BASE_URL, ORBIT_MODEL } = process.env;
  if (!ORBIT_API_KEY || !ORBIT_BASE_URL || !ORBIT_MODEL) {
    throw new Error('ORBIT_API_KEY, ORBIT_BASE_URL and ORBIT_MODEL are required');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const settings = await page.request.put(`${origin}/api/settings`, {
    data: { baseUrl: ORBIT_BASE_URL, apiKey: ORBIT_API_KEY, model: ORBIT_MODEL, reasoningEffort: 'low' },
  });
  if (settings.status() !== 200) throw new Error(`provider settings returned ${settings.status()}`);
  step('real provider settings saved without printing credentials', true);
  const response = await page.request.post(`${origin}/api/chats`);
  const { id } = await response.json();
  await page.goto(`${origin}/c/${id}`);
  const composer = page.getByPlaceholder('Ask anything');
  await composer.fill('a small HTML page with a button that changes color');
  await composer.press('Enter');
  const reply = page.locator('[data-message-role="assistant"]').last();
  await reply.getByRole('button', { name: 'Regenerate', exact: true }).waitFor({ timeout: 180_000 });
  await reply.getByRole('button', { name: 'Preview', exact: true }).first().click();
  const frame = page.frameLocator('iframe').last();
  const button = frame.getByRole('button').first();
  await button.waitFor({ timeout: 15_000 });
  step('real provider HTML page opens in Preview', true);
  await button.hover();
  await button.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const color = await button.evaluate(node => {
    const style = getComputedStyle(node);
    return `${style.backgroundColor}|${style.color}`;
  });
  await button.click();
  await button.evaluate((node, before) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    function changed() {
      const style = getComputedStyle(node);
      if (`${style.backgroundColor}|${style.color}` !== before) resolve();
      else if (Date.now() > deadline) reject(new Error('button color did not change'));
      else requestAnimationFrame(changed);
    }
    changed();
  }), color);
  await button.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  const changed = await button.evaluate((node, before) => {
    const style = getComputedStyle(node);
    return `${style.backgroundColor}|${style.color}` !== before;
  }, color);
  step('real provider button changes color after a click', changed);
  if (!changed) throw new Error('button returned to its pre-click color');
  step('real provider frame uses only allow-scripts', await page.locator('iframe').last().getAttribute('sandbox') === 'allow-scripts');
  await shot('real-provider-clicked');
}
