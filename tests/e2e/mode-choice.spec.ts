import { expect, test } from "./e2e-fixture";

test.beforeEach(async ({ e2e }) => {
  await e2e.reset();
});

test("reaches cloud model choice through the mode screen", async ({ e2e }) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await options.getByRole("button", { name: "Start setup" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose how it runs" }),
  ).toBeVisible();

  await options.getByRole("button", { name: "Use Ollama Cloud" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a cloud model" }),
  ).toBeVisible();
  await expect(options.getByRole("option", { name: /gemma4:26b-cloud/ })).toBeEnabled();
});

test("keeps a cloud model unselectable in local mode", async ({ e2e }) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await options.getByRole("button", { name: "Start setup" }).click();
  await options.getByRole("button", { name: "Use this computer" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a local model" }),
  ).toBeVisible();

  await expect(
    options.getByRole("option", { name: /gemma4:26b-cloud/ }),
  ).toBeDisabled();
});

test("never claims the text stays on the machine while cloud mode is active", async ({
  e2e,
}) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await options.getByRole("button", { name: "Start setup" }).click();
  await options.getByRole("button", { name: "Use Ollama Cloud" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a cloud model" }),
  ).toBeVisible();

  await expect(options.getByText(/does not leave your machine/i)).toHaveCount(0);
});
