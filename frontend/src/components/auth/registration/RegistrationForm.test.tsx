import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as authApi from "../../../lib/api/auth";
import { RegistrationForm } from "./RegistrationForm";

const replace = vi.fn();

vi.mock("../../../lib/auth/config", () => ({ authIntegrationEnabled: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

describe("RegistrationForm", () => {
  function renderForm(complete: boolean, initialToken: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={queryClient}><RegistrationForm complete={complete} initialToken={initialToken} /></QueryClientProvider>);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    replace.mockReset();
  });

  test("submits the local registration contract and shows the confirmation state", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(authApi, "requestRegistration").mockResolvedValue({ ok: true, email: "ada@example.test", message: "Check your email" });
    renderForm(false, "");

    await user.type(screen.getByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.type(screen.getByLabelText("Confirm password"), "secret");
    await user.click(screen.getByRole("button", { name: "Request verification email" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("ada", "ada@example.test", "secret", "secret"));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText(/ada@example.test/)).toBeInTheDocument();
  });

  test("preserves completion token, password contract and navigation", async () => {
    const user = userEvent.setup();
    const complete = vi.spyOn(authApi, "completeRegistration").mockResolvedValue({ ok: true, user: { id: 1, name: "Ada", username: "ada", email: "ada@example.test", role: "reader", groups: [], authenticated: true, permissions: [] } });
    renderForm(true, "token-from-link");

    expect(screen.getByLabelText("Registration token")).toHaveValue("token-from-link");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.type(screen.getByLabelText("Confirm password"), "secret");
    await user.click(screen.getByRole("button", { name: "Complete registration" }));

    await waitFor(() => expect(complete).toHaveBeenCalledWith("token-from-link", "secret", "secret"));
    expect(replace).toHaveBeenCalledWith("/dashboard/account");
  });
});
