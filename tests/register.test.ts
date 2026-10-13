// 엔진을 통한 통합 테스트: AssistantMessage 렌더 자리, 백그라운드 번역, invalidate로 다시 그리기,
// 생성 중 원문 유지, 실패 시 원문, $.store 캐시, Gemini 옵션, 로그 최소화, 생각 번역(띠·패널).
// 모델·HTTP는 모킹한다.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { HttpInit, ModelCompleteResult, On, RenderElement } from 'claude-code'

import { PENDING_ANSWER, PENDING_ANSWER_RETRY, PENDING_THINKING, shortHash, STREAMING_THINKING } from '../hooks/core'
import { FAILED_MARK, OMITTED_HINT, RESTART_HINT } from '../hooks/register'

const PLUGIN = 'thinking-ko'
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Reply = (prompt: string, system: string) => ModelCompleteResult | Promise<ModelCompleteResult>
const answered = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

/** 원문 태그 안의 글(번역기에 간 원문)을 꺼낸다. */
const sourceOf = (prompt: string): string => prompt.replace(/^<원문>\n/, '').replace(/\n<\/원문>$/, '')

type World = {
  clock: MockClock
  calls: Array<{ model: string; prompt: string; system?: string }>
  fetches: Array<{ url: string; init?: HttpInit }>
  writes: Array<{ path: string; text: string }>
  store: Map<string, unknown>
  appended: () => readonly unknown[]
}

/** 엔진 밑바닥을 흉내 낸다. 렌더 자리의 맨 밑 훅은 받은 글을 Text 하나로 그린다. */
type WorldOptions = {
  reply?: Reply
  store?: Record<string, unknown>
  fetch?: (url: string) => { status?: number; text: string }
  /** 사용자 설정(병합본). 기본은 생각 요약이 켜진 상태. */
  settings?: Record<string, unknown>
  /** 읽을 수 있는 파일들 */
  files?: Record<string, string>
}

function world(on: On, opts: WorldOptions = {}): World {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/tester' })
  const session = mock.session(on)
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const w: World = { clock, calls: [], fetches: [], writes: [], store, appended: () => session.appended() }
  // $.store를 메모리로 대신한다(테스트에서 들여다보려고 mock.store 대신 직접 둔다).
  on('store.get', ($, e) => ({ value: structuredClone(store.get(e.key)) }))
  on('store.set', ($, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('fs.read', ($, e) => (opts.files && e.path in opts.files ? { value: opts.files[e.path]! } : { deny: 'no such file' }))
  on('settings.read', () => ({ value: opts.settings ?? { showThinkingSummaries: true } }))
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('model.complete', async ($, e) => {
    w.calls.push({ model: e.model, prompt: e.prompt, system: e.system })
    return { value: await (opts.reply ?? (p => answered(`번역 ${sourceOf(p)}`)))(e.prompt, e.system ?? '') }
  })
  on('http.fetch', ($, e) => {
    w.fetches.push({ url: e.url, init: e.init })
    const { status = 200, text } = opts.fetch ? opts.fetch(e.url) : { text: '{}' }
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e): RenderElement => ({
    type: 'Text',
    props: {},
    children: [e.props.text],
  }) as RenderElement)
  // 띠에 아무것도 없을 때 엔진이 그리는 것: 빈 Box
  on('ui.render', { component: 'AbovePrompt' }, (): RenderElement => ({ type: 'Box', props: {}, children: [] }) as RenderElement)
  // 엔진의 진행 줄: 그 단어를 Text 하나로
  on('ui.render', { component: 'Spinner' }, ($, e): RenderElement => ({ type: 'Text', props: {}, children: [e.props.word] }) as RenderElement)
  on('turn.complete', () => ({ text: '' }))
  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

async function turn($: Engine, id = 't1'): Promise<void> {
  await $.turn.start({ text: 'prompt', turnId: id })
}

/** 답변 블록 하나를 터미널에 그려 두고, 그려진 글을 읽는 함수를 돌려준다. */
async function mountReply($: Engine, requestId: string, text: string, extra: { isSummary?: true } = {}) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true, ...extra },
  })
  return {
    ui,
    /** 답변 본문: 맨 밑 엔진 그림(테스트의 Text) */
    shown: async () => (await ui.findAll({ type: 'Text' })).at(-1)?.text,
    /** 답변 위에 붙은 생각(없으면 undefined) */
    thoughts: async () => (await ui.find({ type: 'Markdown' }))?.text,
  }
}

test('기본(Haiku): 처음엔 원문+대기 표시, 번역이 오면 다시 그려 번역문, 캐시 저장, 대화 기록은 그대로', async ($, on) => {
  const w = world(on, {
    reply: async p => {
      await w.clock.sleep(1500) // 번역에 1.5초 걸린다
      return answered(`번역 ${sourceOf(p)}`)
    },
  })
  await start($)
  await turn($)
  const m = await mountReply($, 'msg-1', 'I fixed the parser bug.')
  expect(await m.shown()).toBe(`I fixed the parser bug.\n\n${PENDING_ANSWER}`)
  await w.clock.advance(1500) // 번역 도착 → 플러그인의 $.ui.invalidate로 다시 그려진다
  expect(await m.shown()).toBe('번역 I fixed the parser bug.')
  expect(w.calls.length).toBe(1)
  expect(w.calls[0]!.model).toBe('haiku')
  expect(w.calls[0]!.prompt).toBe('<원문>\nI fixed the parser bug.\n</원문>')
  expect(w.calls[0]!.system).toContain('반말')
  expect(w.calls[0]!.system).toContain('맞춤법은 표준대로')
  expect(w.calls[0]!.system).toContain('URL, 숫자는 한 글자도 바꾸지 마')
  expect(w.fetches).toEqual([])
  expect(w.store.get('t:msg-1')).toEqual({ h: shortHash('I fixed the parser bug.'), ko: '번역 I fixed the parser bug.' })
  expect(w.store.get('cache-index')).toEqual(['msg-1'])
  // 같은 메시지를 다시 그려도 번역을 다시 요청하지 않는다
  await m.ui.redraw()
  expect(w.calls.length).toBe(1)
  // 표시만 바꾼다: 세션에 아무 행도 추가하지 않는다
  expect(w.appended()).toEqual([])
})

test('claude_model 설정을 따른다', { options: { claude_model: 'claude-haiku-5-5' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await turn($)
  await mountReply($, 'msg-1', 'Done.')
  await w.clock.settle()
  expect(w.calls[0]!.model).toBe('claude-haiku-5-5')
})

test('생성 중인 블록은 원문 그대로 두고, 블록이 끝나면 번역을 시작한다', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const w = world(on)
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'Working on' }
    yield { kind: 'text', index: 0, text: ' it now.' }
    await gate
    return { turnId: e.turnId, index: e.index, answer: 'Working on it now.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await start($)
  await turn($)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const chunks: string[] = []
  const reading = (async () => {
    for await (const c of stream) if (c.kind === 'text') chunks.push(c.text)
  })()
  await w.clock.settle()
  const m = await mountReply($, 'msg-1', 'Working on')
  await w.clock.settle()
  expect(await m.shown()).toBe('Working on') // 생성 중: 표시 없이 원문
  expect(w.calls.length).toBe(0)
  release()
  await reading
  expect(chunks).toEqual(['Working on', ' it now.']) // 조각은 그대로 지나간다
  await m.ui.redraw({ text: 'Working on it now.', isFirstOfReply: true })
  await w.clock.settle()
  expect(await m.shown()).toBe('번역 Working on it now.')
  expect(w.calls.length).toBe(1)
})

test('번역이 두 번 실패하면 재시도 표시를 거쳐 원문으로 돌아가고 캐시하지 않는다', async ($, on) => {
  const w = world(on, {
    reply: () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }),
  })
  await start($)
  await turn($)
  const m = await mountReply($, 'msg-1', 'Hello there')
  await w.clock.settle()
  expect(await m.shown()).toBe(`Hello there\n\n${PENDING_ANSWER_RETRY}`)
  await w.clock.advance(60_000) // 재시도 대기(RETRY_DELAY_MS)
  expect(await m.shown()).toBe('Hello there')
  expect(w.calls.length).toBe(2)
  expect(w.store.has('t:msg-1')).toBe(false)
})

test('타임아웃: 응답이 늦으면 12초에 실패로 보고 재시도한다', async ($, on) => {
  let n = 0
  const w = world(on, {
    reply: async p => {
      if (++n === 1) await w.clock.sleep(30_000) // 첫 요청은 늦는다
      return answered(`늦지 않은 번역 ${sourceOf(p)}`)
    },
  })
  await start($)
  await turn($)
  const m = await mountReply($, 'msg-1', 'Slow one.')
  await w.clock.advance(11_999)
  expect(await m.shown()).toBe(`Slow one.\n\n${PENDING_ANSWER}`)
  await w.clock.advance(1)
  expect(await m.shown()).toBe(`Slow one.\n\n${PENDING_ANSWER_RETRY}`)
  await w.clock.advance(60_000)
  expect(await m.shown()).toBe('늦지 않은 번역 Slow one.')
})

test('여러 답변이 몰려도 답변 번역 요청은 한 번에 1개씩(원본과 같음) 나가고 모두 번역된다', async ($, on) => {
  let inflight = 0
  let peak = 0
  const w = world(on, {
    reply: async p => {
      inflight++
      peak = Math.max(peak, inflight)
      await w.clock.sleep(1000)
      inflight--
      return answered(`번역 ${sourceOf(p)}`)
    },
  })
  await start($)
  await turn($)
  const ms = []
  for (let i = 1; i <= 4; i++) ms.push(await mountReply($, `msg-${i}`, `Answer ${i}.`))
  await w.clock.settle()
  expect(inflight).toBe(1)
  await w.clock.advance(5000)
  expect(peak).toBe(1)
  for (let i = 1; i <= 4; i++) expect(await ms[i - 1]!.shown()).toBe(`번역 Answer ${i}.`)
})

test('캐시: 메시지 id로 저장된 번역은 요청 없이 바로 그리고, 원문이 바뀌었으면 쓰지 않는다', async ($, on) => {
  const w = world(on, {
    store: {
      't:old-1': { h: shortHash('Cached answer.'), ko: '캐시된 번역' },
      't:old-2': { h: shortHash('Original text.'), ko: '옛 번역' },
      'cache-index': ['old-1', 'old-2'],
    },
  })
  await start($)
  // 턴 시작 전(재개한 과거 기록)이어도 캐시는 쓴다
  const a = await mountReply($, 'old-1', 'Cached answer.')
  expect(await a.shown()).toBe('캐시된 번역')
  const b = await mountReply($, 'old-2', 'Edited text.')
  expect(await b.shown()).toBe('Edited text.')
  await w.clock.settle()
  expect(w.calls.length).toBe(0)
})

test('과거 메시지(이번에 턴이 시작되기 전에 그려진 것)는 새로 번역하지 않는다', async ($, on) => {
  const w = world(on)
  await start($)
  const old = await mountReply($, 'old-1', 'From an earlier session.')
  await turn($)
  await old.ui.redraw()
  const fresh = await mountReply($, 'new-1', 'A new reply.')
  await w.clock.settle()
  expect(await old.shown()).toBe('From an earlier session.')
  expect(await fresh.shown()).toBe('번역 A new reply.')
  expect(w.calls.map(c => sourceOf(c.prompt))).toEqual(['A new reply.'])
})

test('요약 행(isSummary, 앱이 도구 호출 사이 글을 이렇게 넘긴다)도 번역한다', async ($, on) => {
  const w = world(on)
  await start($)
  await turn($)
  const m = await mountReply($, 'sum-1', 'Edited three files.', { isSummary: true })
  await w.clock.settle()
  expect(await m.shown()).toBe('번역 Edited three files.')
  expect(w.calls.length).toBe(1)
})

const KEY = 'AIzaTEST-not-a-real-key-0000000000000'

test(
  'Gemini 옵션: 키가 있으면 공식 API로 번역, 키는 헤더로만 가고 로그에는 원문·번역·키가 없다',
  { options: { gemini_api_key: KEY } },
  async ($, on) => {
    const w = world(on, {
      fetch: () => ({
        text: JSON.stringify({ candidates: [{ content: { parts: [{ text: '제미나이 번역이야.' }] }, finishReason: 'STOP' }] }),
      }),
    })
    await start($)
    await turn($)
    const m = await mountReply($, 'msg-1', 'Secret plan: ship it.')
    await w.clock.settle()
    expect(await m.shown()).toBe('제미나이 번역이야.')
    expect(w.calls.length).toBe(0)
    expect(w.fetches.length).toBe(1)
    const f = w.fetches[0]!
    expect(f.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')
    expect(f.url.includes(KEY)).toBe(false)
    expect(f.init?.method).toBe('POST')
    expect(f.init?.headers?.['x-goog-api-key']).toBe(KEY)
    const body = JSON.parse(f.init?.body ?? '{}') as { contents: Array<{ parts: Array<{ text: string }> }>; systemInstruction: { parts: Array<{ text: string }> } }
    expect(body.contents[0]!.parts[0]!.text).toBe('<원문>\nSecret plan: ship it.\n</원문>')
    expect(body.systemInstruction.parts[0]!.text).toContain('반말')

    await w.clock.advance(2000) // 로그를 파일로 내보낸다
    const log = w.writes.at(-1)
    expect(log?.path).toBe('/home/tester/.claude/thinking-ko/thinking-ko.log')
    expect(log?.text).toContain('start backend=gemini:gemini-flash-latest')
    expect(log?.text).toContain('ok backend=gemini:gemini-flash-latest kind=answer try=1')
    for (const secret of [KEY, 'Secret plan', '제미나이 번역']) expect(log?.text.includes(secret)).toBe(false)
  },
)

test(
  'Gemini 오류: 잘린 응답·HTTP 오류는 실패로 보고 원문, 오류 본문은 로그에 남기지 않는다',
  { options: { gemini_api_key: KEY } },
  async ($, on) => {
    let n = 0
    const w = world(on, {
      fetch: () =>
        ++n === 1
          ? { text: JSON.stringify({ candidates: [{ content: { parts: [{ text: '잘린' }] }, finishReason: 'MAX_TOKENS' }] }) }
          : { status: 403, text: JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: `bad key ${KEY}` } }) },
    })
    await start($)
    await turn($)
    const m = await mountReply($, 'msg-1', 'Will fail.')
    await w.clock.settle()
    expect(await m.shown()).toBe(`Will fail.\n\n${PENDING_ANSWER_RETRY}`)
    await w.clock.advance(60_000)
    expect(await m.shown()).toBe('Will fail.')
    await w.clock.advance(2000) // 로그를 파일로 내보낸다
    const log = w.writes.at(-1)?.text ?? ''
    expect(log).toContain('truncated')
    expect(log).toContain('gemini http 403 PERMISSION_DENIED')
    expect(log.includes(KEY)).toBe(false)
  },
)

// ---- 생각(thinking) ----------------------------------------------------------------

const BAND = {
  plugin: PLUGIN,
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

/** 그려진 글 전체(Text·Markdown)를 이어 붙인다. */
async function textOf(ui: { findAll: (q: { type: string }) => Promise<Array<{ text: string }>> }): Promise<string> {
  const texts = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Markdown' }))]
  return texts.map(t => t.text).join('\n')
}

type StepChunk = { kind: 'thinking' | 'text'; index: number; text: string } | { kind: 'tool'; index: number; id: string; name: string }

/** 응답 스트림을 흉내 낸다: 몇 번째 요청(e.index)이냐에 따라 parts를 내보내고, gate가 있으면 거기서 멈춘다. */
function stepWith(on: On, parts: Array<StepChunk | Promise<void>> | ((index: number) => Array<StepChunk | Promise<void>>)): void {
  on('turn.step', async function* ($, e) {
    for (const part of typeof parts === 'function' ? parts(e.index) : parts) {
      if (part instanceof Promise) await part
      else yield part
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

function readAll($: Engine, agentId?: string, index = 0): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
  return (async () => {
    for await (const _ of stream) {
      // 조각은 그대로 지나간다
    }
  })()
}

const isThinking = (system: string): boolean => system.includes('속으로 하는 생각(영어)을')

const SPINNER = {
  plugin: PLUGIN,
  surface: 'terminal' as const,
  component: 'Spinner' as const,
  props: { word: 'Working', message: null, suffix: '…', mode: 'thinking' as const },
}

test('생각: 문단마다 바로 번역해서, 생각 도중에 대화창의 진행 줄 위에 한국어로 쌓이고, 답변 글이 나오면 그 위로 옮겨 간다', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const w = world(on, {
    reply: async (p, system) => {
      await w.clock.sleep(1000)
      if (!isThinking(system)) return answered('다 됐어.')
      return answered(sourceOf(p).startsWith('**Checking') ? '**파일 확인**' : sourceOf(p).startsWith('I should') ? '파일부터 읽어야겠어.' : '그다음 테스트 돌려 볼게.')
    },
  })
  stepWith(on, [
    { kind: 'thinking', index: 0, text: '**Checking the file**\n\nI should read' },
    { kind: 'thinking', index: 0, text: ' the file first.\n\nThen I will run' },
    gate, // 생각이 아직 이어지는 중
    { kind: 'thinking', index: 0, text: ' the tests.' },
    { kind: 'text', index: 1, text: 'Done.' },
  ])
  await start($)
  await turn($)
  const spinner = await $.ui.mount(SPINNER)
  expect(await textOf(spinner)).toBe('Working') // 생각이 없으면 엔진 진행 줄 그대로
  const reading = readAll($)
  await w.clock.settle()
  // 끝난 문단(제목 + 첫 문단)은 생각이 끝나기 전에 이미 번역 요청이 나갔다
  expect(w.calls.map(c => sourceOf(c.prompt))).toEqual(['**Checking the file**', 'I should read the file first.'])
  expect(await textOf(spinner)).toContain(PENDING_THINKING)
  await w.clock.advance(1000)
  const mid = await textOf(spinner)
  expect(mid).toContain('파일부터 읽어야겠어.') // 생각 도중에 한국어가 보인다
  expect(mid).toContain(STREAMING_THINKING) // 나머지는 아직 생각 중
  expect(mid).toContain('Working') // 엔진 진행 줄은 그대로 아래에 있다
  expect(mid.includes('I should read')).toBe(false)
  release()
  await reading
  await w.clock.settle()
  // 답변 글이 시작됐으니 생각은 진행 줄에서 빠지고 그 답변 위로 간다
  expect(await textOf(spinner)).toBe('Working')
  const m = await mountReply($, 'msg-1', 'Done.')
  await w.clock.advance(2000)
  expect(await m.thoughts()).toBe('**파일 확인**\n\n파일부터 읽어야겠어.\n\n그다음 테스트 돌려 볼게.')
  expect(await m.shown()).toBe('다 됐어.')
  expect(w.store.get('k:msg-1')).toEqual({ h: shortHash('Done.'), kos: ['**파일 확인**\n\n파일부터 읽어야겠어.\n\n그다음 테스트 돌려 볼게.'] })
  expect(w.appended()).toEqual([]) // 표시만 바꾼다

  // /thinking-ko 패널에 최근 생각이 쌓인다
  const ran = await $.command.run({ command: 'thinking-ko', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
  expect(ran).toMatchObject({ text: '생각 번역 패널을 열었어.' })
  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'thinking-ko',
    props: { title: '생각 번역', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await textOf(pane)).toContain('파일부터 읽어야겠어.')
})

test('생각: 도구 호출 앞의 생각은 같은 턴의 다음 답변 위에 붙는다', async ($, on) => {
  const w = world(on, { reply: (p, system) => answered(isThinking(system) ? '파일 읽어볼게.' : '읽었어.') })
  stepWith(on, index =>
    index === 0
      ? [
          { kind: 'thinking', index: 0, text: 'Let me read the file.' },
          { kind: 'tool', index: 1, id: 'tu-1', name: 'Read' },
        ]
      : [{ kind: 'text', index: 0, text: 'I read it.' }],
  )
  await start($)
  await turn($)
  await readAll($, undefined, 0)
  await w.clock.settle()
  const spinner = await $.ui.mount(SPINNER)
  expect(await textOf(spinner)).toContain('파일 읽어볼게.') // 도구가 도는 동안은 진행 줄 위에
  await readAll($, undefined, 1)
  await w.clock.settle()
  const m = await mountReply($, 'msg-2', 'I read it.')
  expect(await m.thoughts()).toBe('파일 읽어볼게.')
  expect(await m.shown()).toBe('읽었어.')
})

test('생각: 답변 글 없이 턴이 끝나면 남은 생각은 그 턴의 마지막 답변 위에 붙는다', async ($, on) => {
  const w = world(on, { reply: (p, system) => answered(isThinking(system) ? `생각 ${sourceOf(p)}` : `번역 ${sourceOf(p)}`) })
  stepWith(on, index =>
    index === 0
      ? [
          { kind: 'thinking', index: 0, text: 'First.' },
          { kind: 'text', index: 1, text: 'Working on it.' },
          { kind: 'thinking', index: 2, text: 'Last check.' },
        ]
      : [],
  )
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
  const m = await mountReply($, 'msg-1', 'Working on it.')
  await w.clock.settle()
  expect(await m.thoughts()).toBe('생각 First.\n\n생각 Last check.')
})

test('생각: [접기]를 누르면 마지막 한 줄만, [펼치기]로 다시 전부, 접은 상태는 저장한다', async ($, on) => {
  const w = world(on, { reply: p => answered(`번역 ${sourceOf(p)}`) })
  stepWith(on, [
    { kind: 'thinking', index: 0, text: 'First idea.\n\nSecond idea.\n\nThird idea.' },
    { kind: 'text', index: 1, text: 'Answer.' },
  ])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  const m = await mountReply($, 'msg-1', 'Answer.')
  expect(await m.thoughts()).toBe('번역 First idea.\n\n번역 Second idea.\n\n번역 Third idea.')
  await m.ui.press({ key: 'fold' })
  expect(await m.thoughts()).toBe('번역 Third idea.')
  expect((await m.ui.find({ key: 'fold' }))?.props.label).toBe('펼치기')
  await w.clock.settle()
  expect(w.store.get('band-collapsed')).toBe(true)
  await m.ui.press({ key: 'fold' })
  expect(await m.thoughts()).toBe('번역 First idea.\n\n번역 Second idea.\n\n번역 Third idea.')
})

test('생각: 접은 상태는 다음 세션에도 이어진다', async ($, on) => {
  const w = world(on, { store: { 'band-collapsed': true }, reply: p => answered(`번역 ${sourceOf(p)}`) })
  stepWith(on, [{ kind: 'thinking', index: 0, text: 'Alpha.\n\nBeta.' }])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  const spinner = await $.ui.mount(SPINNER)
  const shown = await textOf(spinner)
  expect(shown).toContain('번역 Beta.')
  expect(shown.includes('Alpha')).toBe(false)
})

test('생각: thinking_in_reply를 끄면 답변 위에 붙이지 않는다', { options: { thinking_in_reply: false } }, async ($, on) => {
  const w = world(on, { reply: (p, system) => answered(isThinking(system) ? '생각.' : '답.') })
  stepWith(on, [
    { kind: 'thinking', index: 0, text: 'Thought.' },
    { kind: 'text', index: 1, text: 'Answer.' },
  ])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  const m = await mountReply($, 'msg-1', 'Answer.')
  expect(await m.thoughts()).toBe(undefined)
  expect(await m.shown()).toBe('답.')
})

test('생각: 재개한 과거 답변은 캐시해 둔 생각 번역을 위에 붙인다(요청 없음)', async ($, on) => {
  const w = world(on, {
    store: {
      't:old-1': { h: shortHash('Old answer.'), ko: '옛 답변' },
      'k:old-1': { h: shortHash('Old answer.'), kos: ['옛 생각'] },
    },
  })
  await start($)
  const m = await mountReply($, 'old-1', 'Old answer.')
  expect(await m.thoughts()).toBe('옛 생각')
  expect(await m.shown()).toBe('옛 답변')
  await w.clock.settle()
  expect(w.calls.length).toBe(0)
})

test('생각: 번역이 끝내 실패한 문단은 원문을 실패 표시와 함께 보여 준다', async ($, on) => {
  const w = world(on, { reply: () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }) })
  stepWith(on, [{ kind: 'thinking', index: 0, text: 'Plain English thought.' }])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  await w.clock.advance(60_000)
  const spinner = await $.ui.mount(SPINNER)
  expect(await textOf(spinner)).toContain(`${FAILED_MARK}_ Plain English thought.`)
})

test('생각: 서브에이전트의 생각은 올리지 않는다', async ($, on) => {
  const w = world(on)
  stepWith(on, [
    { kind: 'thinking', index: 0, text: 'Subagent thinking here.' },
    { kind: 'text', index: 1, text: 'Report.' },
  ])
  await start($)
  await turn($)
  await readAll($, 'agent-1')
  await w.clock.settle()
  const spinner = await $.ui.mount(SPINNER)
  expect(await textOf(spinner)).toBe('Working')
  expect(w.calls.length).toBe(0)
})

test('생각: 입력창 위 띠에는 생각을 띄우지 않는다', async ($, on) => {
  const w = world(on, { reply: p => answered(`번역 ${sourceOf(p)}`) })
  stepWith(on, [{ kind: 'thinking', index: 0, text: 'Some thought.' }])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await textOf(band)).toBe('')
})

test('생각 묶음은 데스크톱 화면 규칙으로도 그려진다(진행 줄·답변 위, 펼침·접힘)', async ($, on) => {
  const w = world(on, { reply: p => answered(`번역 ${sourceOf(p)}`) })
  stepWith(on, [
    { kind: 'thinking', index: 0, text: 'One.\n\nTwo.' },
    { kind: 'text', index: 1, text: 'Answer.' },
  ])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  const reply = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AssistantMessage', requestId: 'msg-1', props: { text: 'Answer.', isFirstOfReply: true } })
  expect(await textOf(reply)).toContain('번역 Two.')
  await reply.press({ key: 'fold' })
  expect((await textOf(reply)).includes('번역 One.')).toBe(false)
  const spinner = await $.ui.mount({ ...SPINNER, surface: 'desktop' as const })
  expect(await textOf(spinner)).toContain('Working')
})

const SETTINGS = '/home/tester/.claude/settings.json'

/** 생각 요약이 꺼진 상태: 생각 블록이 텍스트 없이 온다. */
async function emptyThinking($: Engine, on: On, opts: WorldOptions): Promise<World> {
  const w = world(on, opts)
  stepWith(on, [
    { kind: 'thinking', index: 0, text: '' },
    { kind: 'text', index: 1, text: 'Answer.' },
  ])
  await start($)
  await turn($)
  await readAll($)
  await w.clock.settle()
  return w
}

test('설정에 생각 요약이 없어도 생각이 실제로 들어오면(앱 기본값) 안내·버튼을 띄우지 않는다', async ($, on) => {
  const w = world(on, { settings: {}, reply: p => answered(`번역 ${sourceOf(p)}`) })
  stepWith(on, [{ kind: 'thinking', index: 0, text: 'Real thought.' }])
  await start($)
  const band = await $.ui.mount(BAND)
  expect(await textOf(band)).toBe('')
  await turn($)
  await readAll($)
  await w.clock.settle()
  expect(await textOf(band)).toBe('') // 안내·버튼 없음
  const spinner = await $.ui.mount(SPINNER)
  expect(await textOf(spinner)).toContain('번역 Real thought.')
})

test('생각이 텍스트 없이 오면 띠에 안내와 [생각 요약 켜기]: 누르면 백업 후 settings.json에 그 한 줄만 더한다', async ($, on) => {
  const before = '{\n  "model": "opus",\n  "enabledPlugins": {\n    "thinking-ko@claude-thinking-ko": true\n  }\n}\n'
  const w = await emptyThinking($, on, { files: { [SETTINGS]: before } })
  const band = await $.ui.mount(BAND)
  expect(await textOf(band)).toContain(OMITTED_HINT)
  const m = await mountReply($, 'msg-1', 'Answer.')
  expect(await m.shown()).toBe('번역 Answer.') // 빈 생각은 아무 데도 안 붙는다
  await band.press({ key: 'enable-summaries' })
  const backup = w.writes.find(x => x.path === `${SETTINGS}.thinking-ko.bak`)
  const written = w.writes.find(x => x.path === SETTINGS)
  expect(backup?.text).toBe(before)
  expect(JSON.parse(written?.text ?? '{}')).toEqual({
    model: 'opus',
    enabledPlugins: { 'thinking-ko@claude-thinking-ko': true },
    showThinkingSummaries: true,
  })
  expect(await textOf(band)).toContain(RESTART_HINT)
})

test('settings.json이 JSON으로 안 읽히면 건드리지 않는다', async ($, on) => {
  const w = await emptyThinking($, on, { files: { [SETTINGS]: '{ "model": "opus", // comment\n}' } })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'enable-summaries' })
  expect(w.writes.filter(x => x.path.startsWith(SETTINGS))).toEqual([])
})

test('생각 요약이 이미 켜져 있고 아직 생각이 없으면 띠는 비어 있다', async ($, on) => {
  world(on)
  await start($)
  const band = await $.ui.mount(BAND)
  expect(await textOf(band)).toBe('')
})
