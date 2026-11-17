import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";

import { SelectField, SelectItem } from "./select";

describe("SelectField", () => {
  test("exposes a keyboard-accessible Radix select and reports the selected value", async () => {
    const user = userEvent.setup();
    let value = "qemu";

    render(
      <SelectField label="Architecture" name="architecture" value={value} onValueChange={(next) => { value = next; }}>
        <SelectItem value="qemu">qemu</SelectItem>
        <SelectItem value="esp32c6">esp32c6</SelectItem>
      </SelectField>,
    );

    const trigger = screen.getByRole("combobox", { name: "Architecture" });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "esp32c6" }));

    expect(value).toBe("esp32c6");
  });
});
