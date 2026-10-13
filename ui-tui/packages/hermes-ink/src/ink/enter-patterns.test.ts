import { describe, expect, it } from 'vitest'

import { INITIAL_STATE, parseMultipleKeypresses } from './parse-keypress.js'

/**
 * Probe the various byte patterns a mobile Android terminal can deliver for
 * a single Enter, to expose gaps in the current CRLF fix.
 */
describe('mobile Enter arrival patterns (analysis probe)', () => {
  it('lone CR', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\r')
    expect(keys.map(k => k.name)).toEqual(['return'])
  })

  it('lone LF', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\n')
    expect(keys.map(k => k.name)).toEqual(['return'])
  })

  it('CRLF fused in one read', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\r\n')
    expect(keys.map(k => k.name)).toEqual(['return'])
  })

  it('LFCR fused in one read', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, '\n\r')
    expect(keys.map(k => k.name)).toEqual(['return'])
  })

  it('CR then LF in separate reads: two Enters (handled upstream, not here)', () => {
    // A split CRLF (CR in one frame, LF in the next) must NOT be fused at the
    // parse-keypress layer: the backend cannot know whether a lone CR is the
    // first half of a CRLF or a real Enter, and holding it would delay real
    // Enters until the next read (a composer-submit regression). The browser
    // web dashboard fuses the split CRLF BEFORE it reaches the PTY (see
    // createPtyEnterFuser in web/src/lib/pty-mobile-input.ts), so the PTY
    // never sees the halves separately. Backend-parse therefore emits two
    // 'return' keys for two lone line-ending reads.
    const [k1, s1] = parseMultipleKeypresses(INITIAL_STATE, '\r')
    const [k2] = parseMultipleKeypresses(s1, '\n')
    expect([...k1.map(k => k.name), ...k2.map(k => k.name)]).toEqual(['return', 'return'])
  })

  it('LF then CR in separate reads: two Enters (handled upstream, not here)', () => {
    const [k1, s1] = parseMultipleKeypresses(INITIAL_STATE, '\n')
    const [k2] = parseMultipleKeypresses(s1, '\r')
    expect([...k1.map(k => k.name), ...k2.map(k => k.name)]).toEqual(['return', 'return'])
  })

  it('CRLF embedded in text stays whole (paste)', () => {
    const [keys] = parseMultipleKeypresses(INITIAL_STATE, 'a\r\nb')
    expect(keys.map(k => k.name)).toEqual([''])
  })
})
