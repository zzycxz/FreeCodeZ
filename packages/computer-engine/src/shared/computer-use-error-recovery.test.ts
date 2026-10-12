// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert。
// V1.19 P2：断言面随产码改写自 orca CLI 句迁移到本引擎 computer.* API 面
//（新增 A1 卫生用例：恢复指导零 orca/CLI-flag 残留）。原版权见 ../LICENSE。
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

  it('A1 卫生（V1.19 P2）：恢复指导零 orca/CLI-flag 残留', () => {
    for (const code of Object.values(COMPUTER_ERROR_CODES)) {
      const recovery = computerUseErrorRecoveryData(code)
      const text = recovery?.nextSteps.join('\n') ?? ''
      assert.ok(!text.includes('orca'), `${code} 恢复指导残留 orca 字样`)
      assert.ok(!text.includes('--'), `${code} 恢复指导残留 CLI flag 风格`)
    }
  })

  it('points screenshot failures at permission setup or includeScreenshot:false fallback', () => {
    const recovery = computerUseErrorRecoveryData('screenshot_failed')

    assertNextStepsContain(recovery?.nextSteps, [
      'includeScreenshot: false',
      'capabilities: ["screenshots"]',
      'payload cap'
    ])
  })

  it('points permission failures at targeted permission setup when possible', () => {
    const recovery = computerUseErrorRecoveryData('permission_denied')

    assertNextStepsContain(recovery?.nextSteps, [
      'capabilities: ["accessibility"]',
      'graphical desktop session'
    ])
  })

  it('points missing windows at listWindows before a single restore retry', () => {
    const recovery = computerUseErrorRecoveryData('window_not_found')

    assertNextStepsContain(recovery?.nextSteps, [
      'computer.listWindows({ app })',
      'restoreWindow: true',
      'cannot list what does not exist'
    ])
  })

  it('teaches shell launch for not-running apps (V1.17 例化经验)', () => {
    const recovery = computerUseErrorRecoveryData('app_not_found')

    assertNextStepsContain(recovery?.nextSteps, [
      'computer.listApps()',
      'open -a',
      'desktop browser app/window',
      'computer.listWindows({ app })'
    ])
    assert.ok(
      recovery?.nextSteps.join('\n').includes('no launch verb'),
      '应含「引擎无启动动词」教学'
    )
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
    const text = recovery?.nextSteps.join('\n') ?? ''

    assert.ok(text.includes('desktop browser app/window'))
    assert.ok(!text.includes('orca goto'))
  })
})
