// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert，
// 用例名、夹具与断言语义与 orca 1.4.214 原件等价（expect.stringContaining 类
// 非对称匹配器改 includes 断言）；产码未动。原版权见 ../LICENSE。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computerUseErrorRecoveryData } from './computer-use-error-recovery'
import { COMPUTER_ERROR_CODES } from './runtime-types'

/** expect.stringContaining 的 node:test 等价：逐项 includes 断言。 */
function assertNextStepsContain(actual: string[] | undefined, parts: readonly string[]): void {
  assert.ok(Array.isArray(actual), `expected a nextSteps array, got ${JSON.stringify(actual)}`)
  assert.strictEqual(actual.length, parts.length, `nextSteps: ${JSON.stringify(actual)}`)
  for (const [index, part] of parts.entries()) {
    assert.ok(
      actual[index]?.includes(part),
      `nextSteps[${index}] should contain ${JSON.stringify(part)}, got ${JSON.stringify(actual[index])}`
    )
  }
}

describe('computerUseErrorRecoveryData', () => {
  it('covers every declared computer-use error code with actionable recovery steps', () => {
    for (const code of Object.values(COMPUTER_ERROR_CODES)) {
      const recovery = computerUseErrorRecoveryData(code)
      assert.ok(recovery, `missing recovery data for ${code}`)
      assert.ok(Array.isArray(recovery.nextSteps) && recovery.nextSteps.length > 0, code)
      assert.ok(
        recovery.nextSteps.every((step) => typeof step === 'string'),
        code
      )
    }
  })

  it('points screenshot failures at permission setup or no-screenshot fallback', () => {
    const recovery = computerUseErrorRecoveryData('screenshot_failed')

    assertNextStepsContain(recovery?.nextSteps, [
      '--no-screenshot',
      '--id screenshots',
      'payload cap'
    ])
  })

  it('points permission failures at targeted permission setup when possible', () => {
    const recovery = computerUseErrorRecoveryData('permission_denied')

    assertNextStepsContain(recovery?.nextSteps, ['--id accessibility', 'graphical desktop session'])
  })

  it('points missing windows at list-windows before a single restore retry', () => {
    const recovery = computerUseErrorRecoveryData('window_not_found')

    assertNextStepsContain(recovery?.nextSteps, [
      'list-windows',
      '--restore-window',
      'does not launch closed desktop apps'
    ])
  })

  it('requires state verification when a focus failure may follow a delivered press', () => {
    const recovery = computerUseErrorRecoveryData(
      'window_not_focused',
      'coordinate click aborted; 1 press(es) may already have been delivered'
    )

    assertNextStepsContain(recovery?.nextSteps, [
      'verify whether the intended action already occurred',
      'Do not retry the click if it already took effect'
    ])
    assert.ok(!recovery?.nextSteps.join('\n').includes('Retry once with `--restore-window`'))
  })

  it('keeps missing web app recovery within computer-use desktop app targeting', () => {
    const recovery = computerUseErrorRecoveryData('app_not_found')

    assertNextStepsContain(recovery?.nextSteps, [
      'list-apps',
      'desktop browser app/window',
      '--app <web app>',
      'list-windows --app <browser>'
    ])
    assert.ok(!recovery?.nextSteps.join('\n').includes('orca goto'))
  })
})
