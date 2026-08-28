import { exportCsv } from "../lib/api";

test("exportCsv sends Authorization and credentials", async () => {
  Object.defineProperty(document, "cookie", { value: "session=tok" });
  (global.fetch as any) = jest.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["x"]),
  }));
  await exportCsv({});
  const init = (fetch as any).mock.calls[0][1];
  expect(new Headers(init.headers).get("Authorization")).toBe(\"Bearer tok\");
  expect(init.credentials).toBe("include");
});
