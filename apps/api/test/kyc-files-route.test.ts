import { describe, expect, it, vi } from "vitest";
import { kycRoutes } from "../src/routes/kyc";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";
import {
  AnchorAuthRequiredError,
  type AnchorCustomer,
  type KycRecord,
  type KycUploadFile,
} from "@checkout/core";

describe("kycRoutes — PUT /files multipart binary uploads", () => {
  const kycStatusRecord: KycRecord = {
    sellerId: "sel_x",
    account: null,
    customerId: "cus_1",
    status: "NEEDS_INFO",
    requiredFields: [
      { name: "first_name", type: "string", optional: false },
      { name: "photo_id_front", type: "binary", optional: false },
      { name: "photo_id_back", type: "binary", optional: true },
    ],
    providedFields: { first_name: "Ada" },
    message: null,
    lastSyncedAt: 1,
    updatedAt: 1,
  };

  async function harness(scopes: ApiKeyScope[], statusRecord = kycStatusRecord) {
    const container = await createTestContainer();
    const submittedFiles: KycUploadFile[][] = [];
    const seen: AnchorCustomer[] = [];

    const withKyc = {
      ...container,
      kyc: {
        async status(customer: AnchorCustomer) {
          seen.push(customer);
          return statusRecord;
        },
        async submit(customer: AnchorCustomer, fields: Record<string, string>) {
          seen.push(customer);
          return statusRecord;
        },
        async submitFiles(customer: AnchorCustomer, files: KycUploadFile[]) {
          seen.push(customer);
          submittedFiles.push(files);
          return {
            ...statusRecord,
            status: "PROCESSING",
          };
        },
      },
    } as unknown as Container;

    const app = kycRoutes(withKyc);

    const { plaintext, prefix } = generateApiKey("test");
    const seller = container.seller;
    await container.apiKeys.create({
      sellerId: seller.id,
      name: "kyc files test key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes,
    });

    return { app, container: container as TestContainer, key: plaintext, seller, submittedFiles, seen };
  }

  it("refuses unauthenticated file upload", async () => {
    const { app, container, submittedFiles } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["fake-image-bytes"], { type: "image/jpeg" }), "id.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      body: formData,
    });

    expect(res.status).toBe(401);
    expect(submittedFiles).toEqual([]);
    container.client.close();
  });

  it("refuses upload if key lacks offramp:initiate scope", async () => {
    const { app, container, key, submittedFiles } = await harness(["links:read", "links:write"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["fake-image-bytes"], { type: "image/jpeg" }), "id.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      body: formData,
    });

    expect(res.status).toBe(403);
    expect(submittedFiles).toEqual([]);
    container.client.close();
  });

  it("refuses empty body or no files", async () => {
    const { app, container, key } = await harness(["offramp:initiate"]);
    const formData = new FormData();

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_files" });
    container.client.close();
  });

  it("refuses unrequested field name", async () => {
    const { app, container, key } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("unrequested_secret_doc", new Blob(["bytes"], { type: "image/jpeg" }), "doc.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unrequested_field", field: "unrequested_secret_doc" });
    container.client.close();
  });

  it("refuses disallowed MIME type", async () => {
    const { app, container, key } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["malicious-script"], { type: "text/html" }), "id.html");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_mime_type", field: "photo_id_front" });
    container.client.close();
  });

  it("successfully streams valid files (jpeg/png/pdf) straight into submitFiles", async () => {
    const { app, container, key, seller, submittedFiles, seen } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["fake-front-jpeg"], { type: "image/jpeg" }), "front.jpg");
    formData.append("photo_id_back", new Blob(["fake-back-png"], { type: "image/png" }), "back.png");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      body: formData,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as KycRecord;
    expect(body.status).toBe("PROCESSING");
    expect(submittedFiles.length).toBe(1);
    const files = submittedFiles[0]!;
    expect(files.length).toBe(2);
    expect(files[0]!.name).toBe("photo_id_front");
    expect(files[0]!.filename).toBe("front.jpg");
    expect(files[1]!.name).toBe("photo_id_back");
    expect(files[1]!.filename).toBe("back.png");
    expect(seen).toContainEqual({ sellerId: seller.id, account: seller.wallet });
    container.client.close();
  });

  it("answers 403 anchor_auth_required when anchor session is missing", async () => {
    const container = await createTestContainer();
    const signedOut = {
      async status() {
        throw new AnchorAuthRequiredError("anchor.example");
      },
      async submit() {
        throw new AnchorAuthRequiredError("anchor.example");
      },
      async submitFiles() {
        throw new AnchorAuthRequiredError("anchor.example");
      },
    };
    const app = kycRoutes({ ...container, kyc: signedOut } as unknown as Container);
    const { plaintext, prefix } = generateApiKey("test");
    await container.apiKeys.create({
      sellerId: container.seller.id,
      name: "kyc test key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes: ["offramp:initiate"],
    });

    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["bytes"], { type: "image/jpeg" }), "id.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${plaintext}` },
      body: formData,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "anchor_auth_required" });
    container.client.close();
  });
});
