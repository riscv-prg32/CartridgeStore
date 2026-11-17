import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";

import { removeSensitiveQueryData } from "./query-cache";

describe("authenticated query cache safety", () => {
  test("removes private domain data without clearing public catalog data", () => {
    const client = new QueryClient();
    client.setQueryData(["auth", "current-user"], { user: { username: "private" } });
    client.setQueryData(["auth", "tokens"], { tokens: [{ id: 1 }] });
    client.setQueryData(["workflow", "drafts"], { drafts: [{ id: "private" }] });
    client.setQueryData(["admin", "users", 1, ""], { users: [{ id: 1 }] });
    client.setQueryData(["federation", "status", "private"], { status: "enabled" });
    client.setQueryData(["metrics", "run", "private"], { run: { id: "private" } });
    client.setQueryData(["profile", "private"], { username: "private" });
    client.setQueryData(["catalog", "", 1, 100], { games: [] });

    removeSensitiveQueryData(client);

    expect(client.getQueryData(["auth", "current-user"])).toBeUndefined();
    expect(client.getQueryData(["auth", "tokens"])).toBeUndefined();
    expect(client.getQueryData(["workflow", "drafts"])).toBeUndefined();
    expect(client.getQueryData(["admin", "users", 1, ""])).toBeUndefined();
    expect(client.getQueryData(["federation", "status", "private"])).toBeUndefined();
    expect(client.getQueryData(["metrics", "run", "private"])).toBeUndefined();
    expect(client.getQueryData(["profile", "private"])).toBeUndefined();
    expect(client.getQueryData(["catalog", "", 1, 100])).toEqual({ games: [] });
  });

  test("does not retain a private response that resolves after cache removal", async () => {
    const client = new QueryClient();
    let resolveRequest!: (value: { run: { id: string } }) => void;
    const request = new Promise<{ run: { id: string } }>((resolve) => { resolveRequest = resolve; });
    const query = client.fetchQuery({ queryKey: ["metrics", "run", "in-flight"], queryFn: () => request });

    removeSensitiveQueryData(client);
    resolveRequest({ run: { id: "in-flight" } });
    await query.catch(() => undefined);

    expect(client.getQueryData(["metrics", "run", "in-flight"])).toBeUndefined();
  });
});
