// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert，
// 用例名、夹具与断言语义与 orca 1.4.214 原件等价（expect.stringContaining 类
// 非对称匹配器改 includes 断言）；产码未动。原版权见 ../LICENSE。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  computerUseClickModifiersValidationMessage,
  computerUseHotkeyValidationMessage,
  computerUsePressKeyValidationMessage
} from './computer-use-key-spec'

/** expect.stringContaining 的 node:test 等价：返回值须为字符串且包含片段。 */
function assertValidationMessageContains(
  actual: string | null | undefined,
  part: string
): void {
  assert.strictEqual(typeof actual, 'string', `expected a validation message, got ${actual}`)
  assert.ok((actual as string).includes(part), `message should contain ${part}: ${actual}`)
}

describe('computer-use key specs', () => {
  it('accepts hotkeys with modifiers and one key', () => {
    assert.strictEqual(computerUseHotkeyValidationMessage('CmdOrCtrl+A'), null)
    assert.strictEqual(computerUseHotkeyValidationMessage('ctrl+shift+p'), null)
    assert.strictEqual(computerUseHotkeyValidationMessage('CommandOrControl + Option + Space'), null)
  })

  it('rejects single keys, modifier-only chords, empty parts, and multiple base keys', () => {
    const expected = 'Hotkey requires a modifier and one key'

    assertValidationMessageContains(computerUseHotkeyValidationMessage('Return'), expected)
    assertValidationMessageContains(computerUseHotkeyValidationMessage('CmdOrCtrl+Shift'), expected)
    assertValidationMessageContains(computerUseHotkeyValidationMessage('Ctrl++A'), expected)
    assertValidationMessageContains(computerUseHotkeyValidationMessage('Ctrl+A+B'), expected)
  })

  it('accepts single press keys including literal plus', () => {
    assert.strictEqual(computerUsePressKeyValidationMessage('Return'), null)
    assert.strictEqual(computerUsePressKeyValidationMessage('PageUp'), null)
    assert.strictEqual(computerUsePressKeyValidationMessage('+'), null)
  })

  it('rejects modifier chords on the press-key path', () => {
    const expected = 'Press-key accepts one key only'

    assertValidationMessageContains(computerUsePressKeyValidationMessage('CmdOrCtrl+V'), expected)
    assertValidationMessageContains(computerUsePressKeyValidationMessage('Ctrl+Shift+P'), expected)
    assertValidationMessageContains(computerUsePressKeyValidationMessage(''), expected)
  })

  it('accepts modifier-only click chords', () => {
    assert.strictEqual(computerUseClickModifiersValidationMessage('CmdOrCtrl'), null)
    assert.strictEqual(computerUseClickModifiersValidationMessage('CmdOrCtrl+Shift'), null)
    assert.strictEqual(computerUseClickModifiersValidationMessage('Control + Alt'), null)
  })

  it('rejects empty, key-bearing, and malformed click modifier chords', () => {
    const expected = 'Click modifiers accept modifier keys only'

    assertValidationMessageContains(computerUseClickModifiersValidationMessage(''), expected)
    assertValidationMessageContains(computerUseClickModifiersValidationMessage('CmdOrCtrl+A'), expected)
    assertValidationMessageContains(computerUseClickModifiersValidationMessage('Cmd-Or-Ctrl'), expected)
    assertValidationMessageContains(computerUseClickModifiersValidationMessage('Ctrl++Shift'), expected)
    assertValidationMessageContains(
      computerUseClickModifiersValidationMessage('Ctrl+Shift+Alt+Meta+Super'),
      expected
    )
  })
})
