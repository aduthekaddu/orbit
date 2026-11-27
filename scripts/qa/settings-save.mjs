export function githubForm(page) {
  return page.getByRole("form", { name: "GitHub", exact: true });
}

export function githubSave(page) {
  return githubForm(page).getByRole("button", { name: "Save", exact: true });
}

export function searchSave(page) {
  return page.getByRole("form", { name: "Search", exact: true }).getByRole("button", { name: "Save", exact: true });
}
