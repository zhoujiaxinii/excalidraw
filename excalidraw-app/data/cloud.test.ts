import { describe, expect, it, vi } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  getRealtimeTopic,
  getRoomAccessToken,
  parseCloudFilePrefix,
} from "./cloud";

describe("cloud capability helpers", () => {
  it("separates storage and realtime capabilities and room scopes", async () => {
    const id = "0123456789abcdef0123";
    const key = "abcdefghijklmnopqrstuv";
    const token = await getRoomAccessToken("rooms", id, key);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await getRoomAccessToken("rooms", id, key)).toBe(token);
    expect(await getRoomAccessToken("shareLinks", id, key)).not.toBe(token);
    expect(
      await getRoomAccessToken("rooms", "1123456789abcdef0123", key),
    ).not.toBe(token);
    expect(await getRealtimeTopic(id, key)).not.toBe(`room:${token}`);
  });

  it("roundtrips binary buffers without call-stack overflow", () => {
    const data = Uint8Array.from({ length: 100000 }, (_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
  });

  it("rejects non-room paths and traversal", () => {
    expect(parseCloudFilePrefix("/files/rooms/0123456789abcdef0123")).toEqual({
      kind: "rooms",
      id: "0123456789abcdef0123",
    });
    expect(() => parseCloudFilePrefix("/files/rooms/../../secret")).toThrow();
    expect(() =>
      parseCloudFilePrefix("/migrations/files/0123456789abcdef0123"),
    ).toThrow();
  });
});

describe("cloud region routing", () => {
  it("sends the configured database-region hint on storage requests", async () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_APP_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_synthetic");
    vi.stubEnv("VITE_APP_SUPABASE_REGION", "ap-southeast-1");
    const fetcher = vi.fn(
      async (_url: string, _options: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      vi.resetModules();
      const { cloudRequest } = await import("./cloud");
      await cloudRequest(
        "rooms",
        "0123456789abcdef0123",
        "synthetic-key",
        "/rooms/0123456789abcdef0123",
      );
      const options = fetcher.mock.calls[0][1] as RequestInit;
      expect(new Headers(options.headers).get("x-region")).toBe(
        "ap-southeast-1",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
