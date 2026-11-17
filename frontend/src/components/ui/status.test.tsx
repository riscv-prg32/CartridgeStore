import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { StatusMessage } from "./status";

test("uses semantic status tones and an appropriate live-region role", () => {
  render(<StatusMessage tone="danger">The request failed.</StatusMessage>);

  const message = screen.getByRole("alert");
  expect(message).toHaveClass("bg-[var(--color-danger-soft)]");
  expect(message).toHaveClass("text-[var(--color-danger-foreground)]");
});

test("uses a polite status role for success feedback", () => {
  render(<StatusMessage tone="success">Saved.</StatusMessage>);
  expect(screen.getByRole("status")).toHaveClass("bg-[var(--color-success-soft)]");
});
