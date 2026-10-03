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
    anchorDomain: "testanchor.stellar.org",
    account: null,
    customerId: "cus_1",
    status: "NEEDS_INFO",
    requiredFields: [
      { name: "first_name", type: "string", optional: false },
      { name: "photo_id_front", type: "binary", optional: false },
      { name: "photo_id_back", type: "binary", optional: true },
    ],
    providedFields: { first_name: "Ada" },
    providedFieldStatus: [],
    sentFields: [],
    message: null,
    lastSyncedAt: 1,
    updatedAt: 1,
  };

  async function harness(
    scopes: ApiKeyScope[],
    statusRecord = kycStatusRecord,
    consentedFields: string[] | null = ["photo_id_front", "photo_id_back"],
  ) {
    const container = await createTestContainer();
    const submittedFiles: KycUploadFile[][] = [];
    const seen: AnchorCustomer[] = [];

    const withKyc = {
      ...container,
      kycConsents: {
        ...container.kycConsents,
        async active(sellerId: string, anchorDomain: string) {
          if (!consentedFields) return null;
          return {
            id: "consent_1",
            sellerId,
            anchorDomain,
            fields: consentedFields,
            grantedAt: 1,
            revokedAt: null,
            grantedVia: "session",
            noticeVersion: "1.0",
          };
        },
      },
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

    const sessionToken = await container.tokenFor(seller.id, seller.wallet);

    return { app, container: container as TestContainer, key: plaintext, sessionToken, seller, submittedFiles, seen };
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

  it("refuses API-key auth: ID photos are session-only", async () => {
    const { app, container, key, submittedFiles } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["fake-image-bytes"], { type: "image/jpeg" }), "id.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}` },
      body: formData,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      message: "file uploads require session authentication",
    });
    expect(submittedFiles).toEqual([]);
    container.client.close();
  });

  it("refuses empty body or no files", async () => {
    const { app, container, sessionToken } = await harness(["offramp:initiate"]);
    const formData = new FormData();

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_files" });
    container.client.close();
  });

  it("refuses unrequested field name", async () => {
    const { app, container, sessionToken } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("unrequested_secret_doc", new Blob(["bytes"], { type: "image/jpeg" }), "doc.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unrequested_field", field: "unrequested_secret_doc" });
    container.client.close();
  });

  it("refuses disallowed MIME type", async () => {
    const { app, container, sessionToken } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["malicious-script"], { type: "text/html" }), "id.html");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_mime_type", field: "photo_id_front" });
    container.client.close();
  });

  it("successfully streams valid files (jpeg/png/pdf) straight into submitFiles", async () => {
    const { app, container, sessionToken, seller, submittedFiles, seen } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["fake-front-jpeg"], { type: "image/jpeg" }), "front.jpg");
    formData.append("photo_id_back", new Blob(["fake-back-png"], { type: "image/png" }), "back.png");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as KycRecord;
    expect(body.status).toBe("PROCESSING");
    // nothing about the uploaded bytes or names comes back out
    expect(JSON.stringify(body)).not.toContain("fake-front-jpeg");
    expect(JSON.stringify(body)).not.toContain("front.jpg");
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

  it("refuses upload with 403 consent_required when the seller has not consented", async () => {
    const { app, container, sessionToken, submittedFiles } = await harness(["offramp:initiate"], kycStatusRecord, null);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["fake-front-jpeg"], { type: "image/jpeg" }), "front.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "consent_required",
      anchorDomain: "testanchor.stellar.org",
      fields: ["photo_id_front"],
    });
    expect(submittedFiles).toEqual([]);
    container.client.close();
  });

  it("refuses upload of a binary field the consent does not cover", async () => {
    const { app, container, sessionToken, submittedFiles } = await harness(["offramp:initiate"], kycStatusRecord, [
      "photo_id_front",
    ]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["front"], { type: "image/jpeg" }), "front.jpg");
    formData.append("photo_id_back", new Blob(["back"], { type: "image/png" }), "back.png");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "consent_required", fields: ["photo_id_back"] });
    expect(submittedFiles).toEqual([]);
    container.client.close();
  });

  it("refuses more than one file for the same binary field", async () => {
    const { app, container, sessionToken, submittedFiles } = await harness(["offramp:initiate"]);
    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["first"], { type: "image/jpeg" }), "a.jpg");
    formData.append("photo_id_front", new Blob(["second"], { type: "image/jpeg" }), "b.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_files", field: "photo_id_front" });
    expect(submittedFiles).toEqual([]);
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
    const sessionToken = await container.tokenFor(container.seller.id, container.seller.wallet);

    const formData = new FormData();
    formData.append("photo_id_front", new Blob(["bytes"], { type: "image/jpeg" }), "id.jpg");

    const res = await app.request("/files", {
      method: "PUT",
      headers: { authorization: `Bearer ${sessionToken}` },
      body: formData,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "anchor_auth_required" });
    container.client.close();
  });
});
