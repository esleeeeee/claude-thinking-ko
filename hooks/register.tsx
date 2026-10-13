// thinking-ko for Claude Code: shows Claude's thinking and replies in casual Korean (반말·구어체).
//
// It changes the drawing only. Nothing is appended to the session, and no request the model
// sees is changed; the response stream is read and passed on unchanged.
//
// Replies: the `AssistantMessage` render site is rewritten with
// `next({ ...e, props: { ...e.props, text } })`, which the engine documents as changing the
// drawing and leaving the stored message alone (ctrl+o shows the original). A block is drawn
// as written, translated in the background, and drawn again via `$.ui.invalidate` once the
// translation lands; a block still being generated stays as written, one waiting gets a mark.
//
// Thinking: there is no render site for thinking blocks, so the original thinking row stays as
// it is. The thinking text is read from the response stream (`turn.step` thinking chunks) as
// each block ends, translated the same way, and drawn as a quote at the top of the reply block
// that follows it in the same turn (that block's drawing only). The band above the prompt shows
// progress, and the `/thinking-ko` pane lists recent thoughts. Claude Code only receives thinking
// text when thinking summaries are on (the desktop app does by default; the terminal needs
// `"showThinkingSummaries": true`); without it the blocks arrive empty and the band says so.
import type { HttpInit, HttpResponse, Register } from 'claude-code'

import {
  answerId,
  clip,
  displayText,
  PENDING_THINKING,
  PENDING_THINKING_RETRY,
  quoteBlock,
  redact,
  sameTextKey,
  shortHash,
  Slots,
  StreamTracker,
  STREAMING_THINKING,
  ThoughtCollector,
  timeoutFor,
  TranslationManager,
  trimBlankLines,
} from './core'
import type { Timers, TranslationKind } from './core'
import { claudeRequest, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, geminiRequest } from './translators'
import type { Complete } from './translators'

/** Translations kept in `$.store` (per message id), oldest dropped first. */
export const MAX_CACHE_ENTRIES = 100
/** A translation longer than this is shown but not cached ($.store holds 4 MiB in all). */
export const MAX_CACHED_CHARS = 8000
/** Thoughts kept for the pane. */
export const MAX_THOUGHTS = 20
/** Reply blocks remembered with the thoughts that came before them. */
const MAX_ATTACHED = 50
export const PANE_ID = 'thinking-ko'
export const COMMAND = 'thinking-ko'
/** Shown while Claude Code does not receive thinking text (thinking summaries off). */
export const OMITTED_HINT = '생각 요약이 꺼져 잇어서 생각을 못 옮겨. 아래 버튼 누르면 켜줄게.'
/** Shown once the setting was written: it takes effect on the next start. */
export const RESTART_HINT = '생각 요약 켯어. Claude Code(앱)를 완전히 껏다 켜면 생각이 번역돼.'
const CACHE_PREFIX = 't:'
const CACHE_INDEX = 'cache-index'
const THOUGHT_PREFIX = 'k:'
const THOUGHT_INDEX = 'thought-index'
const LOG_MAX_LINES = 500
const LOG_FLUSH_MS = 2000

type CacheEntry = { h: string; ko: string }
/** Translated thoughts shown above a reply block, kept with the block's source hash. */
type ThoughtCacheEntry = { h: string; kos: string[] }

function isCacheEntry(v: unknown): v is CacheEntry {
  return typeof v === 'object' && v !== null && typeof (v as CacheEntry).h === 'string' && typeof (v as CacheEntry).ko === 'string'
}

function isThoughtCacheEntry(v: unknown): v is ThoughtCacheEntry {
  const x = v as ThoughtCacheEntry
  return typeof v === 'object' && v !== null && typeof x.h === 'string' && Array.isArray(x.kos) && x.kos.every(k => typeof k === 'string')
}

/**
 * What background work calls on the engine. A mod spells `$` only as `$.noun.event(...)`, so
 * these are closures a hook builds over its own `$` (session.start's, else turn.start's); they
 * keep working after that hook returned.
 */
type Io = {
  complete: Complete
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  after: (ms: number, fn: () => void) => () => void
  invalidate: () => void
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  home: () => Promise<string | undefined>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

/** One thought of the main conversation: `live` while its block is still streaming, `gone` when it came empty. */
type Thought = { id: string; source: string; live: boolean; gone?: boolean }

/** A thought drawn above a reply: one of this run's, or a translation restored from the cache. */
type InlineThought = Thought | { ko: string }

/** A reply block of this run and the thoughts that came before it in its turn. */
type Attached = { text: string; isOpen: boolean; thoughts: Thought[]; requestId?: string }

/** How a thought is drawn: a status line, or markdown (dim for an untranslated original). */
type ThoughtView = { status: string } | { markdown: string; dim: boolean }

function optionText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const register: Register = (on, options) => {
  const geminiKey = optionText(options.gemini_api_key)
  const geminiModel = optionText(options.gemini_model) || DEFAULT_GEMINI_MODEL
  const claudeModel = optionText(options.claude_model) || DEFAULT_CLAUDE_MODEL
  const backend = geminiKey ? `gemini:${geminiModel}` : `claude:${claudeModel}`

  /** The engine calls background work makes (see Io). */
  let io: Io | undefined
  /** A turn started since this module loaded: replies drawn before that are history. */
  let armed = false
  /** Message ids first drawn before any turn (resumed history): left as written unless cached. */
  const history = new Set<string>()
  /** Ids whose cache entry was already looked up. */
  const looked = new Set<string>()
  const tracker = new StreamTracker()
  const collector = new ThoughtCollector()
  const thoughts: Thought[] = []
  /** Thoughts of a turn not yet drawn above a reply, by turn id. */
  const unplaced = new Map<string, Thought[]>()
  const attached: Attached[] = []
  /** Reply block (message id) → the thoughts drawn above it. */
  const aboveReply = new Map<string, InlineThought[]>()
  const lookedThoughts = new Set<string>()
  const cachedThoughts = new Set<string>()
  /** A thinking block arrived without text (thinking summaries off). */
  let omitted = false
  /** This module wrote showThinkingSummaries to the user's settings (takes effect on restart). */
  let summariesWritten = false

  const need = (): Io => {
    if (!io) throw new Error('no engine handle yet')
    return io
  }

  const timers: Timers = { after: (ms, fn) => need().after(ms, fn) }

  // ---- log: status lines only (no source text, no translation, no key) ----
  const lines: string[] = []
  let logPath: string | null | undefined
  let flushArmed = false

  const log = (line: string): void => {
    lines.push(`${new Date().toISOString()} ${redact(line)}`)
    if (lines.length > LOG_MAX_LINES) lines.splice(0, lines.length - LOG_MAX_LINES)
    if (flushArmed || !io) return
    flushArmed = true
    try {
      timers.after(LOG_FLUSH_MS, () => {
        flushArmed = false
        void flushLog()
      })
    } catch {
      flushArmed = false
    }
  }

  const flushLog = async (): Promise<void> => {
    const x = io
    if (!x) return
    try {
      if (logPath === undefined) {
        const home = await x.home()
        logPath = home ? `${home.replace(/[\\/]+$/, '')}/.claude/thinking-ko/thinking-ko.log` : null
        if (logPath) {
          const old = await x.read(logPath).catch(() => '')
          lines.unshift(...old.split('\n').filter(Boolean))
          if (lines.length > LOG_MAX_LINES) lines.splice(0, lines.length - LOG_MAX_LINES)
        }
      }
      if (logPath) await x.write(logPath, `${lines.join('\n')}\n`)
    } catch {
      // A log that cannot be written never stops the translation.
    }
  }

  // ---- redraw ----
  const redraw = (): void => {
    try {
      io?.invalidate()
    } catch {
      // nothing drawn yet
    }
  }

  // ---- reply cache ($.store, by message id) ----
  let cacheWrites: Promise<void> = Promise.resolve()

  const readCache = async (get: (key: string) => Promise<unknown>, requestId: string, source: string): Promise<string | undefined> => {
    try {
      const v = await get(CACHE_PREFIX + requestId)
      return isCacheEntry(v) && v.h === shortHash(source) ? v.ko : undefined
    } catch {
      return undefined
    }
  }

  /** Keeps `value` under `prefix + requestId`, the newest MAX_CACHE_ENTRIES per prefix. */
  const putCache = (prefix: string, indexKey: string, requestId: string, value: unknown): void => {
    const x = io
    if (!x) return
    cacheWrites = cacheWrites
      .then(async () => {
        await x.storeSet(prefix + requestId, value)
        const raw = await x.storeGet(indexKey)
        const index = (Array.isArray(raw) ? raw : []).filter((k): k is string => typeof k === 'string' && k !== requestId)
        index.push(requestId)
        for (const old of index.splice(0, Math.max(0, index.length - MAX_CACHE_ENTRIES))) {
          await x.storeDelete(prefix + old)
        }
        await x.storeSet(indexKey, index)
      })
      .catch((e: unknown) => log(`fail cache-write err=${JSON.stringify(clip(String(e), 160))}`))
  }

  const writeCache = (id: string, source: string, ko: string): void => {
    if (ko.length > MAX_CACHED_CHARS) return
    putCache(CACHE_PREFIX, CACHE_INDEX, id.slice(0, id.lastIndexOf('#')), { h: shortHash(source), ko } satisfies CacheEntry)
  }

  // ---- translation: one pool per kind (thinking 2 requests at a time, replies 1, as the original) ----
  const request = (kind: TranslationKind) => (source: string, signal: AbortSignal) => {
    const x = need()
    return geminiKey
      ? geminiRequest(x.fetch, geminiModel, geminiKey, source, kind)
      : claudeRequest(x.complete, claudeModel, source, timeoutFor(source), signal, kind)
  }

  const answers = new TranslationManager({
    backend,
    kind: 'answer',
    slots: new Slots(1),
    concurrency: 1,
    timers,
    now: Date.now,
    log,
    onChange: redraw,
    onDone: writeCache,
    request: request('answer'),
  })

  const thinker = new TranslationManager({
    backend,
    kind: 'thinking',
    slots: new Slots(2),
    concurrency: 2,
    timers,
    now: Date.now,
    log,
    onChange: redraw,
    request: request('thinking'),
  })

  const viewOf = (t: InlineThought): ThoughtView => {
    if ('ko' in t) return { markdown: t.ko, dim: false }
    if (t.live) return { status: STREAMING_THINKING }
    const st = thinker.get(t.id)
    if (st?.status === 'done') return { markdown: st.ko, dim: false }
    if (st?.status === 'pending') return { status: st.retry ? PENDING_THINKING_RETRY : PENDING_THINKING }
    return { markdown: t.source, dim: true } // failed: the original
  }

  /** A thinking block of the main conversation ended: translate it, or note it came empty. */
  const thoughtEnded = (live: Thought, id: string, text: string): void => {
    const source = trimBlankLines(text)
    if (!source.trim()) {
      live.gone = true
      live.live = false
      const at = thoughts.indexOf(live)
      if (at >= 0) thoughts.splice(at, 1)
      if (!omitted) log('thinking arrived without text (thinking summaries off)')
      omitted = true
      return
    }
    omitted = false
    live.id = answerId(id, source)
    live.source = source
    live.live = false
    thinker.enqueue(live.id, source)
  }

  /** The quote drawn above a reply for its thoughts; '' when there is none to show. */
  const quoteOf = (list: readonly InlineThought[]): string =>
    list
      .filter(t => !('gone' in t && t.gone))
      .map(t => {
        const view = viewOf(t)
        if ('status' in view) return `> ✻ _${view.status}_`
        return quoteBlock(view.markdown, view.dim ? '✻ (번역 실패, 원문) ' : '✻ ')
      })
      .join('\n>\n')

  /**
   * The thoughts above the reply block `requestId`: the ones that came before it in its turn,
   * matched by its text (claimed for good once the block is complete), else those cached for it.
   */
  const thoughtsAbove = async (
    get: (key: string) => Promise<unknown>,
    requestId: string,
    source: string,
  ): Promise<InlineThought[] | undefined> => {
    const known = aboveReply.get(requestId)
    if (known) return known
    const key = sameTextKey(source)
    for (const a of attached) {
      if (a.requestId !== undefined) continue
      const text = sameTextKey(a.text)
      if (!a.isOpen && text === key) {
        a.requestId = requestId
        aboveReply.set(requestId, a.thoughts)
        return a.thoughts
      }
      if (a.isOpen && key && text.startsWith(key)) return a.thoughts
    }
    if (lookedThoughts.has(requestId)) return undefined
    lookedThoughts.add(requestId)
    try {
      const v = await get(THOUGHT_PREFIX + requestId)
      if (isThoughtCacheEntry(v) && v.h === shortHash(source)) {
        const restored = v.kos.map(ko => ({ ko }))
        aboveReply.set(requestId, restored)
        cachedThoughts.add(requestId)
        return restored
      }
    } catch {
      // no cache
    }
    return undefined
  }

  /** Caches the translated thoughts above a reply block once all of them are settled. */
  const cacheThoughts = (requestId: string, source: string, list: readonly InlineThought[]): void => {
    if (cachedThoughts.has(requestId)) return
    const kos: string[] = []
    for (const t of list) {
      if ('ko' in t) kos.push(t.ko)
      else if (t.gone) continue
      else {
        const st = thinker.get(t.id)
        if (t.live || st === undefined || st.status === 'pending') return // not settled yet
        if (st.status === 'done') kos.push(st.ko)
      }
    }
    cachedThoughts.add(requestId)
    if (kos.length === 0 || kos.join('').length > MAX_CACHED_CHARS) return
    putCache(THOUGHT_PREFIX, THOUGHT_INDEX, requestId, { h: shortHash(source), kos } satisfies ThoughtCacheEntry)
  }

  /**
   * Turns thinking summaries on when the person presses the band's button: adds
   * `"showThinkingSummaries": true` to the user settings file, after saving a backup beside it.
   * A file that does not parse as a JSON object is left alone. Answers a line to show.
   */
  const turnOnSummaries = async (): Promise<string> => {
    const x = need()
    const home = await x.home()
    if (!home) return '홈 폴더를 못 찾아서 못 켯어. settings.json에 "showThinkingSummaries": true를 직접 넣어줘.'
    const path = `${home.replace(/[\\/]+$/, '')}/.claude/settings.json`
    const text = await x.read(path).catch(() => '')
    let settings: Record<string, unknown> = {}
    if (text.trim()) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        settings = parsed as Record<string, unknown>
      } catch {
        log('settings not changed: settings.json does not parse')
        return 'settings.json을 못 읽어서 안 건드렷어. 거기에 "showThinkingSummaries": true를 직접 넣어줘.'
      }
      await x.write(`${path}.thinking-ko.bak`, text)
    }
    await x.write(path, `${JSON.stringify({ ...settings, showThinkingSummaries: true }, null, 2)}\n`)
    summariesWritten = true
    log('settings showThinkingSummaries=true written')
    redraw()
    return RESTART_HINT
  }

  // ---- hooks ----
  on('session.start', async ($, e, next) => {
    io = {
      complete: (req, opt) => $.model.complete(req, opt),
      fetch: (url, init) => $.http.fetch(url, init),
      after: (ms, fn) => {
        const t = $.clock.after(ms, fn)
        return () => t.cancel()
      },
      invalidate: () => $.ui.invalidate('ui.render'),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeDelete: key => $.store.delete(key),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
    }
    await $.command.register({ name: 'thinking-ko', description: '최근 생각(thinking) 번역을 패널로 보기' })
    log(`start backend=${backend}`)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear and exit: drop work in flight; finished reply translations stay cached.
    answers.reset()
    thinker.reset()
    thoughts.length = 0
    unplaced.clear()
    attached.length = 0
    await flushLog()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A module loaded without session.start (it fires again on a reload) builds the same here.
    io ??= {
      complete: (req, opt) => $.model.complete(req, opt),
      fetch: (url, init) => $.http.fetch(url, init),
      after: (ms, fn) => {
        const t = $.clock.after(ms, fn)
        return () => t.cancel()
      },
      invalidate: () => $.ui.invalidate('ui.render'),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeDelete: key => $.store.delete(key),
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
    }
    armed = true
    return next(e)
  })

  // Reads the response as it streams: which text block is still being written, and the text
  // of each thinking block of the main conversation. Every chunk is passed on unchanged.
  on('turn.step', async function* ($, e, next) {
    const step = tracker.begin()
    const thinking = e.agentId === undefined ? collector.begin() : undefined
    const live = new Map<number, Thought>()
    const close = (closed: { index: number; text: string } | undefined): void => {
      const t = closed && live.get(closed.index)
      if (t && closed) thoughtEnded(t, `th:${e.turnId}:${e.index}:${closed.index}`, closed.text)
    }
    // The reply block being written, with the turn's thoughts that came before it.
    let reply: { index: number; at: Attached } | undefined
    const endReply = (): void => {
      if (reply) reply.at.isOpen = false
      reply = undefined
    }
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        let changed = false
        if (chunk.kind === 'text') changed = tracker.text(step, chunk.index, chunk.text)
        else if ('index' in chunk && typeof chunk.index === 'number') changed = tracker.other(step, chunk.index)
        if (thinking !== undefined && 'index' in chunk && typeof chunk.index === 'number') {
          if (chunk.kind === 'text' && reply?.index === chunk.index) reply.at.text += chunk.text
          else if (chunk.kind === 'text' || reply !== undefined) {
            endReply()
            const before = unplaced.get(e.turnId) ?? []
            if (chunk.kind === 'text' && before.length > 0) {
              const at: Attached = { text: chunk.text, isOpen: true, thoughts: before.splice(0) }
              attached.push(at)
              if (attached.length > MAX_ATTACHED) attached.splice(0, attached.length - MAX_ATTACHED)
              reply = { index: chunk.index, at }
              changed = true
            }
          }
        }
        if (thinking !== undefined) {
          if (chunk.kind === 'thinking') {
            const { opened, closed } = collector.thinking(thinking, chunk.index, chunk.text)
            close(closed)
            if (opened) {
              const t: Thought = { id: '', source: '', live: true }
              live.set(chunk.index, t)
              thoughts.push(t)
              unplaced.set(e.turnId, [...(unplaced.get(e.turnId) ?? []), t])
              if (thoughts.length > MAX_THOUGHTS) thoughts.splice(0, thoughts.length - MAX_THOUGHTS)
            }
            changed ||= opened || closed !== undefined
          } else if ('index' in chunk && typeof chunk.index === 'number') {
            const closed = collector.other(thinking, chunk.index)
            close(closed)
            changed ||= closed !== undefined
          }
        }
        if (changed) redraw()
        yield chunk
      }
    } finally {
      tracker.end(step)
      endReply()
      if (thinking !== undefined) close(collector.end(thinking))
      // A block left live (the stream was cut) is dropped rather than shown as thinking forever.
      for (const t of live.values()) if (t.live && thoughts.includes(t)) thoughts.splice(thoughts.indexOf(t), 1)
      redraw()
    }
    return await stream.result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const source = trimBlankLines(e.props.text)
    if (!source.trim()) return next(e)
    const id = answerId(e.requestId, source)

    if (!answers.get(id) && !looked.has(id)) {
      looked.add(id)
      const cached = await readCache(key => $.store.get(key), e.requestId, source)
      if (cached !== undefined) answers.restore(id, cached)
    }

    if (!answers.get(id)) {
      if (!armed) history.add(e.requestId)
      // History is shown as written (no retroactive translation); so is a block still being generated.
      if (!history.has(e.requestId) && !tracker.isGenerating(source)) answers.enqueue(id, source)
    }

    const above = await thoughtsAbove(key => $.store.get(key), e.requestId, source)
    if (above && aboveReply.has(e.requestId)) cacheThoughts(e.requestId, source, above)
    const quote = above ? quoteOf(above) : ''
    const body = displayText(source, answers.get(id)) ?? source
    if (!quote && body === source) return next(e)
    return next({ ...e, props: { ...e.props, text: quote ? `${quote}\n\n${body}` : body } })
  })

  // The band above the prompt: thinking progress; or, while Claude Code receives no thinking text,
  // a button that turns thinking summaries on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const last = thoughts.at(-1)
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!last) {
      if (summariesWritten) {
        return (
          <Box flexDirection="column">
            <Text dimColor>✻ {RESTART_HINT}</Text>
          </Box>
        )
      }
      const merged = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
      if (!omitted && merged.showThinkingSummaries === true) return next(e)
      return (
        <Box flexDirection="column">
          <Text dimColor>✻ thinking-ko · {OMITTED_HINT}</Text>
          <Button
            key="enable-summaries"
            label="생각 요약 켜기"
            onPress={() => {
              void turnOnSummaries().then(
                msg => $.ui.toast(msg),
                () => $.ui.toast('설정 파일을 못 고쳣어. settings.json에 "showThinkingSummaries": true를 직접 넣어줘.'),
              )
            }}
          />
        </Box>
      )
    }
    // Progress only: the translated thought itself is drawn above its reply.
    const busy = [...thoughts].reverse().find(t => 'status' in viewOf(t))
    if (!busy) return next(e)
    const view = viewOf(busy)
    return (
      <Box flexDirection="column">
        <Text dimColor>✻ {'status' in view ? view.status : ''}</Text>
      </Box>
    )
  })

  on('command.run', { command: 'thinking-ko' }, async $ => {
    await $.ui.open({ id: PANE_ID, title: '생각 번역' })
    return { text: '생각 번역 패널을 열었어.' }
  })

  // The pane: recent thoughts, oldest first.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Markdown, Text } = $.ui.resolve(e)
    if (thoughts.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{summariesWritten ? RESTART_HINT : omitted ? OMITTED_HINT : '아직 옮긴 생각이 없어.'}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {thoughts.map((t, i) => {
          const view = viewOf(t)
          return (
            <Box key={`t${i}`} flexDirection="column" marginBottom={1}>
              {'status' in view ? (
                <Text dimColor>✻ {view.status}</Text>
              ) : (
                <Markdown text={view.markdown} dimColor={view.dim} />
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
