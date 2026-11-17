import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as authApi from "../../../lib/api/auth";
import * as adapter from "../../../lib/auth/webauthn-adapter";
import { PasskeysPanel } from "./PasskeysPanel";

const { startRegistration } = vi.hoisted(() => ({ startRegistration: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration }));

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><PasskeysPanel /></QueryClientProvider>);
}

describe("PasskeysPanel", () => {
  afterEach(() => { vi.restoreAllMocks(); startRegistration.mockReset(); });

  it("preserves the registration ceremony and adapter boundary", async () => {
    vi.spyOn(authApi, "getPasskeys").mockResolvedValue({ ok: true, credentials: [] });
    const reauthenticate = vi.spyOn(authApi, "reauthenticate").mockResolvedValue({ ok: true, message: "reauthenticated" });
    const begin = vi.spyOn(authApi, "beginPasskeyRegistration").mockResolvedValue({ ok: true, options: { challenge: "challenge" } });
    const adapt = vi.spyOn(adapter, "toRegistrationOptions").mockReturnValue({ challenge: "challenge", rp: { name: "PRG32" }, user: { id: "1", name: "ada", displayName: "Ada" }, pubKeyCredParams: [] });
    startRegistration.mockResolvedValue({ id: "credential" });
    const finish = vi.spyOn(authApi, "finishPasskeyRegistration").mockResolvedValue({ ok: true });
    renderPanel();
    await waitFor(() => expect(screen.getByText("No passkeys are registered.")).toBeInTheDocument());
    vi.spyOn(window, "prompt").mockReturnValueOnce("current-password").mockReturnValueOnce("MacBook");
    fireEvent.click(screen.getByRole("button", { name: "Add passkey" }));
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledWith("current-password"));
    expect(begin).toHaveBeenCalledOnce();
    expect(adapt).toHaveBeenCalledOnce();
    expect(startRegistration).toHaveBeenCalledOnce();
    await waitFor(() => expect(finish).toHaveBeenCalledWith({ id: "credential" }, "MacBook"));
  });
});
