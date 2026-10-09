// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert，
// 用例名、夹具与断言语义与 orca 1.4.214 原件等价；产码未动。原版权见 ../LICENSE。
import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import {
  isComputerSidecarDiagnostic,
  reportComputerDiagnostic
} from './computer-sidecar-diagnostics'

describe('computer sidecar diagnostics', () => {
  const originalSend = process.send
  let warnSpy: ReturnType<typeof mock.method> | undefined

  afterEach(() => {
    process.send = originalSend
    warnSpy?.mock.restore()
    warnSpy = undefined
  })

  it('sends over IPC when running inside the sidecar', () => {
    const send = mock.fn((_message: unknown) => true)
    process.send = send as unknown as typeof process.send
    warnSpy = mock.method(console, 'warn', () => {})

    reportComputerDiagnostic('fell back to Bypass')

    // The sidecar's stdout is piped and never read, so this must not go there.
    assert.strictEqual(warnSpy.mock.callCount(), 0)
    assert.strictEqual(send.mock.callCount(), 1)
    assert.deepStrictEqual(send.mock.calls[0]?.arguments[0], {
      kind: 'computer-sidecar-diagnostic',
      message: 'fell back to Bypass'
    })
    assert.strictEqual(
      isComputerSidecarDiagnostic(send.mock.calls[0]?.arguments[0]),
      true
    )
  })

  it('logs directly when there is no IPC channel', () => {
    process.send = undefined
    warnSpy = mock.method(console, 'warn', () => {})

    reportComputerDiagnostic('fell back to Bypass')

    assert.strictEqual(warnSpy.mock.callCount(), 1)
    assert.strictEqual(warnSpy.mock.calls[0]?.arguments[0], '[computer-use] fell back to Bypass')
  })

  it('does not mistake a sidecar response for a diagnostic', () => {
    assert.strictEqual(isComputerSidecarDiagnostic({ id: 1, ok: true, result: {} }), false)
    assert.strictEqual(isComputerSidecarDiagnostic({ kind: 'computer-sidecar-diagnostic' }), false)
    assert.strictEqual(isComputerSidecarDiagnostic(null), false)
  })
})
