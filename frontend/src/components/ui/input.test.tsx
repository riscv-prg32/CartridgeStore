import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { Field } from "./input";

test("associates a generated control id with its label and error", async () => {
  const user = userEvent.setup();
  render(<Field label="Email" error="Enter a valid email address." />);

  const input = screen.getByRole("textbox", { name: "Email" });
  expect(input).toHaveAttribute("id");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-errormessage", `${input.id}-error`);
  expect(input).toHaveAccessibleDescription("Enter a valid email address.");

  await user.type(input, "person@example.test");
  expect(input).toHaveValue("person@example.test");
});
