// Settings has more than one Save. These find the search and GitHub form and its Save.
export function settingsForm(page) {
  return page.locator("form").filter({ has: page.getByLabel("SearXNG URL", { exact: true }) });
}

export function settingsSave(page) {
  return settingsForm(page).getByRole("button", { name: "Save", exact: true });
}
