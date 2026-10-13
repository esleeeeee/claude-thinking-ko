// legacy/thinking-ko.test.mjs의 의도(큐 순서·동시성 제한·타임아웃·재시도·실패 시 원문·정리 규칙)를
// 옮긴 순수 로직 테스트. 엔진에는 setTimeout이 없으므로 가짜 타이머로 시간을 흘린다.
import { describe, expect, test } from 'claude-code/testing'

import {
  answerId,
  cleanAnswer,
  clip,
  displayText,
  maxTokensFor,
  MAX_OUTPUT_TOKENS,
  MAX_PENDING_BLOCKS,
  OrderedTranslator,
  PENDING_ANSWER,
  PENDING_ANSWER_RETRY,
  redact,
  shortHash,
  Slots,
  StreamTracker,
  TIMEOUT_MS,
  timeoutFor,
  TranslationManager,
  trimBlankLines,
  withDeadline,
  withSlot,
} from '../hooks/core'
import type { Timers, TranslatedItem } from '../hooks/core'

// ---- 도구 ----------------------------------------------------------------------

/** 마이크로태스크를 여러 번 돌려 이어진 then 사슬이 끝나게 한다. */
async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** 밖에서 끝내는 프로미스. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 가짜 시계: after로 예약하고 advance(ms)로 시간을 흘린다. */
function fakeTimers(): Timers & { now: () => number; advance: (ms: number) => Promise<void>; size: () => number } {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    after: (ms, fn) => {
      const id = ++seq
      timers.set(id, { at: t + ms, fn })
      return () => {
        timers.delete(id)
      }
    },
    size: () => timers.size,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        timers.delete(next[0])
        t = next[1].at
        next[1].fn()
        await flush()
      }
      t = end
      await flush()
    },
  }
}

/** abort되면 거부하는 요청 흉내. 밖에서 resolve로 끝낸다. */
function abortable(signal: AbortSignal, d: Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    d.then(resolve, reject)
  })
}

// ---- 순수 함수 -------------------------------------------------------------------

describe('순수 함수', () => {
  test('timeoutFor / clip / maxTokensFor', () => {
    expect(timeoutFor('a'.repeat(10))).toBe(TIMEOUT_MS)
    expect(timeoutFor('a'.repeat(1000))).toBe(TIMEOUT_MS)
    expect(timeoutFor('a'.repeat(2500)) > TIMEOUT_MS).toBe(true)
    expect(clip('가나다라', 2)).toBe('가나…')
    expect(clip('가나', 2)).toBe('가나')
    expect(maxTokensFor('short')).toBe(2048)
    expect(maxTokensFor('x'.repeat(6000))).toBe(6512)
    expect(maxTokensFor('x'.repeat(100000))).toBe(MAX_OUTPUT_TOKENS)
  })

  test('redact: 토큰류를 가리고 평범한 상태 줄은 그대로 둔다', () => {
    const line = `err="Authorization: Bearer abc.def-123 ya29.a0AfB_x-y sk-live_12345 AIzaSyD-xyz ${'q'.repeat(40)} ok"`
    const out = redact(line)
    for (const bad of ['abc.def-123', 'ya29.', 'sk-live', 'AIzaSy', 'q'.repeat(40)]) expect(out.includes(bad)).toBe(false)
    expect(out).toMatch(/Bearer \[redacted\]/)
    expect(redact('backend=claude:haiku try=1 ms=20')).toBe('backend=claude:haiku try=1 ms=20')
  })

  test('trimBlankLines / cleanAnswer: 들여쓰기·코드는 지키고 머리말·원문 태그만 뗀다', () => {
    expect(trimBlankLines('\n\n    print(1)\n    print(2)\n\n')).toBe('    print(1)\n    print(2)')
    expect(cleanAnswer('    print(1)\n    print(2)')).toBe('    print(1)\n    print(2)')
    expect(cleanAnswer('\n  \n\tindented\n')).toBe('\tindented')
    expect(cleanAnswer('```bash\nls\n```\n\n끝났다.')).toBe('```bash\nls\n```\n\n끝났다.')
    expect(cleanAnswer('번역: 고쳤다.')).toBe('고쳤다.')
    expect(cleanAnswer('번역:\n아 고쳣어')).toBe('아 고쳣어')
    expect(cleanAnswer('Translation:\r\n\n아 고쳣어\n')).toBe('아 고쳣어')
    expect(cleanAnswer('번역:')).toBe('')
    expect(cleanAnswer('<원문>\n다 됏어\n</원문>')).toBe('다 됏어')
    // 코드처럼 보이는 머리말은 건드리지 않는다
    for (const same of ['    Translation: string;', 'Translation: string;', '번역: string;', '```ts\nTranslation: string;\n```', '번역:아 고쳣어']) {
      expect(cleanAnswer(same)).toBe(same)
    }
  })

  test('answerId: 메시지 id와 원문이 같으면 같고, 하나라도 다르면 다르다', () => {
    expect(answerId('m1', 'Same.')).toBe(answerId('m1', 'Same.'))
    expect(answerId('m1', 'Same.') === answerId('m2', 'Same.')).toBe(false)
    expect(answerId('m1', 'Same.') === answerId('m1', 'Same!')).toBe(false)
    expect(shortHash('x')).toMatch(/^[0-9a-f]{14}$/)
  })

  test('displayText: 완료면 번역, 대기면 원문+표시, 실패·없음이면 원문(undefined)', () => {
    expect(displayText('Fixed it.', { status: 'done', ko: '고쳣어.' })).toBe('고쳣어.')
    expect(displayText('Fixed it.  ', { status: 'pending' })).toBe(`Fixed it.\n\n${PENDING_ANSWER}`)
    expect(displayText('Fixed it.', { status: 'pending', retry: true })).toBe(`Fixed it.\n\n${PENDING_ANSWER_RETRY}`)
    expect(displayText('Fixed it.', { status: 'failed' })).toBe(undefined)
    expect(displayText('Fixed it.', undefined)).toBe(undefined)
  })
})

// ---- 동시 요청 제한·타임아웃 --------------------------------------------------------

describe('Slots / withDeadline / withSlot', () => {
  test('Slots: 상한·대기·abort 시 대기열 이탈·release 중복 무시', async () => {
    const slots = new Slots(2)
    const r1 = slots.tryAcquire()
    const r2 = slots.tryAcquire()
    expect(r1 !== undefined && r2 !== undefined).toBe(true)
    expect(slots.tryAcquire()).toBe(undefined)
    const c = new AbortController()
    const waiting = slots.acquire(c.signal)
    c.abort(new Error('stop'))
    await expect(waiting).rejects.toThrow('stop')
    expect(slots.waiting).toBe(0)
    const later = slots.acquire()
    r1!()
    r1!() // 두 번 불러도 한 번만 반영
    const r3 = await later
    expect(slots.used).toBe(2)
    r2!()
    r3()
    expect(slots.used).toBe(0)
  })

  test('withDeadline: 시간이 넘으면 signal을 끊고 거부, parent abort도 거부', async () => {
    const timers = fakeTimers()
    let aborted = false
    const p = withDeadline(40, undefined, timers, signal => {
      signal.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise<string>(() => {}) // 멈춘 요청 흉내
    })
    let error: unknown
    p.catch((e: unknown) => {
      error = e
    })
    await timers.advance(39)
    expect(error).toBe(undefined)
    await timers.advance(1)
    expect(String(error)).toMatch(/timeout 40ms/)
    expect(aborted).toBe(true)
    expect(timers.size()).toBe(0)

    expect(await withDeadline(100, undefined, timers, async () => 'ok')).toBe('ok')
    expect(timers.size()).toBe(0) // 끝나면 타이머를 지운다

    const parent = new AbortController()
    const q = withDeadline(1000, parent.signal, timers, () => new Promise<string>(() => {}))
    parent.abort(new Error('reset'))
    await expect(q).rejects.toThrow('reset')
  })

  test('withSlot: 시간이 넘어도 abort를 무시하는 요청은 끝날 때까지 슬롯을 쥔다', async () => {
    const timers = fakeTimers()
    const slots = new Slots(1)
    const stuck = deferred<string>()
    const first = withDeadline(100, undefined, timers, dl => withSlot(slots, dl, () => stuck.promise))
    first.catch(() => {})
    await flush()
    expect(slots.used).toBe(1)
    await timers.advance(100) // 타임아웃: 호출자는 바로 실패를 받는다
    await expect(first).rejects.toThrow('timeout 100ms')
    let secondStarted = false
    const second = withDeadline(10_000, undefined, timers, dl =>
      withSlot(slots, dl, async () => {
        secondStarted = true
        return 'ok'
      }),
    )
    await flush()
    expect(secondStarted).toBe(false) // 앞 요청이 아직 안 끝나서 새 요청이 시작되지 않는다
    stuck.resolve('late')
    expect(await second).toBe('ok')
    expect(slots.used).toBe(0)
  })
})

// ---- 순서 보장 큐 ---------------------------------------------------------------------

describe('OrderedTranslator', () => {
  test('늦게 끝난 앞 항목이 먼저 나온다', async () => {
    const out: string[] = []
    const gates = new Map<string, ReturnType<typeof deferred<string>>>()
    const q = new OrderedTranslator({
      concurrency: 3,
      translate: t => {
        const d = deferred<string>()
        gates.set(t, d)
        return d.promise
      },
      onResult: i => out.push(i.text),
    })
    q.push('1', 'A')
    q.push('2', 'B')
    q.push('3', 'C')
    gates.get('C')!.resolve('ko:C')
    gates.get('B')!.resolve('ko:B')
    await flush()
    expect(out).toEqual([])
    gates.get('A')!.resolve('ko:A')
    await flush()
    expect(out).toEqual(['ko:A', 'ko:B', 'ko:C'])
    expect(q.pending).toBe(0)
  })

  test('실패하면 원문(ok=false), 동기 throw도 원문, 뒤 항목은 계속', async () => {
    const out: Array<[string, boolean]> = []
    const q = new OrderedTranslator({
      translate: async t => {
        if (t === 'bad') throw new Error('boom')
        if (t === 'sync') return (() => {
          throw new Error('sync')
        })()
        return `ko:${t}`
      },
      onResult: i => out.push([i.text, i.ok]),
    })
    q.push('1', 'bad')
    q.push('2', 'sync')
    q.push('3', 'good')
    await flush()
    expect(out).toEqual([
      ['bad', false],
      ['sync', false],
      ['ko:good', true],
    ])
  })

  test('동시 실행 수 제한과 중복 id 무시', async () => {
    let running = 0
    let peak = 0
    const gates: Array<() => void> = []
    const q = new OrderedTranslator({
      concurrency: 2,
      translate: t =>
        new Promise<string>(resolve => {
          running++
          peak = Math.max(peak, running)
          gates.push(() => {
            running--
            resolve(t)
          })
        }),
      onResult: () => {},
    })
    for (let i = 0; i < 6; i++) q.push(String(i), `t${i}`)
    expect(q.push('0', 'again')).toBe(false)
    while (gates.length) {
      gates.shift()!()
      await flush()
    }
    expect(peak).toBe(2)
    expect(q.pending).toBe(0)
  })

  test('reset 뒤 이전 결과는 버리고 진행 중 요청은 abort한다', async () => {
    const out: string[] = []
    let aborts = 0
    const old = deferred<string>()
    const q = new OrderedTranslator({
      translate: (t, signal) => {
        signal.addEventListener('abort', () => aborts++)
        return t === 'old' ? old.promise : Promise.resolve(t)
      },
      onResult: i => out.push(i.text),
    })
    q.push('1', 'old')
    q.reset()
    expect(aborts).toBe(1)
    q.push('1', 'new')
    old.resolve('old')
    await flush()
    expect(out).toEqual(['new'])
  })

  test('대기 상한: 넘치면 가장 오래된 미처리 항목을 원문으로 확정하고 알린다', async () => {
    const dropped: string[] = []
    const out: Array<[string, boolean]> = []
    const q = new OrderedTranslator({
      concurrency: 1,
      maxPending: 2,
      translate: (src, signal) => abortable(signal, Promise.resolve(`ko:${src}`).then(async v => (await flush(5), v))),
      onDrop: i => dropped.push(i.source),
      onResult: (i: TranslatedItem) => out.push([i.text, i.ok]),
    })
    for (const s of ['a', 'b', 'c', 'd']) q.push(s, s)
    await flush(80)
    expect(dropped).toEqual(['a', 'b'])
    expect(out).toEqual([
      ['a', false],
      ['b', false],
      ['ko:c', true],
      ['ko:d', true],
    ])
    expect(MAX_PENDING_BLOCKS).toBe(8)
  })
})

// ---- 번역 관리자 -------------------------------------------------------------------------

function manager(
  request: (source: string, signal: AbortSignal) => Promise<string>,
  extra: Partial<ConstructorParameters<typeof TranslationManager>[0]> = {},
) {
  const timers = fakeTimers()
  const logs: string[] = []
  const changes: string[] = []
  const done: Array<[string, string]> = []
  const m = new TranslationManager({
    request,
    timers,
    now: timers.now,
    log: l => logs.push(l),
    onChange: id => changes.push(id),
    onDone: (id, _source, ko) => done.push([id, ko]),
    backend: 'test',
    ...extra,
  })
  return { m, timers, logs, changes, done }
}

describe('TranslationManager', () => {
  test('항목 3개를 넣어도 나가 있는 요청은 2개 이하, 결과는 각자 자리에', async () => {
    let inflight = 0
    let peak = 0
    const gates: Array<() => void> = []
    const { m, done } = manager(
      source =>
        new Promise<string>(resolve => {
          inflight++
          peak = Math.max(peak, inflight)
          gates.push(() => {
            inflight--
            resolve(`번역: ${source}`)
          })
        }),
    )
    m.enqueue('a', '가')
    m.enqueue('b', '나')
    m.enqueue('c', '다')
    expect(m.enqueue('a', '가')).toBe(false) // 같은 id는 한 번만
    await flush()
    expect(inflight).toBe(2)
    while (gates.length) {
      gates.shift()!()
      await flush()
    }
    expect(peak).toBe(2)
    expect(m.get('a')).toEqual({ status: 'done', ko: '가' }) // "번역:" 머리말은 cleanAnswer가 뗀다
    expect(done.map(d => d[0])).toEqual(['a', 'b', 'c'])
  })

  test('타임아웃 두 번이면 재시도 표시를 거쳐 실패(원문)로 끝나고 캐시하지 않는다', async () => {
    const { m, timers, logs, done } = manager((_s, signal) => abortable(signal, new Promise(() => {})), {
      timeoutFor: () => 40,
      retryDelayMs: 30,
    })
    m.enqueue('x', 'I found the bug.')
    expect(m.get('x')).toEqual({ status: 'pending' })
    await timers.advance(40)
    expect(m.get('x')).toEqual({ status: 'pending', retry: true })
    await timers.advance(30) // 재시도 시작
    await timers.advance(40) // 두 번째 타임아웃
    expect(m.get('x')).toEqual({ status: 'failed' })
    expect(done).toEqual([])
    expect(logs.filter(l => /^fail backend=test try=[12] .*timeout 40ms/.test(l)).length).toBe(2)
    expect(logs.some(l => l.startsWith('retry scheduled'))).toBe(true)
    expect(logs.some(l => l.startsWith('retry start why=timer'))).toBe(true)
  })

  test('실패한 항목은 다른 번역이 성공한 직후 바로 재시도해서 번역된다', async () => {
    let flaky = 0
    const { m, timers, logs } = manager(
      async source => {
        if (source === 'flaky' && flaky++ === 0) throw new Error('overloaded')
        return `ko ${source}`
      },
      { retryDelayMs: 60_000 },
    )
    m.enqueue('f', 'flaky')
    await flush()
    expect(m.get('f')).toEqual({ status: 'pending', retry: true })
    m.enqueue('s', 'steady')
    await flush()
    expect(m.get('f')).toEqual({ status: 'done', ko: 'ko flaky' })
    expect(logs.some(l => l.startsWith('retry start why=after-success'))).toBe(true)
    expect(logs.some(l => l.startsWith('ok backend=test try=2'))).toBe(true)
    expect(timers.size()).toBe(0) // 60초 타이머는 취소됐다
  })

  test('빈 번역은 실패로 본다', async () => {
    const { m } = manager(async () => '   \n', { retryDelayMs: 1 })
    m.enqueue('e', 'Hello')
    await flush()
    expect(m.get('e')).toEqual({ status: 'pending', retry: true })
  })

  test('대기 상한으로 버린 항목은 재시도하지 않고 원문으로 둔다', async () => {
    const gates: Array<() => void> = []
    const { m, logs } = manager(source => new Promise<string>(resolve => gates.push(() => resolve(source))), {
      concurrency: 1,
      maxPending: 1,
    })
    m.enqueue('a', 'A')
    m.enqueue('b', 'B') // a를 밀어낸다
    await flush()
    expect(m.get('a')).toEqual({ status: 'failed' })
    expect(logs.some(l => l.startsWith('drop reason=queue-overflow'))).toBe(true)
    while (gates.length) {
      gates.shift()!()
      await flush()
    }
    expect(m.get('b')).toEqual({ status: 'done', ko: 'B' })
  })

  test('restore·skip·reset: 캐시는 그대로, 진행 중은 버린다', async () => {
    const { m } = manager(() => new Promise<string>(() => {}))
    m.restore('r', '복원')
    m.skip('s')
    m.skip('r') // 이미 있는 항목은 건드리지 않는다
    m.enqueue('p', 'P')
    m.reset()
    expect(m.get('r')).toEqual({ status: 'done', ko: '복원' })
    expect(m.get('s')).toEqual({ status: 'failed' })
    expect(m.get('p')).toBe(undefined)
  })
})

// ---- 생성 중 판정 -----------------------------------------------------------------------

describe('StreamTracker', () => {
  test('열린 text 블록은 생성 중, 다음 블록이 오거나 스트림이 끝나면 끝', () => {
    const t = new StreamTracker()
    expect(t.isGenerating('Hello there')).toBe(false)
    const s = t.begin()
    expect(t.text(s, 0, 'Hello')).toBe(false)
    expect(t.text(s, 0, ' there')).toBe(false)
    expect(t.isGenerating('Hello')).toBe(true) // 그려지는 중간 글
    expect(t.isGenerating('Hello there')).toBe(true)
    expect(t.isGenerating('Something else')).toBe(false)
    expect(t.other(s, 1)).toBe(true) // 도구 호출 블록 시작: 앞 text 블록은 끝
    expect(t.isGenerating('Hello there')).toBe(false)
    expect(t.text(s, 2, 'Next')).toBe(false)
    expect(t.text(s, 3, 'After')).toBe(true)
    expect(t.isGenerating('Next')).toBe(false)
    t.end(s)
    expect(t.active).toBe(0)
    expect(t.isGenerating('After')).toBe(false)
  })
})
