import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as authApi from "../../../lib/api/auth";
import * as adapter from "../../../lib/auth/webauthn-adapter";
import { PasskeyLogin } from "./PasskeyLogin";

const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
const replace = vi.fn();

vi.mock("@simplewebauthn/browser", () => ({ startAuthentication }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

function renderControl() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><PasskeyLogin returnTo="/dashboard/account" username="ada" /></QueryClientProvider>);
}

describe("PasskeyLogin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    startAuthentication.mockReset();
    replace.mockReset();
  });

  test("keeps the targeted WebAuthn ceremony and session transition", async () => {
    const user = userEvent.setup();
    const begin = vi.spyOn(authApi, "beginPasskeyLogin").mockResolvedValue({ ok: true, options: { challenge: "challenge" } });
    vi.spyOn(adapter, "toAuthenticationOptions").mockReturnValue({ challenge: "challenge" });
    startAuthentication.mockResolvedValue({ id: "credential" });
    const finish = vi.spyOn(authApi, "finishPasskeyLogin").mockResolvedValue({ ok: true, user: { id: 1, name: "Ada", username: "ada", email: "ada@example.test", role: "reader", groups: [], authenticated: true, permissions: [] } });

    renderControl();
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));

    await waitFor(() => expect(finish).toHaveBeenCalledWith({ id: "credential" }));
    expect(begin).toHaveBeenCalledWith("ada");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard/account"));
  });

  test("reports browser cancellation without exposing exception details", async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, "beginPasskeyLogin").mockResolvedValue({ ok: true, options: { challenge: "challenge" } });
    vi.spyOn(adapter, "toAuthenticationOptions").mockReturnValue({ challenge: "challenge" });
    startAuthentication.mockRejectedValue(new DOMException("native detail", "NotAllowedError"));

    renderControl();
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Passkey sign-in was cancelled.");
    expect(screen.queryByText("native detail")).not.toBeInTheDocument();
  });
});
