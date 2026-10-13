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
// it is. The thinking text is read from the response stream (`turn.step` thinking chunks) while
// it streams; each finished sentence or paragraph is translated right away. The turn's thoughts not
// yet followed by reply text are drawn in the transcript as they come in: on the terminal above the
// engine's own progress row (`Spinner`, wrapped, not replaced); elsewhere (the desktop draws its
// progress row on one line) under the latest row before them, the turn's prompt (`UserMessage`) or
// its latest tool call (`ToolUse`, or the folded `ToolGroup` holding it), wrapped the same way; while
// no such row is known, in the band above the prompt. Once reply text follows them, they are
// drawn at the top of that reply block instead (`thinking_in_reply`, on by default). When a
// thinking block ends, what follows it in the stream waits a moment (at most HOLD_MS, inside the
// hook's budget) for that thought's last part to be translated, so the Korean thought shows before
// the reply (`thinking_first`, on by default); chunks are never changed. A fold button keeps only
// the latest lines. The `/thinking-ko` pane lists recent thoughts. Claude Code
// only receives thinking text when thinking summaries are on (`"showThinkingSummaries": true`, which
// the terminal does not have by default): where no settings file says anything about them, the
// module turns them on at start (`auto_thinking_summaries`, with a backup); when a thinking block
// arrives empty anyway, the band above the prompt says so (with a button while the setting is off).
import type { Elements, HttpInit, HttpResponse, Register, RenderElement, RenderSurface } from 'claude-code'

import {
  answerId,
  clip,
  displayText,
  PENDING_THINKING,
  PENDING_THINKING_RETRY,
  redact,
  sameTextKey,
  shortHash,
  Slots,
  StreamTracker,
  STREAMING_THINKING,
  tailLines,
  takeThoughtParts,
  ThoughtCollector,
  timeoutFor,
  TranslationManager,
  trimBlankLines,
} from './core'
import type { ThoughtPart, Timers, TranslationKind } from './core'
import { claudeRequest, DEFAULT_CLAUDE_MODEL, DEFAULT_GEMINI_MODEL, geminiRequest } from './translators'
import type { Complete } from './translators'

/** Translations kept in `$.store` (per message id), oldest dropped first. */
export const MAX_CACHE_ENTRIES = 100
/** A translation longer than this is shown but not cached ($.store holds 4 MiB in all). */
export const MAX_CACHED_CHARS = 8000
/** Thoughts kept for the pane. */
export const MAX_THOUGHTS = 20
/** Lines of live thinking drawn above the progress row at most (the latest ones). */
export const LIVE_MAX_LINES = 20
/** The same, while folded. */
export const LIVE_FOLDED_LINES = 3
/** How long what follows a thinking block may wait for that thought's translation. */
export const HOLD_MS = 3000
/** Budget a hold always leaves the turn.step hook (HookBudget: 10 s of its own time per response). */
const HOLD_BUDGET_MARGIN_MS = 4000
/** Thinking paragraphs that may wait for translation before the oldest is shown untranslated. */
const THINKING_MAX_PENDING = 24
/** Reply blocks remembered with the thoughts that came before them. */
const MAX_ATTACHED = 50
/** Prompt rows and tool calls remembered as drawn (where live thoughts may go under them). */
const MAX_ROWS = 1000
/** How much of a prompt is compared to find its row. */
const PROMPT_KEY_CHARS = 2000
export const PANE_ID = 'thinking-ko'
export const COMMAND = 'thinking-ko'
/**
 * Where the fold toggle links off the terminal. The press is the module's to answer, so a surface
 * opens nothing; one that opened it anyway would show this project's page.
 */
export const FOLD_HREF = 'https://github.com/esleeeeee/claude-thinking-ko#fold'
/** Shown when thinking blocks arrive without their text (thinking summaries off). */
export const OMITTED_HINT = '생각 요약이 꺼져 있어서 생각을 옮길 수 없어. 아래 버튼을 누르면 켜 줄게.'
/** Shown once the setting was written: it takes effect on the next start. */
export const RESTART_HINT = '생각 요약을 켰어. Claude Code를 완전히 껐다 켜면 생각이 번역돼.'
/** Shown when thinking arrives empty although the setting is on (an older choice of the app stands until a restart). */
export const SUMMARIES_ON_HINT = '생각 요약은 켜져 있는데 생각이 비어서 와. Claude Code를 완전히 껐다 켜 줘.'
/** Shown once when the plugin turned thinking summaries on by itself. */
export const AUTO_SUMMARIES_NOTE =
  'thinking-ko: 생각 번역에 필요한 생각 요약(showThinkingSummaries)을 settings.json에 켜 뒀어. 원래 파일은 settings.json.thinking-ko.bak에 있어.'
/** Marks a thinking paragraph whose translation failed. */
export const FAILED_MARK = '(번역 실패, 원문)'
const CACHE_PREFIX = 't:'
const CACHE_INDEX = 'cache-index'
const THOUGHT_PREFIX = 'k:'
const THOUGHT_INDEX = 'thought-index'
/** Where the band's folded state is kept across sessions. */
const COLLAPSED_KEY = 'band-collapsed'
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

/** One part of a thought (finished sentences or a paragraph), translated on its own. */
type Segment = { id: string; source: string; sep: ThoughtPart['sep'] }

/**
 * One thinking block of the main conversation: its text so far (`buffer`), how much of it was
 * handed to translation (`consumed`), the paragraphs handed over, `live` while it streams and
 * `gone` when it ended empty.
 */
type Thought = {
  turnId: string
  key: string
  buffer: string
  consumed: number
  segments: Segment[]
  live: boolean
  gone?: boolean
}

/** A thought drawn above a reply: one of this run's, or a translation restored from the cache. */
type InlineThought = Thought | { ko: string }

/** A reply block of this run and the thoughts that came before it in its turn. */
type Attached = { turnId: string; text: string; isOpen: boolean; thoughts: Thought[]; requestId?: string }

/** A row of the turn that live thoughts may be drawn under: its prompt (by text), or a tool call. */
type Anchor = { kind: 'prompt'; key: string } | { kind: 'tool'; id: string }

/** Where the live thoughts are drawn off the terminal: under a prompt row, a tool row or a folded group. */
type Spot = { site: 'UserMessage'; requestId: string } | { site: 'ToolUse' | 'ToolGroup'; id: string }

/** The elements the thought blocks are drawn with (every surface has them). */
type Els = Pick<Elements[RenderSurface], 'Box' | 'Button' | 'Markdown' | 'Text'>

/** A prompt as compared with its row: spaces folded, its start only (a pasted prompt can be long). */
function promptKey(text: string): string {
  return sameTextKey(text.slice(0, PROMPT_KEY_CHARS * 2)).slice(0, PROMPT_KEY_CHARS)
}

/** Whether one text is the other, or holds it (a prompt row may show less or more than the turn's text). */
function sameish(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a)))
}

function optionText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const register: Register = (on, options) => {
  const geminiKey = optionText(options.gemini_api_key)
  const geminiModel = optionText(options.gemini_model) || DEFAULT_GEMINI_MODEL
  const claudeModel = optionText(options.claude_model) || DEFAULT_CLAUDE_MODEL
  const thinkingInReply = options.thinking_in_reply !== false
  const thinkingFirst = options.thinking_first !== false
  const autoSummaries = options.auto_thinking_summaries !== false
  const backend = geminiKey ? `gemini:${geminiModel}` : `claude:${claudeModel}`

  /** The engine calls background work makes (see Io). */
  let io: Io | undefined
  /** A turn started since this module loaded: replies drawn before that are history. */
  let armed = false
  /** The turn the band shows thinking for: the latest one started. */
  let currentTurn: string | undefined
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
  /** The band shows only the latest line of thinking (the person folded it). */
  let collapsed = false
  /** The rows of each turn its live thoughts may be drawn under, in stream order (the current turn's). */
  const anchors = new Map<string, Anchor[]>()
  /** Prompt rows drawn off the terminal, in the order first drawn: their text (promptKey). */
  const userRows = new Map<string, string>()
  /** Counts the rows added to userRows. */
  let userSeq = 0
  /** Tool calls whose row was drawn off the terminal: on a row of its own, or in a folded group. */
  const toolRows = new Map<string, 'use' | 'group'>()

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
  /** Checks run on every change (a hold waiting for a thought to be translated). */
  const waiters = new Set<() => void>()

  const redraw = (): void => {
    try {
      io?.invalidate()
    } catch {
      // nothing drawn yet
    }
    for (const check of [...waiters]) check()
  }

  /** Render sites already noted in the log (component and surface), for diagnosis. */
  const sitesLogged = new Set<string>()
  const noteSite = (what: string): void => {
    if (sitesLogged.has(what)) return
    sitesLogged.add(what)
    log(`render ${what}`)
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
    maxPending: THINKING_MAX_PENDING,
    timers,
    now: Date.now,
    log,
    onChange: redraw,
    request: request('thinking'),
  })

  // ---- thinking ----

  /** Hands the thought's finished sentences and paragraphs (all of it when `final`) to translation. */
  const feed = (t: Thought, final: boolean): boolean => {
    const { parts, next } = takeThoughtParts(t.buffer, t.consumed, final)
    t.consumed = next
    for (const part of parts) {
      const seg: Segment = { id: answerId(`${t.key}:${t.segments.length}`, part.text), source: part.text, sep: part.sep }
      t.segments.push(seg)
      thinker.enqueue(seg.id, part.text)
    }
    return parts.length > 0
  }

  /** A thinking block of the main conversation ended: translate what is left, or note it came empty. */
  const thoughtEnded = (t: Thought): void => {
    t.live = false
    feed(t, true)
    if (t.segments.length > 0) {
      omitted = false
      return
    }
    t.gone = true
    const at = thoughts.indexOf(t)
    if (at >= 0) thoughts.splice(at, 1)
    if (!omitted) log('thinking arrived without text (thinking summaries off)')
    omitted = true
  }

  /** The thought as markdown: translated paragraphs, the untranslated ones marked, and what is still coming. */
  const markdownOf = (t: InlineThought): string => {
    if ('ko' in t) return t.ko
    // Each part keeps what separated it from the next in the original: a paragraph break, a line
    // break or a space (finished sentences of a paragraph still being written).
    const pieces: Array<{ text: string; sep: string; isMark: boolean }> = []
    const mark = (status: string, sep: string): void => {
      if (pieces.at(-1)?.isMark) return
      pieces.push({ text: `_${status}_`, sep, isMark: true })
    }
    for (const seg of t.segments) {
      const st = thinker.get(seg.id)
      if (st?.status === 'done') pieces.push({ text: st.ko, sep: seg.sep, isMark: false })
      else if (st?.status === 'pending') mark(st.retry ? PENDING_THINKING_RETRY : PENDING_THINKING, seg.sep)
      else pieces.push({ text: `_${FAILED_MARK}_ ${seg.source}`, sep: seg.sep, isMark: false })
    }
    if (t.live) mark(STREAMING_THINKING, '')
    return pieces.map((p, i) => (i < pieces.length - 1 ? p.text + p.sep : p.text)).join('')
  }

  /** Whether every paragraph of the thought is settled (translated or failed). */
  const settled = (t: InlineThought): boolean =>
    'ko' in t || (!t.live && t.segments.every(seg => thinker.get(seg.id)?.status !== 'pending'))

  /**
   * The thoughts as markdown to draw: all of them, the latest `maxLines` lines at most; folded,
   * only the latest line. '' when there is none to show.
   */
  const thoughtsText = (
    list: readonly InlineThought[],
    maxLines = Number.POSITIVE_INFINITY,
    foldedLines = 1,
  ): { text: string; cut: boolean } => {
    const markdown = list
      .filter(t => !('gone' in t && t.gone))
      .map(t => markdownOf(t) || `_${STREAMING_THINKING}_`)
      .join('\n\n')
    if (!markdown) return { text: '', cut: false }
    if (collapsed) {
      const lines = markdown.split('\n').filter(l => l.trim())
      return { text: lines.slice(-foldedLines).join('\n\n'), cut: lines.length > foldedLines }
    }
    return Number.isFinite(maxLines) ? tailLines(markdown, maxLines) : { text: markdown, cut: false }
  }

  /**
   * Waits until every part of the thought is translated (or failed), `ms` at most, or until the
   * signal aborts (the turn was interrupted).
   */
  const settledOrTimeout = (t: Thought, ms: number, signal: AbortSignal): Promise<void> =>
    new Promise(resolve => {
      let cancel: (() => void) | undefined
      const done = (): void => {
        waiters.delete(check)
        cancel?.()
        signal.removeEventListener('abort', done)
        resolve()
      }
      const check = (): void => {
        if (settled(t)) done()
      }
      if (settled(t) || !io || signal.aborted) {
        resolve()
        return
      }
      waiters.add(check)
      signal.addEventListener('abort', done, { once: true })
      try {
        cancel = io.after(ms, done)
      } catch {
        done()
      }
    })

  /** Lets the thought that just ended show in Korean before what follows it (thinking_first). */
  const holdFor = async (t: Thought, next: { signal: AbortSignal; budget: { remainingMs: number } }): Promise<void> => {
    if (!thinkingFirst || t.gone || settled(t)) return
    const ms = Math.min(HOLD_MS, next.budget.remainingMs - HOLD_BUDGET_MARGIN_MS)
    if (!(ms > 0)) return
    const started = Date.now()
    await settledOrTimeout(t, ms, next.signal)
    log(`hold ms=${Date.now() - started} settled=${settled(t)}`)
  }

  const toggleFold = (): void => {
    collapsed = !collapsed
    void io?.storeSet(COLLAPSED_KEY, collapsed).catch(() => {})
    redraw()
  }

  /** The current turn's thoughts no reply text has followed yet, as drawn live (latest lines). */
  const liveShown = (maxLines = LIVE_MAX_LINES): { text: string; cut: boolean } => {
    const pending = (currentTurn === undefined ? [] : (unplaced.get(currentTurn) ?? [])).filter(t => !t.gone)
    return pending.length > 0 ? thoughtsText(pending, maxLines, LIVE_FOLDED_LINES) : { text: '', cut: false }
  }

  /**
   * The dim `✻ 생각` header, its fold toggle drawn as text beside it: on the terminal a Button
   * without chrome; elsewhere a link the module answers, since a desktop draws every Button as a
   * native one.
   */
  const thoughtsHeader = (els: Els, surface: RenderSurface, note = ''): RenderElement => {
    const { Box, Button, Markdown, Text } = els
    if (surface === 'terminal') {
      return (
        <Box flexDirection="row">
          <Text dimColor>✻ 생각{note} · </Text>
          <Button key="fold" plain dimColor label={collapsed ? '펼치기' : '접기'} onPress={toggleFold} />
        </Box>
      )
    }
    return (
      <Markdown
        key="fold"
        dimColor
        text={`✻ 생각${note} · [${collapsed ? '▸ 펼치기' : '▾ 접기'}](${FOLD_HREF})`}
        pressableLinks={[FOLD_HREF]}
        onLinkPress={toggleFold}
      />
    )
  }

  /** The live thoughts: the header with its fold toggle, then the latest lines. */
  const liveBlock = (els: Els, surface: RenderSurface, shown: { text: string; cut: boolean }): RenderElement => {
    const { Box, Markdown } = els
    return (
      <Box flexDirection="column">
        {thoughtsHeader(els, surface, shown.cut && !collapsed ? ` · 앞부분은 /${COMMAND}` : '')}
        <Markdown text={shown.text} />
      </Box>
    )
  }

  /** The last answer of promptRow, good until a row is drawn for the first time. */
  let promptFound: { key: string; seq: number; requestId: string | undefined } | undefined

  /** The newest prompt row drawn whose text is the turn's prompt. */
  const promptRow = (key: string): string | undefined => {
    if (promptFound?.key === key && promptFound.seq === userSeq) return promptFound.requestId
    let requestId: string | undefined
    for (const [id, rowKey] of userRows) if (sameish(rowKey, key)) requestId = id // drawn in order: the last is the newest
    promptFound = { key, seq: userSeq, requestId }
    return requestId
  }

  /**
   * Where the current turn's live thoughts go off the terminal: under the latest of its prompt and
   * tool calls whose row is drawn; undefined while none is.
   */
  const liveSpot = (): Spot | undefined => {
    const list = (currentTurn === undefined ? undefined : anchors.get(currentTurn)) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i]!
      if (a.kind === 'tool') {
        const site = toolRows.get(a.id)
        if (site) return { site: site === 'use' ? 'ToolUse' : 'ToolGroup', id: a.id }
      } else {
        const requestId = promptRow(a.key)
        if (requestId !== undefined) return { site: 'UserMessage', requestId }
      }
    }
    return undefined
  }

  const spotKey = (s: Spot | undefined): string => (s === undefined ? '' : s.site === 'UserMessage' ? `u:${s.requestId}` : `${s.site}:${s.id}`)

  /** Notes a row as drawn; when that moves the live thoughts, everything is drawn again. */
  const noteRow = (add: () => boolean): void => {
    const before = spotKey(liveSpot())
    if (add() && spotKey(liveSpot()) !== before) redraw()
  }

  const notePrompt = (requestId: string, text: string): void =>
    noteRow(() => {
      if (userRows.has(requestId)) return false
      userRows.set(requestId, promptKey(text))
      userSeq++
      if (userRows.size > MAX_ROWS) userRows.delete(userRows.keys().next().value!)
      return true
    })

  // A call drawn on a row of its own stays there (a group that unfolds draws its calls as rows);
  // never back, so a surface drawing both cannot bounce the thoughts between them.
  const noteTool = (id: string, site: 'use' | 'group'): void =>
    noteRow(() => {
      const had = toolRows.get(id)
      if (had === site || had === 'use') return false
      toolRows.set(id, site)
      if (toolRows.size > MAX_ROWS) toolRows.delete(toolRows.keys().next().value!)
      return true
    })

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
      if (!a.isOpen && (text === key || (key.length >= 20 && (text.startsWith(key) || key.startsWith(text))))) {
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
    const shown = list.filter(t => !('gone' in t && t.gone))
    if (!shown.every(settled)) return
    cachedThoughts.add(requestId)
    const kos = shown.map(markdownOf).filter(Boolean)
    if (kos.length === 0 || kos.join('').length > MAX_CACHED_CHARS) return
    putCache(THOUGHT_PREFIX, THOUGHT_INDEX, requestId, { h: shortHash(source), kos } satisfies ThoughtCacheEntry)
  }

  /**
   * Turns thinking summaries on, when the person presses the band's button or at start (`auto`):
   * adds `"showThinkingSummaries": true` to the user settings file, after saving a backup beside it.
   * A file that does not parse as a JSON object is left alone, and so, at start, is a file that has
   * the key already. Answers whether it wrote, and a line to show.
   */
  const turnOnSummaries = async (by: 'button' | 'auto'): Promise<{ ok: boolean; message: string }> => {
    const x = need()
    const home = await x.home()
    if (!home) return { ok: false, message: '홈 폴더를 못 찾아서 못 켰어. settings.json에 "showThinkingSummaries": true를 직접 넣어 줘.' }
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
        return { ok: false, message: 'settings.json을 못 읽어서 건드리지 않았어. 거기에 "showThinkingSummaries": true를 직접 넣어 줘.' }
      }
      // A value set by hand (even false) is the person's choice: only the button changes it.
      if (by === 'auto' && Object.hasOwn(settings, 'showThinkingSummaries')) return { ok: false, message: '' }
      await x.write(`${path}.thinking-ko.bak`, text)
    }
    await x.write(path, `${JSON.stringify({ ...settings, showThinkingSummaries: true }, null, 2)}\n`)
    if (by === 'button') summariesWritten = true
    log(`settings showThinkingSummaries=true written by=${by}`)
    redraw()
    return { ok: true, message: by === 'button' ? RESTART_HINT : AUTO_SUMMARIES_NOTE }
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
    collapsed = (await $.store.get(COLLAPSED_KEY).catch(() => false)) === true
    await $.command.register({ name: 'thinking-ko', description: '최근 생각(thinking) 번역을 패널로 보기' })
    log(`start backend=${backend}`)
    // Thinking text reaches the engine only with thinking summaries on. Where no settings source
    // says anything about them, turn them on in the user settings (once, with a backup, said once);
    // a value someone set, false included, is left alone.
    if (autoSummaries) {
      const merged = await $.settings.read().catch((): Record<string, unknown> => ({}))
      if (merged.showThinkingSummaries === undefined) {
        const r = await turnOnSummaries('auto').catch(() => ({ ok: false, message: '' }))
        if (r.ok) $.ui.toast(r.message)
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear and exit: drop work in flight; finished reply translations stay cached.
    answers.reset()
    thinker.reset()
    thoughts.length = 0
    unplaced.clear()
    attached.length = 0
    anchors.clear()
    userRows.clear()
    toolRows.clear()
    currentTurn = undefined
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
    currentTurn = e.turnId
    // Its live thoughts go under its prompt row first (a turn without typed text has none).
    anchors.clear()
    anchors.set(e.turnId, e.text.trim() ? [{ kind: 'prompt', key: promptKey(e.text) }] : [])
    redraw()
    return next(e)
  })

  // Reads the response as it streams: which text block is still being written, and the thinking
  // of the main conversation, sentence by sentence. Every chunk is passed on unchanged; after a
  // thinking block, the next chunk may wait briefly for its translation (holdFor).
  on('turn.step', async function* ($, e, next) {
    const step = tracker.begin()
    const thinking = e.agentId === undefined ? collector.begin() : undefined
    if (thinking !== undefined) currentTurn = e.turnId
    const live = new Map<number, Thought>()
    const close = (closed: { index: number } | undefined): void => {
      const t = closed && live.get(closed.index)
      if (t) thoughtEnded(t)
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
        // A thinking block of the main conversation ends where another block begins: send its last
        // part for translation and give it a moment, so the Korean thought shows first.
        if (thinking !== undefined && chunk.kind !== 'thinking' && 'index' in chunk && typeof chunk.index === 'number') {
          const closed = collector.other(thinking, chunk.index)
          const t = closed && live.get(closed.index)
          if (t) {
            thoughtEnded(t)
            redraw()
            await holdFor(t, next)
          }
        }
        if (chunk.kind === 'text') changed = tracker.text(step, chunk.index, chunk.text)
        else if ('index' in chunk && typeof chunk.index === 'number') changed = tracker.other(step, chunk.index)
        if (thinking !== undefined && 'index' in chunk && typeof chunk.index === 'number') {
          if (chunk.kind === 'text' && reply?.index === chunk.index) reply.at.text += chunk.text
          else if (chunk.kind === 'text' || reply !== undefined) {
            endReply()
            const before = unplaced.get(e.turnId) ?? []
            if (chunk.kind === 'text' && before.length > 0) {
              const at: Attached = { turnId: e.turnId, text: chunk.text, isOpen: true, thoughts: before.splice(0) }
              attached.push(at)
              if (attached.length > MAX_ATTACHED) attached.splice(0, attached.length - MAX_ATTACHED)
              reply = { index: chunk.index, at }
              changed = true
            }
          }
        }
        // Off the terminal, the thoughts that follow a tool call go under its row once it is drawn.
        if (thinking !== undefined && chunk.kind === 'tool') {
          const list = anchors.get(e.turnId) ?? []
          list.push({ kind: 'tool', id: chunk.id })
          anchors.set(e.turnId, list)
        }
        if (thinking !== undefined) {
          if (chunk.kind === 'thinking') {
            const { opened, closed } = collector.thinking(thinking, chunk.index, chunk.text)
            close(closed)
            if (opened) {
              const t: Thought = {
                turnId: e.turnId,
                key: `th:${e.turnId}:${e.index}:${chunk.index}`,
                buffer: '',
                consumed: 0,
                segments: [],
                live: true,
              }
              live.set(chunk.index, t)
              thoughts.push(t)
              if (thoughts.length > MAX_THOUGHTS) thoughts.splice(0, thoughts.length - MAX_THOUGHTS)
              unplaced.set(e.turnId, [...(unplaced.get(e.turnId) ?? []), t])
            }
            const t = live.get(chunk.index)
            if (t) {
              t.buffer += chunk.text
              changed ||= feed(t, false)
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
      // A block left live (the stream was cut) is translated as far as it got.
      for (const t of live.values()) if (t.live) thoughtEnded(t)
      redraw()
    }
    return await stream.result
  })

  // Thoughts the turn ended with and no reply text followed: drawn above the turn's last reply.
  on('turn.complete', async ($, e, next) => {
    const left = (unplaced.get(e.turnId) ?? []).filter(t => !t.gone)
    unplaced.delete(e.turnId)
    const last = [...attached].reverse().find(a => a.turnId === e.turnId)
    if (last && left.length > 0) {
      last.thoughts.push(...left)
      redraw()
    }
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    noteSite(`site=AssistantMessage surface=${e.surface}${e.props.isSummary ? ' summary' : ''}`)
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

    const body = displayText(source, answers.get(id)) ?? source
    const reply = body === source ? next(e) : next({ ...e, props: { ...e.props, text: body } })
    if (!thinkingInReply) return reply
    const above = await thoughtsAbove(key => $.store.get(key), e.requestId, source)
    if (above && aboveReply.has(e.requestId)) cacheThoughts(e.requestId, source, above)
    const shown = above ? thoughtsText(above) : { text: '', cut: false }
    if (!shown.text) return reply
    // The reply's thoughts on top, then the engine's own drawing of the reply.
    const els = $.ui.resolve(e)
    const { Box, Markdown } = els
    return (
      <Box flexDirection="column">
        {thoughtsHeader(els, e.surface)}
        <Markdown text={shown.text} dimColor />
        {await reply}
      </Box>
    )
  })

  // The engine's progress row while a turn runs, with the turn's thoughts that no reply text has
  // followed yet drawn above it in Korean as they come in.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    noteSite(`site=Spinner surface=${e.surface}`)
    // The desktop draws its progress row on one line: the thoughts go under a transcript row there.
    if (e.surface !== 'terminal') return next(e)
    const shown = liveShown()
    if (!shown.text) return next(e)
    noteSite(`live-thinking site=Spinner surface=${e.surface}`)
    const row = await next(e)
    const els = $.ui.resolve(e)
    const { Box } = els
    return (
      <Box flexDirection="column">
        {liveBlock(els, e.surface, shown)}
        {row}
      </Box>
    )
  })

  // Off the terminal, the turn's prompt row with its live thoughts under it, until a tool call or
  // reply text follows them.
  on('ui.render', { component: 'UserMessage', surface: ['desktop', 'vscode', 'mobile'] }, async ($, e, next) => {
    noteSite(`site=UserMessage surface=${e.surface}`)
    notePrompt(e.requestId, e.props.text)
    const spot = liveSpot()
    if (spot?.site !== 'UserMessage' || spot.requestId !== e.requestId) return next(e)
    const shown = liveShown()
    if (!shown.text) return next(e)
    noteSite(`live-thinking site=UserMessage surface=${e.surface}`)
    const row = await next(e)
    const els = $.ui.resolve(e)
    const { Box } = els
    return (
      <Box flexDirection="column">
        {row}
        {liveBlock(els, e.surface, shown)}
      </Box>
    )
  })

  // Off the terminal, the turn's latest tool call with the live thoughts that followed it.
  on('ui.render', { component: 'ToolUse', surface: ['desktop', 'vscode', 'mobile'] }, async ($, e, next) => {
    noteSite(`site=ToolUse surface=${e.surface}`)
    noteTool(e.props.tool_use_id, 'use')
    const spot = liveSpot()
    if (spot?.site !== 'ToolUse' || spot.id !== e.props.tool_use_id) return next(e)
    const shown = liveShown()
    if (!shown.text) return next(e)
    noteSite(`live-thinking site=ToolUse surface=${e.surface}`)
    const row = await next(e)
    const els = $.ui.resolve(e)
    const { Box } = els
    return (
      <Box flexDirection="column">
        {row}
        {liveBlock(els, e.surface, shown)}
      </Box>
    )
  })

  // The same for a call folded into a group's one line (reads, searches).
  on('ui.render', { component: 'ToolGroup', surface: ['desktop', 'vscode', 'mobile'] }, async ($, e, next) => {
    noteSite(`site=ToolGroup surface=${e.surface}`)
    if (e.props.isExpanded) return next(e)
    const ids = e.props.calls.flatMap(c => (c.tool_use_id === undefined ? [] : [c.tool_use_id]))
    for (const id of ids) noteTool(id, 'group')
    const spot = liveSpot()
    if (spot?.site !== 'ToolGroup' || !ids.includes(spot.id)) return next(e)
    const shown = liveShown()
    if (!shown.text) return next(e)
    noteSite(`live-thinking site=ToolGroup surface=${e.surface}`)
    const row = await next(e)
    const els = $.ui.resolve(e)
    const { Box } = els
    return (
      <Box flexDirection="column">
        {row}
        {liveBlock(els, e.surface, shown)}
      </Box>
    )
  })

  // The band above the prompt: off the terminal, the live thoughts while no row of the turn is
  // known to draw them under; when thinking arrives without text, a note (and, while the setting
  // is not on, a button that turns thinking summaries on).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteSite(`site=AbovePrompt surface=${e.surface}`)
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    if (e.surface !== 'terminal' && liveSpot() === undefined) {
      const shown = liveShown(Math.max(3, Math.min(LIVE_MAX_LINES, e.props.maxRows - 2)))
      if (shown.text) {
        noteSite(`live-thinking site=AbovePrompt surface=${e.surface}`)
        return liveBlock(els, e.surface, shown)
      }
    }
    if (summariesWritten) {
      return (
        <Box flexDirection="column">
          <Text dimColor>✻ {RESTART_HINT}</Text>
        </Box>
      )
    }
    if (!omitted) return next(e)
    const merged = await $.settings.read().catch((): Record<string, unknown> => ({}))
    if (merged.showThinkingSummaries === true) {
      return (
        <Box flexDirection="column">
          <Text dimColor>✻ thinking-ko · {SUMMARIES_ON_HINT}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>✻ thinking-ko · {OMITTED_HINT}</Text>
        <Button
          key="enable-summaries"
          label="생각 요약 켜기"
          onPress={() => {
            void turnOnSummaries('button').then(
              r => $.ui.toast(r.message),
              () => $.ui.toast('설정 파일을 못 고쳤어. settings.json에 "showThinkingSummaries": true를 직접 넣어 줘.'),
            )
          }}
        />
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
    const shown = thoughts.filter(t => !t.gone)
    if (shown.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{summariesWritten ? RESTART_HINT : omitted ? OMITTED_HINT : '아직 옮긴 생각이 없어.'}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {shown.map((t, i) => (
          <Box key={`t${i}`} flexDirection="column" marginBottom={1}>
            <Markdown text={markdownOf(t) || `_${STREAMING_THINKING}_`} />
          </Box>
        ))}
      </Box>
    )
  })
}
