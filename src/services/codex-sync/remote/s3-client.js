import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

function hashBody(body) {
  return createHash("sha256").update(body).digest("hex");
}

function atomicWrite(filePath, body) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, body, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function buildConflictError(message) {
  const error = new Error(message);
  error.code = "REMOTE_CONFLICT";
  return error;
}

function buildRemoteError(message, code, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

function normalizeEtag(value) {
  if (!value || typeof value !== "string") return null;
  return value.replace(/^"+|"+$/g, "").trim() || null;
}

function formatEtagHeaderValue(value) {
  const normalized = normalizeEtag(value);
  if (!normalized) return null;
  return `"${normalized}"`;
}

function encodePathSegments(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeObjectKey(value) {
  const key = String(value || "").replace(/^\/+/, "");
  return key;
}

function hmac(key, data, encoding = null) {
  const h = createHmac("sha256", key).update(data, "utf8");
  return encoding ? h.digest(encoding) : h.digest();
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function toDateStamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function normalizeHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function canonicalizeQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([encodeURIComponent(key), encodeURIComponent(value)]);
  }
  pairs.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) return aValue.localeCompare(bValue);
    return aKey.localeCompare(bKey);
  });
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

export class S3InventoryClient {
  constructor(config) {
    this.config = config;
    this.mode = String(config?.mode || "file").toLowerCase();
    this.region = config?.region || "us-east-1";
    this.objectKey = normalizeObjectKey(config?.objectKey || "inventory/codex-accounts.json");
  }

  resolveEndpoint() {
    if (this.config.endpoint) {
      return new URL(this.config.endpoint);
    }
    return new URL(`https://s3.${this.region}.amazonaws.com`);
  }

  resolveObjectUrl() {
    const bucket = this.config.bucket;
    if (!bucket) {
      throw buildRemoteError("Missing CODEX_SYNC_S3_BUCKET for remote object storage", "REMOTE_CONFIG");
    }

    const endpoint = this.resolveEndpoint();
    const forcePathStyle = this.config.forcePathStyle || this.mode === "minio";
    const basePath =
      endpoint.pathname && endpoint.pathname !== "/" ? endpoint.pathname.replace(/\/+$/, "") : "";
    const encodedObjectKey = encodePathSegments(this.objectKey);

    if (forcePathStyle) {
      const pathname = `${basePath}/${encodeURIComponent(bucket)}/${encodedObjectKey}`.replace(
        /\/{2,}/g,
        "/",
      );
      const url = new URL(endpoint.toString());
      url.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
      return url;
    }

    const url = new URL(endpoint.toString());
    url.host = `${bucket}.${endpoint.host}`;
    url.pathname = `/${encodedObjectKey}`;
    return url;
  }

  buildSignedRequest({ method, url, body = "", extraHeaders = {} }) {
    const accessKeyId = this.config.accessKeyId;
    const secretAccessKey = this.config.secretAccessKey;
    const sessionToken = this.config.sessionToken;

    if (!accessKeyId || !secretAccessKey) {
      throw buildRemoteError(
        "Missing S3 credentials (CODEX_SYNC_S3_ACCESS_KEY_ID / CODEX_SYNC_S3_SECRET_ACCESS_KEY)",
        "REMOTE_AUTH",
      );
    }

    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = toDateStamp(now);
    const payloadHash = hashBody(body);

    const headers = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    if (sessionToken) {
      headers["x-amz-security-token"] = sessionToken;
    }

    for (const [key, value] of Object.entries(extraHeaders || {})) {
      if (value === undefined || value === null) continue;
      headers[String(key).toLowerCase()] = String(value);
    }

    const normalizedEntries = Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), normalizeHeaderValue(value)])
      .sort(([a], [b]) => a.localeCompare(b));

    const canonicalHeaders = normalizedEntries.map(([key, value]) => `${key}:${value}\n`).join("");
    const signedHeaders = normalizedEntries.map(([key]) => key).join(";");
    const canonicalQueryString = canonicalizeQuery(url.searchParams);

    const canonicalRequest = [
      method.toUpperCase(),
      url.pathname || "/",
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      hashBody(canonicalRequest),
    ].join("\n");

    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign, "hex");

    const authorization = [
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", ");

    return {
      headers: {
        ...Object.fromEntries(normalizedEntries),
        Authorization: authorization,
      },
      body,
    };
  }

  async requestS3({ method, body = "", allowNotFound = false, extraHeaders = {} }) {
    const url = this.resolveObjectUrl();
    const signed = this.buildSignedRequest({ method, url, body, extraHeaders });

    try {
      const response = await fetch(url, {
        method,
        headers: signed.headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      });

      if (allowNotFound && response.status === 404) {
        return {
          response,
          notFound: true,
          body: "",
        };
      }

      if (response.status === 401 || response.status === 403) {
        const detail = await response.text();
        throw buildRemoteError(
          `Remote auth failed (${response.status})${detail ? `: ${detail}` : ""}`,
          "REMOTE_AUTH",
          { statusCode: response.status },
        );
      }

      if (response.status === 408) {
        throw buildRemoteError("Remote timeout while talking to object storage", "REMOTE_TIMEOUT", {
          statusCode: response.status,
        });
      }

      if (response.status === 412) {
        throw buildConflictError("Remote object precondition failed");
      }

      if (!response.ok) {
        const detail = await response.text();
        throw buildRemoteError(
          `Remote request failed (${response.status})${detail ? `: ${detail}` : ""}`,
          "REMOTE_REQUEST_FAILED",
          { statusCode: response.status },
        );
      }

      const responseBody = method === "HEAD" ? "" : await response.text();
      return {
        response,
        notFound: false,
        body: responseBody,
      };
    } catch (error) {
      if (error?.code) {
        throw error;
      }

      const causeCode = error?.cause?.code || error?.code;
      if (
        causeCode === "ETIMEDOUT" ||
        causeCode === "ECONNRESET" ||
        causeCode === "ECONNREFUSED" ||
        causeCode === "ENOTFOUND" ||
        causeCode === "EAI_AGAIN" ||
        /timeout|timed out/i.test(error?.message || "")
      ) {
        throw buildRemoteError(error?.message || "Remote timeout", "REMOTE_TIMEOUT", {
          cause: error,
        });
      }

      throw buildRemoteError(error?.message || "Remote request failed", "REMOTE_REQUEST_FAILED", {
        cause: error,
      });
    }
  }

  async getObjectFromFile() {
    const filePath = this.config.localFilePath;
    if (!fs.existsSync(filePath)) {
      return {
        exists: false,
        etag: null,
        body: "",
      };
    }

    const body = fs.readFileSync(filePath, "utf8");
    return {
      exists: true,
      etag: hashBody(body),
      body,
    };
  }

  async getObjectFromS3() {
    const result = await this.requestS3({
      method: "GET",
      allowNotFound: true,
    });

    if (result.notFound) {
      return {
        exists: false,
        etag: null,
        body: "",
      };
    }

    return {
      exists: true,
      etag: normalizeEtag(result.response.headers.get("etag")),
      body: result.body,
    };
  }

  async putObjectToFile({ body, expectedEtag }) {
    const filePath = this.config.localFilePath;
    const exists = fs.existsSync(filePath);

    if (expectedEtag) {
      if (!exists) {
        throw buildConflictError("Remote object changed before upload");
      }
      const currentBody = fs.readFileSync(filePath, "utf8");
      const currentEtag = hashBody(currentBody);
      if (currentEtag !== expectedEtag) {
        throw buildConflictError("Remote object etag mismatch");
      }
    }

    atomicWrite(filePath, body);
    return {
      etag: hashBody(body),
    };
  }

  async putObjectToS3({ body, expectedEtag, expectedExists = true }) {
    const normalizedExpectedEtag = normalizeEtag(expectedEtag);
    let conditionalHeaders;

    if (expectedExists) {
      if (!normalizedExpectedEtag) {
        throw buildConflictError("Remote object etag missing for conditional update");
      }
      conditionalHeaders = {
        "if-match": formatEtagHeaderValue(normalizedExpectedEtag),
      };
    } else {
      conditionalHeaders = {
        "if-none-match": "*",
      };
    }

    const result = await this.requestS3({
      method: "PUT",
      body,
      extraHeaders: conditionalHeaders,
    });

    const responseEtag = normalizeEtag(result.response.headers.get("etag"));
    return {
      etag: responseEtag || hashBody(body),
    };
  }

  async getObject() {
    if (this.mode === "file") {
      return this.getObjectFromFile();
    }
    if (this.mode === "s3" || this.mode === "minio") {
      return this.getObjectFromS3();
    }
    throw buildRemoteError(
      `Unsupported CODEX_SYNC_REMOTE_MODE: ${this.mode}. Supported: file, s3, minio`,
      "REMOTE_CONFIG",
    );
  }

  async putObject({ body, expectedEtag, expectedExists = true }) {
    if (this.mode === "file") {
      return this.putObjectToFile({ body, expectedEtag });
    }
    if (this.mode === "s3" || this.mode === "minio") {
      return this.putObjectToS3({ body, expectedEtag, expectedExists });
    }
    throw buildRemoteError(
      `Unsupported CODEX_SYNC_REMOTE_MODE: ${this.mode}. Supported: file, s3, minio`,
      "REMOTE_CONFIG",
    );
  }
}
