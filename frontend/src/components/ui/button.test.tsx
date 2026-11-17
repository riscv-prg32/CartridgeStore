import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { Button } from "./button";

test("renders an accessible button and forwards interaction", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();

  render(<Button onClick={onClick}>Continue</Button>);
  await user.click(screen.getByRole("button", { name: "Continue" }));

  expect(onClick).toHaveBeenCalledOnce();
});

test("uses the semantic danger variant", () => {
  render(<Button variant="danger">Delete</Button>);
  expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-[var(--color-danger)]");
});

test("communicates loading state and disables interaction", () => {
  render(<Button loading>Saving</Button>);
  expect(screen.getByRole("button", { name: "Saving" })).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
});
