// 번역기 두 가지: 기본은 세션의 Claude 클라이언트로 Haiku를 부르는 $.model.complete, 옵션은
// 사용자가 준 키로 Gemini 공식 API(generativelanguage.googleapis.com)를 부르는 $.http.fetch.
// 키는 플러그인 설정(userConfig, 민감 값은 보안 저장소)에서만 받고 코드·로그·저장소에 남기지 않는다.
import type { HttpInit, HttpResponse, ModelCompleteOptions, ModelCompleteRequest, ModelCompleteResult } from 'claude-code'

import { buildSystemPrompt, buildUserPrompt, maxTokensFor } from './core'

export const DEFAULT_CLAUDE_MODEL = 'haiku'
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

export type Complete = (request: ModelCompleteRequest, options?: ModelCompleteOptions) => Promise<ModelCompleteResult>
export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

/** Claude(기본 Haiku) 번역 요청 한 번. 결과가 없거나 출력 상한에 닿았으면(잘림) 실패로 던진다. */
export async function claudeRequest(
  complete: Complete,
  model: string,
  source: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const maxTokens = maxTokensFor(source)
  const r = await complete(
    {
      model,
      // 예시가 든 시스템 프롬프트는 요청마다 같아서 캐시 표시를 한다(모델 최소 길이 미만이면 무시된다).
      system: [{ text: buildSystemPrompt(), cache: true }],
      prompt: buildUserPrompt(source),
      maxTokens,
      effort: 'low',
      timeoutMs,
    },
    { signal },
  )
  if (!r.isAnswered) {
    throw new Error(r.reason === 'api-error' ? `api-error status=${r.status ?? '-'} kind=${r.error}` : r.reason)
  }
  if (r.usage.output_tokens >= maxTokens) throw new Error('truncated')
  return r.text
}

/** Gemini generateContent 요청. 키는 URL이 아니라 헤더(x-goog-api-key)로 보낸다. */
export function geminiRequestInit(model: string, apiKey: string, source: string): { url: string; init: HttpInit } {
  const name = model.replace(/^models\//, '')
  return {
    url: `${GEMINI_ENDPOINT}/${encodeURIComponent(name)}:generateContent`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(source) }] }],
        generationConfig: { maxOutputTokens: maxTokensFor(source) },
      }),
    },
  }
}

type GeminiPart = { text?: unknown; thought?: unknown }
type GeminiReply = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: unknown }>
  promptFeedback?: { blockReason?: unknown }
  error?: { status?: unknown }
}

/**
 * Gemini 응답을 번역문으로 바꾼다. 정상 종료(STOP)가 아니면 실패로 던진다. 특히 출력 상한에 걸려
 * 잘린 번역(MAX_TOKENS)을 성공으로 캐시·표시하지 않기 위해서다(원본 replyFromResult와 같은 규칙).
 * 오류 본문은 메시지에 넣지 않고 상태 이름만 쓴다.
 */
export function parseGeminiResponse(res: HttpResponse): string {
  let body: GeminiReply | undefined
  try {
    body = JSON.parse(res.text) as GeminiReply
  } catch {
    body = undefined
  }
  if (!res.ok) {
    const status = typeof body?.error?.status === 'string' ? ` ${body.error.status}` : ''
    throw new Error(`gemini http ${res.status}${status}`)
  }
  if (!body) throw new Error('gemini bad json')
  const cand = body.candidates?.[0]
  if (!cand) throw new Error(`gemini blocked ${String(body.promptFeedback?.blockReason ?? 'no-candidate')}`)
  const finish = String(cand.finishReason ?? 'STOP')
  if (finish !== 'STOP') throw new Error(finish === 'MAX_TOKENS' ? 'truncated' : `gemini finish ${finish}`)
  return (cand.content?.parts ?? [])
    .filter(p => p.thought !== true && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('')
}

export async function geminiRequest(fetch: Fetch, model: string, apiKey: string, source: string): Promise<string> {
  const { url, init } = geminiRequestInit(model, apiKey, source)
  return parseGeminiResponse(await fetch(url, init))
}
