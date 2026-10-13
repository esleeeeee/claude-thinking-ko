// thinking-ko for Claude Code: shows Claude's replies in casual Korean (반말·구어체).
//
// It changes the drawing only. The `AssistantMessage` render site is rewritten with
// `next({ ...e, props: { ...e.props, text } })`, which the engine documents as changing
// the drawing and leaving the stored message alone (ctrl+o shows the original). Nothing
// is appended to the session and no request the model sees is changed.
//
// Flow: a reply block is drawn as written; the translation runs in the background
// (core.ts: ordered queue, request slots, deadline, one retry); when it finishes,
// `$.ui.invalidate('ui.render')` draws the block again with the translation. While the
// block is still being generated it stays as written; while waiting it gets a short mark.
//
// Thinking is not translated: in this build the thinking blocks reach plugins without
// their text (signature only), so there is nothing to translate. See README.
import type { HttpInit, HttpResponse, Register } from 'claude-code'

import { answerId, clip, displayText, redact, shortHash, StreamTracker, timeoutFor, TranslationManager, trimBlankLines } from './core'
import type { Timers } from './core'
import { claudeRequest, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, geminiRequest } from './translators'
import type { Complete } from './translators'

/** Translations kept in `$.store` (per message id), oldest dropped first. */
export const MAX_CACHE_ENTRIES = 100
/** A translation longer than this is shown but not cached ($.store holds 4 MiB in all). */
export const MAX_CACHED_CHARS = 8000
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

  // ---- cache ($.store, by message id) ----
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

  // ---- translation ----
  const manager = new TranslationManager({
    backend,
    timers,
    now: Date.now,
    log,
    onChange: redraw,
    onDone: writeCache,
    request: (source, signal) => {
      const x = need()
      return geminiKey
        ? geminiRequest(x.fetch, geminiModel, geminiKey, source)
        : claudeRequest(x.complete, claudeModel, source, timeoutFor(source), signal)
    },
  })

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
    log(`start backend=${backend}`)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear and exit: drop work in flight; finished translations stay cached.
    manager.reset()
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

  // Watches the reply as it streams, to tell a block still being written from a finished
  // one. Every chunk is passed on unchanged.
  on('turn.step', async function* ($, e, next) {
    const step = tracker.begin()
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        let closed = false
        if (chunk.kind === 'text') closed = tracker.text(step, chunk.index, chunk.text)
        else if ('index' in chunk && typeof chunk.index === 'number') closed = tracker.other(step, chunk.index)
        if (closed) redraw()
        yield chunk
      }
    } finally {
      tracker.end(step)
      redraw()
    }
    return await stream.result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const source = trimBlankLines(e.props.text)
    if (!source.trim()) return next(e)
    const id = answerId(e.requestId, source)

    if (!manager.get(id) && !looked.has(id)) {
      looked.add(id)
      const cached = await readCache(key => $.store.get(key), e.requestId, source)
      if (cached !== undefined) manager.restore(id, cached)
    }

    if (!manager.get(id)) {
      if (!armed) history.add(e.requestId)
      // History is shown as written (no retroactive translation); so is a block still being generated.
      if (history.has(e.requestId) || tracker.isGenerating(source)) return next(e)
      manager.enqueue(id, source)
    }

    const text = displayText(source, manager.get(id))
    return text === undefined ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
}
