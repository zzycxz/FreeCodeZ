// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert，
// 用例名、夹具与断言语义与 orca 1.4.214 原件等价；产码未动。原版权见 ../LICENSE。
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { ComputerProviderLifecycle } from './computer-provider-lifecycle'

function provider(name: string) {
  return {
    name,
    capabilities: mock.fn(),
    listApps: mock.fn(),
    listWindows: mock.fn(),
    snapshot: mock.fn(),
    action: mock.fn(),
    shutdown: mock.fn()
  }
}

describe('ComputerProviderLifecycle', () => {
  it('rechecks macOS provider availability after an initial miss', () => {
    const macProvider = provider('mac')
    let first = true
    const shouldUseMacOSNativeProvider = mock.fn(() => {
      if (first) {
        first = false
        return false
      }
      return true
    })
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider,
      createMacOSNativeProvider: mock.fn(() => macProvider as never),
      shouldUseDesktopScriptProvider: mock.fn(() => false),
      createDesktopScriptProvider: mock.fn()
    })

    assert.strictEqual(lifecycle.current('darwin'), null)
    assert.strictEqual(lifecycle.current('darwin'), macProvider)
    assert.strictEqual(shouldUseMacOSNativeProvider.mock.callCount(), 2)
  })

  it('caches an available provider and shuts it down', () => {
    const macProvider = provider('mac')
    const createMacOSNativeProvider = mock.fn(() => macProvider as never)
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider: mock.fn(() => true),
      createMacOSNativeProvider,
      shouldUseDesktopScriptProvider: mock.fn(() => false),
      createDesktopScriptProvider: mock.fn()
    })

    assert.strictEqual(lifecycle.current('darwin'), macProvider)
    assert.strictEqual(lifecycle.current('darwin'), macProvider)
    assert.strictEqual(createMacOSNativeProvider.mock.callCount(), 1)

    lifecycle.shutdown()

    assert.strictEqual(macProvider.shutdown.mock.callCount(), 1)
  })

  it('uses the desktop script provider on Linux when available', () => {
    const desktopProvider = provider('desktop')
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider: mock.fn(() => false),
      createMacOSNativeProvider: mock.fn(),
      shouldUseDesktopScriptProvider: mock.fn(() => true),
      createDesktopScriptProvider: mock.fn(() => desktopProvider as never)
    })

    assert.strictEqual(lifecycle.current('linux'), desktopProvider)
  })

  it('shuts down the desktop script provider', () => {
    const desktopProvider = provider('desktop')
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider: mock.fn(() => false),
      createMacOSNativeProvider: mock.fn(),
      shouldUseDesktopScriptProvider: mock.fn(() => true),
      createDesktopScriptProvider: mock.fn(() => desktopProvider as never)
    })

    assert.strictEqual(lifecycle.current('linux'), desktopProvider)

    lifecycle.shutdown()

    assert.strictEqual(desktopProvider.shutdown.mock.callCount(), 1)
  })
})
