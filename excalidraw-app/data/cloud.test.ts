import { describe, expect, it } from "vitest";

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
