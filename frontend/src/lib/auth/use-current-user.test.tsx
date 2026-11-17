import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useCurrentUser } from "./use-current-user";

function wrapper({ children }: Readonly<{ children: React.ReactNode }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function wrapperFor(client: QueryClient) {
  return function QueryClientWrapper({ children }: Readonly<{ children: React.ReactNode }>) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const anonymous = {
  id: null,
  name: "Anonymous",
  username: "",
  email: "",
  role: "reader",
  groups: [],
  authenticated: false,
};

describe("useCurrentUser", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  test("distinguishes anonymous 401 from a backend failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "login required", user: anonymous }), { status: 401 }));
    const anonymousResult = renderHook(() => useCurrentUser(true), { wrapper });
    await waitFor(() => expect(anonymousResult.result.current.isSuccess).toBe(true));
    expect(anonymousResult.result.current.user).toBeNull();
    anonymousResult.unmount();

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("backend unavailable"));
    const failureResult = renderHook(() => useCurrentUser(true), { wrapper });
    await waitFor(() => expect(failureResult.result.current.isError).toBe(true));
    expect(failureResult.result.current.user).toBeNull();
  });

  test("exposes an authenticated backend user without client-side role inference", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, user: { ...anonymous, id: 9, username: "ada", authenticated: true, role: "admin", permissions: ["users:read"] } }), { status: 200 }));
    const result = renderHook(() => useCurrentUser(true), { wrapper });
    await waitFor(() => expect(result.result.current.isSuccess).toBe(true));
    expect(result.result.current.user).toMatchObject({ username: "ada", role: "admin" });
  });

  test("removes private cache data when an authenticated query becomes anonymous", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["auth", "tokens"], { tokens: [{ id: 1 }] });
    client.setQueryData(["workflow", "drafts"], { drafts: [{ id: "private" }] });
    client.setQueryData(["catalog", "", 1, 100], { games: [{ id: "public" }] });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "login required", user: anonymous }), { status: 401 }));

    const result = renderHook(() => useCurrentUser(true), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.result.current.isSuccess).toBe(true));

    expect(client.getQueryData(["auth", "tokens"])).toBeUndefined();
    expect(client.getQueryData(["workflow", "drafts"])).toBeUndefined();
    expect(client.getQueryData(["catalog", "", 1, 100])).toEqual({ games: [{ id: "public" }] });
  });
});
