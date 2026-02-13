import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createHooksRequestHandler } from "./server-http.js";

const enqueueAutonomyEvent = vi.fn(async () => undefined);
const hasAutonomyState = vi.fn(async () => true);

vi.mock("../autonomy/store.js", () => ({
  enqueueAutonomyEvent: (params: unknown) => enqueueAutonomyEvent(params),
  hasAutonomyState: (agentId: string) => hasAutonomyState(agentId),
}));

function createMockReq(params: {
  method: string;
  url: string;
  headers: Record<string, string>;
}): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as IncomingMessage & { method?: string }).method = params.method;
  (req as IncomingMessage & { url?: string }).url = params.url;
  (req as IncomingMessage & { headers?: Record<string, string> }).headers = params.headers;
  return req;
}

function createMockRes() {
  const headers = new Map<string, string>();
  const out = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn((key: string, value: string) => {
      headers.set(key.toLowerCase(), value);
    }),
    end: vi.fn((value?: string) => {
      out.body = value ?? "";
    }),
  };
  return out as unknown as ServerResponse & {
    body: string;
    setHeader: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe("createHooksRequestHandler autonomy ingestion", () => {
  it("enqueues webhook event when autonomy state exists", async () => {
    enqueueAutonomyEvent.mockClear();
    hasAutonomyState.mockResolvedValueOnce(true);

    const handler = createHooksRequestHandler({
      getHooksConfig: () => ({
        basePath: "/hooks",
        token: "secret",
        maxBodyBytes: 20_000,
        mappings: [],
      }),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: vi.fn(),
      } as never,
      dispatchWakeHook: vi.fn(),
      dispatchAgentHook: vi.fn(() => "run-1"),
    });
    const req = createMockReq({
      method: "POST",
      url: "/hooks/agent",
      headers: {
        authorization: "Bearer secret",
      },
    });
    const res = createMockRes();
    const handledPromise = handler(req, res);
    (req as unknown as PassThrough).end(
      JSON.stringify({ message: "hello", sessionKey: "agent:ops:main" }),
    );
    const handled = await handledPromise;
    expect(handled).toBe(true);
    expect(hasAutonomyState).toHaveBeenCalledWith("ops");
    expect(enqueueAutonomyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        source: "webhook",
        type: "webhook.agent.received",
      }),
    );
  });

  it("skips enqueue when autonomy state is absent", async () => {
    enqueueAutonomyEvent.mockClear();
    hasAutonomyState.mockResolvedValueOnce(false);

    const handler = createHooksRequestHandler({
      getHooksConfig: () => ({
        basePath: "/hooks",
        token: "secret",
        maxBodyBytes: 20_000,
        mappings: [],
      }),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: vi.fn(),
      } as never,
      dispatchWakeHook: vi.fn(),
      dispatchAgentHook: vi.fn(() => "run-1"),
    });
    const req = createMockReq({
      method: "POST",
      url: "/hooks/agent",
      headers: {
        authorization: "Bearer secret",
      },
    });
    const res = createMockRes();
    const handledPromise = handler(req, res);
    (req as unknown as PassThrough).end(
      JSON.stringify({ message: "hello", sessionKey: "agent:ops:main" }),
    );
    const handled = await handledPromise;
    expect(handled).toBe(true);
    expect(enqueueAutonomyEvent).not.toHaveBeenCalled();
  });
});
