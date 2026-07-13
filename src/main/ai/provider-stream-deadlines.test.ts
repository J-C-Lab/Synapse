// @vitest-environment node
//
// This file constructs real Anthropic/OpenAI SDK clients (for the
// real-loopback-server regression tests below) — the SDKs refuse to run
// under the project's default jsdom test environment (they mistake it for
// a real browser, which would risk leaking the API key to client-visible
// network traffic). Running this file under the real Node environment
// instead avoids that false positive entirely, so production provider
// construction never needs `dangerouslyAllowBrowser`.
import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "./providers/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderStreamDeadlineError, streamWithDeadlines } from "./provider-stream-deadlines"
import { AnthropicProvider } from "./providers/anthropic-provider"
import { OpenAiProvider } from "./providers/openai-provider"
import { startHttpLoopbackServer } from "./providers/test-support/http-loopback-server"

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "test-model",
    system: "test",
    messages: [],
    tools: [],
    maxTokens: 100,
    ...overrides,
  }
}

/** A provider whose stream() the test fully controls: it never yields on
 *  its own, and never fires onTransportProgress on its own — the test
 *  drives both explicitly, and this fake never resolves until the
 *  wrapper's AbortSignal fires (matching real streaming SDK behavior on
 *  abort: the underlying async generator only ends once aborted). */
function hangingProvider(onCall?: (req: ProviderRequest) => void): ChatProvider {
  return {
    id: "fake",
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      onCall?.(req)
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      throw new DOMException("aborted", "AbortError")
    },
  }
}

describe("streamWithDeadlines", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires ProviderStreamDeadlineError with kind 'headers' if onTransportProgress('headers') is never called", async () => {
    vi.useFakeTimers()
    const provider = hangingProvider()
    const iterator = streamWithDeadlines(provider, request(), { headersDeadlineMs: 300 })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect((err as ProviderStreamDeadlineError).kind).toBe("headers")
  })

  it("fires kind 'idle' if headers arrive but no activity follows within idleTimeoutMs", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 1_000,
      idleTimeoutMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    capturedReq?.onTransportProgress?.("headers")
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect((err as ProviderStreamDeadlineError).kind).toBe("idle")
  })

  it("fires kind 'duration' even with continuous activity, once maxDurationMs elapses", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 10_000,
      idleTimeoutMs: 10_000,
      maxDurationMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    capturedReq?.onTransportProgress?.("headers")
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect((err as ProviderStreamDeadlineError).kind).toBe("duration")
  })

  it("user cancel is never misreported as a deadline, even if a deadline timer was already pending", async () => {
    vi.useFakeTimers()
    const provider = hangingProvider()
    const callerController = new AbortController()
    const iterator = streamWithDeadlines(provider, request({ signal: callerController.signal }), {
      headersDeadlineMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    callerController.abort()
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).not.toBeInstanceOf(ProviderStreamDeadlineError)
  })

  it("near-simultaneous timers produce exactly one ProviderStreamDeadlineError, not a clobbered second one", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 10_000,
      idleTimeoutMs: 300,
      maxDurationMs: 300,
    })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(1)
    capturedReq?.onTransportProgress?.("headers")
    await vi.advanceTimersByTimeAsync(300)

    const err = await resultPromise
    expect(err).toBeInstanceOf(ProviderStreamDeadlineError)
    expect(["idle", "duration"]).toContain((err as ProviderStreamDeadlineError).kind)
  })

  it("a late onTransportProgress call after termination is a no-op", async () => {
    vi.useFakeTimers()
    let capturedReq: ProviderRequest | undefined
    const provider = hangingProvider((req) => {
      capturedReq = req
    })
    const iterator = streamWithDeadlines(provider, request(), { headersDeadlineMs: 300 })

    const resultPromise = (async () => {
      try {
        for await (const _ of iterator) {
          /* nothing yielded */
        }
        return undefined
      } catch (err) {
        return err
      }
    })()
    await vi.advanceTimersByTimeAsync(300)
    await resultPromise
    expect(() => capturedReq?.onTransportProgress?.("activity")).not.toThrow()
  })

  it("yields normally and never constructs an error when the provider completes before any deadline", async () => {
    const provider: ChatProvider = {
      id: "fake",
      async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        req.onTransportProgress?.("headers")
        yield { type: "text", text: "hi" }
        req.onTransportProgress?.("activity")
        yield {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "end_turn",
        }
      },
    }

    const events: ProviderStreamEvent[] = []
    for await (const event of streamWithDeadlines(provider, request(), {
      headersDeadlineMs: 5_000,
    })) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
  })
})

describe("streamWithDeadlines — real OpenAI SDK regression: no partial success on deadline", () => {
  it("an idle-timeout abort mid-stream never surfaces a truncated message as success", async () => {
    const server = await startHttpLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`)
    })
    try {
      const provider = new OpenAiProvider({ apiKey: "test", baseURL: server.baseURL })

      const events: unknown[] = []
      let thrown: unknown
      try {
        for await (const event of streamWithDeadlines(
          provider,
          {
            model: "test-model",
            system: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            tools: [],
            maxTokens: 100,
          },
          { headersDeadlineMs: 2_000, idleTimeoutMs: 500 }
        )) {
          events.push(event)
        }
      } catch (err) {
        thrown = err
      }

      expect(thrown).toBeInstanceOf(ProviderStreamDeadlineError)
      expect((thrown as ProviderStreamDeadlineError).kind).toBe("idle")
      expect(events.some((e) => (e as { type: string }).type === "message")).toBe(false)
    } finally {
      await server.close()
    }
  }, 10_000)
})

describe("streamWithDeadlines — real Anthropic SDK regression: APIUserAbortError never leaks", () => {
  it("a headers-deadline abort surfaces as ProviderStreamDeadlineError, not Anthropic.APIUserAbortError", async () => {
    const server = await startHttpLoopbackServer(() => {
      /* never respond */
    })
    try {
      const provider = new AnthropicProvider({ apiKey: "test", baseURL: server.baseURL })

      let thrown: unknown
      try {
        for await (const _event of streamWithDeadlines(
          provider,
          {
            model: "test-model",
            system: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            tools: [],
            maxTokens: 100,
          },
          { headersDeadlineMs: 500 }
        )) {
          /* nothing expected */
        }
      } catch (err) {
        thrown = err
      }

      expect(thrown).toBeInstanceOf(ProviderStreamDeadlineError)
      expect((thrown as ProviderStreamDeadlineError).kind).toBe("headers")
      expect(thrown).not.toHaveProperty("name", "APIUserAbortError")
    } finally {
      await server.close()
    }
  }, 10_000)

  it("a real message_start SSE event correctly fires 'headers' then 'activity', and idle fires on silence after — this maps the SDK's real connect/streamEvent behavior, not just the fake emitter in anthropic-provider.test.ts", async () => {
    const server = await startHttpLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "test-model",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })}\n\n`
      )
      // then goes silent forever — never another event, never [DONE]
    })
    try {
      const provider = new AnthropicProvider({ apiKey: "test", baseURL: server.baseURL })

      let thrown: unknown
      try {
        for await (const _event of streamWithDeadlines(
          provider,
          {
            model: "test-model",
            system: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            tools: [],
            maxTokens: 100,
          },
          { headersDeadlineMs: 2_000, idleTimeoutMs: 500 }
        )) {
          /* nothing expected */
        }
      } catch (err) {
        thrown = err
      }

      expect(thrown).toBeInstanceOf(ProviderStreamDeadlineError)
      expect((thrown as ProviderStreamDeadlineError).kind).toBe("idle")
    } finally {
      await server.close()
    }
  }, 10_000)
})
