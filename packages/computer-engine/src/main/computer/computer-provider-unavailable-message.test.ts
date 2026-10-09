// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert，
// 用例名、夹具与断言语义与 orca 1.4.214 原件等价；产码未动。原版权见 ../LICENSE。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('gives macOS developers the helper build and restart step', () => {
    assert.ok(
      computerProviderUnavailableMessage('darwin').includes(
        'run pnpm build:computer-macos and restart Orca from this worktree'
      )
    )
    assert.ok(
      computerProviderUnavailableMessage('darwin').includes(
        'Orca Computer Use.app was not found or this macOS version is unsupported'
      )
    )
  })

  it('keeps unsupported platforms explicit', () => {
    assert.strictEqual(
      computerProviderUnavailableMessage('freebsd'),
      'computer-use has no native provider for freebsd'
    )
  })
})
