import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LoginPanel } from "./LoginPanel";

const replace = vi.fn();
let searchParams = new URLSearchParams("return_to=%2Fdashboard%2Faccount");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}));

function renderPanel(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><LoginPanel enabled={enabled} /></QueryClientProvider>);
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const anonymous = {
  id: null,
  name: "Anonymous",
  username: "",
  email: "",
  role: "reader",
  groups: [],
  authenticated: false,
  permissions: [],
};

describe("LoginPanel", () => {
  beforeEach(() => {
    replace.mockReset();
    searchParams = new URLSearchParams("return_to=%2Fdashboard%2Faccount");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return Promise.resolve(response({ ok: false, error: "login required", user: anonymous }, 401));
      if (url.endsWith("/api/auth/providers")) return Promise.resolve(response({ ok: true, providers: [] }));
      return Promise.resolve(response({ ok: false, error: "unexpected request" }, 500));
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  test("renders a disabled notice without contacting a backend when opt-in is off", () => {
    renderPanel(false);

    expect(screen.getByRole("heading", { name: "Authentication is disabled" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("renders mixed enabled providers and omits disabled providers", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return Promise.resolve(response({ ok: false, error: "login required", user: anonymous }, 401));
      if (url.endsWith("/api/auth/providers")) return Promise.resolve(response({ ok: true, providers: [
        { provider_id: "campus", protocol: "oidc", display_name: "Campus SSO", enabled: true },
        { provider_id: "legacy", protocol: "saml", display_name: "Legacy SSO", enabled: false },
        { provider_id: "research", protocol: "saml", display_name: "Research SSO", enabled: true },
      ] }));
      return Promise.resolve(response({ ok: false, error: "unexpected request" }, 500));
    }));

    renderPanel();

    expect(await screen.findByRole("link", { name: /Campus SSO/ })).toHaveAttribute("href", "/api/auth/oidc/campus/login?return_to=%2Fdashboard%2Faccount");
    expect(screen.getByRole("link", { name: /Research SSO/ })).toHaveAttribute("href", "/api/auth/saml/research/login?return_to=%2Fdashboard%2Faccount");
    expect(screen.queryByRole("link", { name: /Legacy SSO/ })).not.toBeInTheDocument();
  });

  test("keeps local login available when provider discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return Promise.resolve(response({ ok: false, error: "login required", user: anonymous }, 401));
      if (url.endsWith("/api/auth/providers")) return Promise.reject(new TypeError("network down"));
      return Promise.resolve(response({ ok: false, error: "unexpected request" }, 500));
    }));

    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("Local sign-in remains available");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  test("refreshes the session and navigates after local login", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return Promise.resolve(response({ ok: false, error: "login required", user: anonymous }, 401));
      if (url.endsWith("/api/auth/providers")) return Promise.resolve(response({ ok: true, providers: [] }));
      if (url.endsWith("/auth/csrf")) return Promise.resolve(response({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }));
      if (url.endsWith("/auth/login")) return Promise.resolve(response({ ok: true, user: { ...anonymous, id: 7, username: "ada", authenticated: true } }));
      return Promise.resolve(response({ ok: false, error: "unexpected request" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    await user.type(await screen.findByLabelText("Username or email"), "ada");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard/account"));
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/auth/csrf"))).toBe(true);
  });

  test("navigates to the dashboard when no return path is requested", async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return Promise.resolve(response({ ok: false, error: "login required", user: anonymous }, 401));
      if (url.endsWith("/api/auth/providers")) return Promise.resolve(response({ ok: true, providers: [] }));
      if (url.endsWith("/auth/csrf")) return Promise.resolve(response({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }));
      if (url.endsWith("/auth/login")) return Promise.resolve(response({ ok: true, user: { ...anonymous, id: 7, username: "ada", authenticated: true } }));
      return Promise.resolve(response({ ok: false, error: "unexpected request" }, 500));
    }));

    renderPanel();
    await user.type(await screen.findByLabelText("Username or email"), "ada");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });

  test("shows invalid credentials without exposing backend details", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/me")) return Promise.resolve(response({ ok: false, error: "login required", user: anonymous }, 401));
      if (url.endsWith("/api/auth/providers")) return Promise.resolve(response({ ok: true, providers: [] }));
      if (url.endsWith("/auth/csrf")) return Promise.resolve(response({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }));
      if (url.endsWith("/auth/login")) return Promise.resolve(response({ ok: false, error: "invalid username or password", code: "internal_detail_should_not_render" }, 401));
      return Promise.resolve(response({ ok: false, error: "unexpected request" }, 500));
    }));

    renderPanel();
    await user.type(await screen.findByLabelText("Username or email"), "ada");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Username or password is incorrect.");
    expect(screen.queryByText("internal_detail_should_not_render")).not.toBeInTheDocument();
  });
});
