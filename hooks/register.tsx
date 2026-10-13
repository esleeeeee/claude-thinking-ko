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
// Thinking: there is no render site for thinking blocks, so it is not replaced in place. The
// thinking text is read from the response stream (`turn.step` thinking chunks) as each block
// ends, translated the same way, and shown in the band above the prompt (latest thought) and
// in the `/thinking-ko` pane (recent thoughts). Claude Code only receives thinking text when
// thinking summaries are on (`"showThinkingSummaries": true`); without it the blocks arrive
// empty and the band says so.
import type { HttpInit, HttpResponse, Register } from 'claude-code'

import {
  answerId,
  clip,
  displayText,
  headLines,
  PENDING_THINKING,
  PENDING_THINKING_RETRY,
  redact,
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
/** Thoughts kept for the band and the pane. */
export const MAX_THOUGHTS = 20
/** Lines of the latest thought the band shows at most. */
export const BAND_MAX_LINES = 10
export const PANE_ID = 'thinking-ko'
export const COMMAND = 'thinking-ko'
/** Shown while Claude Code does not receive thinking text (thinking summaries off). */
export const OMITTED_HINT = '생각 요약이 꺼져 잇어서 생각을 못 옮겨. 아래 버튼 누르면 켜줄게.'
/** Shown once the setting was written: it takes effect on the next start. */
export const RESTART_HINT = '생각 요약 켯어. Claude Code(앱)를 완전히 껏다 켜면 생각이 번역돼.'
const CACHE_PREFIX = 't:'
const CACHE_INDEX = 'cache-index'
const LOG_MAX_LINES = 500
const LOG_FLUSH_MS = 2000

type CacheEntry = { h: string; ko: string }

function isCacheEntry(v: unknown): v is CacheEntry {
  return typeof v === 'object' && v !== null && typeof (v as CacheEntry).h === 'string' && typeof (v as CacheEntry).ko === 'string'
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

/** One thought of the main conversation: `live` while its block is still streaming. */
type Thought = { id: string; source: string; live: boolean }

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

  const writeCache = (id: string, source: string, ko: string): void => {
    const x = io
    if (!x || ko.length > MAX_CACHED_CHARS) return
    const requestId = id.slice(0, id.lastIndexOf('#'))
    cacheWrites = cacheWrites
      .then(async () => {
        await x.storeSet(CACHE_PREFIX + requestId, { h: shortHash(source), ko } satisfies CacheEntry)
        const raw = await x.storeGet(CACHE_INDEX)
        const index = (Array.isArray(raw) ? raw : []).filter((k): k is string => typeof k === 'string' && k !== requestId)
        index.push(requestId)
        for (const old of index.splice(0, Math.max(0, index.length - MAX_CACHE_ENTRIES))) {
          await x.storeDelete(CACHE_PREFIX + old)
        }
        await x.storeSet(CACHE_INDEX, index)
      })
      .catch((e: unknown) => log(`fail cache-write err=${JSON.stringify(clip(String(e), 160))}`))
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

  const viewOf = (t: Thought): ThoughtView => {
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
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        let changed = false
        if (chunk.kind === 'text') changed = tracker.text(step, chunk.index, chunk.text)
        else if ('index' in chunk && typeof chunk.index === 'number') changed = tracker.other(step, chunk.index)
        if (thinking !== undefined) {
          if (chunk.kind === 'thinking') {
            const { opened, closed } = collector.thinking(thinking, chunk.index, chunk.text)
            close(closed)
            if (opened) {
              const t: Thought = { id: '', source: '', live: true }
              live.set(chunk.index, t)
              thoughts.push(t)
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
      if (history.has(e.requestId) || tracker.isGenerating(source)) return next(e)
      answers.enqueue(id, source)
    }

    const text = displayText(source, answers.get(id))
    return text === undefined ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  // The band above the prompt: the latest thought, translated; or, while Claude Code receives no
  // thinking text, a button that turns thinking summaries on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const last = thoughts.at(-1)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
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
    const view = viewOf(last)
    if ('status' in view) {
      return (
        <Box flexDirection="column">
          <Text dimColor>✻ {view.status}</Text>
        </Box>
      )
    }
    const room = Math.max(2, Math.min(BAND_MAX_LINES, e.props.maxRows - 2))
    const shown = headLines(view.markdown, room)
    return (
      <Box flexDirection="column">
        <Text dimColor>✻ 생각{view.dim ? ' (번역 실패, 원문)' : ''}</Text>
        <Markdown text={shown.text} dimColor={view.dim} />
        {shown.cut && <Text dimColor>… 전체는 /{COMMAND}</Text>}
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
