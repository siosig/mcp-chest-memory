// Gemini Batch Embedding API client.
// @google/genai is loaded via dynamic import so the MCP server start-up path never
// touches it — only type-level imports are used at the top of this file to avoid
// pulling in native dependencies eagerly.

import type { BatchJob } from "@google/genai";

// --- public types ---
export type SubmitResult = {
  /** Gemini Batch job name (`batches/xxx`) */
  jobName: string;
};

export type FetchResult =
  | { state: "pending" | "running" }
  | { state: "succeeded"; vectors: number[][] }
  | { state: "failed"; errorKind: "transient" | "permanent"; errorReason: string }
  | { state: "expired"; errorKind: "permanent"; errorReason: string }
  | { state: "cancelled"; errorKind: "permanent"; errorReason: string };

export type ApiErrorKind = "transient" | "permanent";

export class ApiError extends Error {
  constructor(
    public kind: ApiErrorKind,
    public httpStatus: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface GeminiBatchClient {
  /**
   * Submit a batch (inlinedRequests path, assumed <20 MB total).
   * @throws ApiError on network / auth / 4xx / 5xx errors
   */
  submit(
    texts: string[],
    opts?: {
      displayName?: string;
      taskType?: "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";
    },
  ): Promise<SubmitResult>;

  /**
   * Poll batch status. On success, returns L2-normalised 768-dim vectors
   * in the same order as the texts passed to submit (Gemini inlined spec).
   */
  fetch(jobName: string): Promise<FetchResult>;
}

// --- helpers ---
export function l2norm(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n === 0 ? v : v.map((x) => x / n);
}

// --- Production implementation ---
export class ProductionGeminiBatchClient implements GeminiBatchClient {
  // Lazily initialised SDK instance (typed as any because the official types are deeply nested).
  private ai: any = undefined;
  private model = "gemini-embedding-001";
  private dim = 768;

  private async ensureAi(): Promise<any> {
    if (this.ai) return this.ai;
    const mod: any = await import("@google/genai");
    const GoogleGenAI = mod.GoogleGenAI;
    this.ai = new GoogleGenAI({});
    return this.ai;
  }

  async submit(
    texts: string[],
    opts: {
      displayName?: string;
      taskType?: "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";
    } = {},
  ): Promise<SubmitResult> {
    const ai = await this.ensureAi();
    // SDK EmbeddingsBatchJobSource.inlinedRequests is a single EmbedContentBatch object:
    // contents holds all texts as one array; config sets outputDimensionality and taskType
    // shared across all requests.
    const inlinedRequests = {
      contents: texts.map((text) => ({ parts: [{ text }] })),
      config: {
        outputDimensionality: this.dim,
        taskType: opts.taskType ?? "RETRIEVAL_DOCUMENT",
      },
    } as any;
    try {
      const job: BatchJob = await ai.batches.createEmbeddings({
        model: this.model,
        src: { inlinedRequests },
        config: { displayName: opts.displayName ?? "chest-embed-batch" },
      });
      if (!job.name) {
        throw new ApiError("permanent", undefined, "batch job name missing");
      }
      return { jobName: job.name };
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      throw this.classify(e);
    }
  }

  async fetch(jobName: string): Promise<FetchResult> {
    const ai = await this.ensureAi();
    let job: BatchJob;
    try {
      job = await ai.batches.get({ name: jobName });
    } catch (e: any) {
      throw this.classify(e);
    }
    switch (job.state) {
      case "JOB_STATE_PENDING":
        return { state: "pending" };
      case "JOB_STATE_RUNNING":
        return { state: "running" };
      case "JOB_STATE_SUCCEEDED": {
        const responses =
          (job as any).dest?.inlinedEmbedContentResponses ?? [];
        const vectors = responses.map((r: any) => {
          // InlinedEmbedContentResponse.response is a SingleEmbedContentResponse;
          // the vector lives at r.response.embedding.values.
          if (r.error || !r.response?.embedding?.values) {
            throw new ApiError(
              "permanent",
              undefined,
              `per-record error: ${JSON.stringify(r.error)}`,
            );
          }
          return l2norm(r.response.embedding.values);
        });
        return { state: "succeeded", vectors };
      }
      case "JOB_STATE_FAILED":
        return {
          state: "failed",
          errorKind: "transient",
          errorReason: JSON.stringify((job as any).error),
        };
      case "JOB_STATE_EXPIRED":
        return {
          state: "expired",
          errorKind: "permanent",
          errorReason: "job expired (48h)",
        };
      case "JOB_STATE_CANCELLED":
        return {
          state: "cancelled",
          errorKind: "permanent",
          errorReason: "job cancelled",
        };
      default:
        throw new ApiError(
          "permanent",
          undefined,
          `unknown state: ${String(job.state)}`,
        );
    }
  }

  private classify(e: any): ApiError {
    const status: number | undefined = e?.status ?? e?.code;
    if (typeof status === "number") {
      if (status === 429 || (status >= 500 && status < 600)) {
        return new ApiError(
          "transient",
          status,
          e?.message ?? "transient error",
        );
      }
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        return new ApiError(
          "permanent",
          status,
          e?.message ?? "permanent error",
        );
      }
    }
    if (
      e?.code === "ECONNRESET" ||
      e?.code === "ETIMEDOUT" ||
      e?.code === "ENOTFOUND"
    ) {
      return new ApiError("transient", undefined, e.message);
    }
    return new ApiError(
      "transient",
      typeof status === "number" ? status : undefined,
      e?.message ?? "unclassified, treated as transient",
    );
  }
}

// --- Fake implementation (for tests) ---
export type FakeBatchState = {
  texts: string[];
  state: "pending" | "running" | "succeeded" | "failed" | "expired";
  errorKind?: "transient" | "permanent";
  errorReason?: string;
};

export class FakeGeminiBatchClient implements GeminiBatchClient {
  public submitted: Map<string, FakeBatchState> = new Map();
  public submitCount = 0;
  public fetchCount = 0;
  public submitError?: ApiError;

  /** Throw on the next submit call (cleared after one use). */
  setSubmitError(e: ApiError): void {
    this.submitError = e;
  }

  /** Forcibly override the state of a given job (for testing purposes). */
  force(jobName: string, patch: Partial<FakeBatchState>): void {
    const cur = this.submitted.get(jobName);
    if (!cur) throw new Error(`no such job: ${jobName}`);
    this.submitted.set(jobName, { ...cur, ...patch });
  }

  async submit(texts: string[]): Promise<SubmitResult> {
    this.submitCount++;
    if (this.submitError) {
      const e = this.submitError;
      this.submitError = undefined;
      throw e;
    }
    const name = `batches/fake-${Date.now()}-${this.submitCount}`;
    this.submitted.set(name, { texts, state: "pending" });
    return { jobName: name };
  }

  async fetch(name: string): Promise<FetchResult> {
    this.fetchCount++;
    const s = this.submitted.get(name);
    if (!s) {
      return {
        state: "failed",
        errorKind: "permanent",
        errorReason: "unknown job",
      };
    }
    if (s.state === "pending" || s.state === "running") {
      return { state: s.state };
    }
    if (s.state === "succeeded") {
      const vectors = s.texts.map((t) => l2norm(fakeEmbed(t, 768)));
      return { state: "succeeded", vectors };
    }
    // failed / expired
    if (s.state === "expired") {
      return {
        state: "expired",
        errorKind: "permanent",
        errorReason: s.errorReason ?? "expired",
      };
    }
    return {
      state: "failed",
      errorKind: s.errorKind ?? "permanent",
      errorReason: s.errorReason ?? "",
    };
  }
}

function fakeEmbed(text: string, dim: number): number[] {
  // Deterministic pseudo-embedding: text hash seeded into a 32-bit LCG.
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) | 0;
  }
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1103515245 + 12345) | 0;
    v[i] = ((seed >>> 0) % 10000) / 10000 - 0.5;
  }
  return v;
}
