# Computer Engine NOTICE

本目录是 FreeCodeZ 电脑控制引擎的源码拷贝，来源于 **orca 1.4.214 快照**
（上游 stablyai/orca，MIT License，Copyright (c) 2026 Lovecast Inc.——原文见同目录 `LICENSE`）。

- 快照标识：`1.4.214` + 下方全量 SHA256 清单（源仓库本地无 .git，不存在 commit 锚）。
- 拷贝范围：`src/main/computer/`（非测试模块）+ `src/shared/computer-use-*.ts` + shared 传递件
  + `src/shared/child-process/` 子树 + `src/shared/rpc-contract/` computer 三件 + `src/main/macos-tcc-reset.ts`
  + `native/computer-use-macos/`（Swift 整包：Sources + Tests + Package.swift）
  + `native/computer-use-{linux,windows}/`（runtime.py/runtime.ps1 + 伴随渲染测试，W-12）。
- A17 头审计：orca 原件无逐文件版权行（LICENSE 为仓库级声明）；逐字节一致件以哈希清单可验。

## 改写声明（A17：orca 派生件叠加修改）

身份与信任面改写（W-11）：产品身份改自有（FreeCodeZ Computer Use / freecodez-computer-use-macos /
app.freecodez.computer-use / Swift 模块名 FreeCodeZComputerUseMacOS*）；peer 信任双检改写——
路径子串检改自有 sidecar 产物（`/computer-sidecar.js`），bundle id 白名单改 `app.freecodez.*` 族
且**明令删除 com.github.Electron 信任项**（信任任意未签名 Electron 进程=安全红线）。
测试运行器自 vitest 迁写 node:test（用例/夹具/断言语义等价）。
W-12：runtime.py/runtime.ps1 及其渲染测试的 Orca/orca 标识改 FreeCodeZ/freecodez（往返比对零残差）；引擎 env 键 ORCA_COMPUTER_*/ORCA_* 四枚改 FREECODEZ_*。

- 同路径内容改写：9 件
- 移动+内容改写（模块改名波及）：17 件
- 仅路径重命名（字节一致）：10 件
- 拷入后移除（vitest harness，随 W-22 迁入）：1 件
- FreeCodeZ 自有新件（非 orca 原件）：10 件

### 同路径内容改写

- native/computer-use-macos/Package.swift
- src/main/computer/computer-action-verification-normalization.test.ts
- src/main/computer/computer-provider-lifecycle.test.ts
- src/main/computer/computer-provider-unavailable-message.test.ts
- src/main/computer/computer-sidecar-diagnostics.test.ts
- src/main/computer/macos-native-provider-paths.ts
- src/main/computer/windows-powershell-execution-policy.test.ts
- src/shared/computer-use-error-recovery.test.ts
- src/shared/computer-use-key-spec.test.ts

### 移动+内容改写

- native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOS/main.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AuthenticatedConnectionHangupMonitor.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/AuthenticatedConnectionHangupMonitor.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionStatusSnapshot.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/PermissionStatusSnapshot.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/ActionArgumentValidationTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/ActionArgumentValidationTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AgentEntrypointSourceSafetyTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/AgentEntrypointSourceSafetyTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AgentSessionOwnershipTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/AgentSessionOwnershipTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AttributeValueCoercionTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/AttributeValueCoercionTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AuthenticatedConnectionHangupMonitorTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/AuthenticatedConnectionHangupMonitorTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/ComputerSnapshotCachePolicyTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/ComputerSnapshotCachePolicyTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/KeyboardInputSafetyTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/KeyboardInputSafetyTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/NumericArgumentParsingTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/NumericArgumentParsingTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/PermissionStatusSnapshotTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/PermissionStatusSnapshotTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/PermissionTrustSettlingTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/PermissionTrustSettlingTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/ScreenCapturePermissionPreflightSafetyTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/ScreenCapturePermissionPreflightSafetyTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/SnapshotRenderingTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/SnapshotRenderingTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/SyntheticMouseClickDeliveryTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/SyntheticMouseClickDeliveryTests.swift
- native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/UnixSocketPathSafetyTests.swift  ->  native/computer-use-macos/Tests/FreeCodeZComputerUseMacOSTests/UnixSocketPathSafetyTests.swift

### 仅路径重命名（字节一致）

- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/ActionArgumentValidation.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/ActionArgumentValidation.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AgentSessionOwnership.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/AgentSessionOwnership.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AttributeValueCoercion.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/AttributeValueCoercion.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/ComputerSnapshotCachePolicy.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/ComputerSnapshotCachePolicy.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/KeyboardInputSafety.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/KeyboardInputSafety.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/NumericArgumentParsing.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/NumericArgumentParsing.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionTrustSettling.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/PermissionTrustSettling.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/SnapshotRendering.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/SnapshotRendering.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/SyntheticMouseClickDelivery.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/SyntheticMouseClickDelivery.swift
- native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/UnixSocketPathSafety.swift  ->  native/computer-use-macos/Sources/FreeCodeZComputerUseMacOSCore/UnixSocketPathSafety.swift

### 拷入后移除

- src/main/computer/desktop-script-provider-test-harness.ts

### 自有新件

- package.json
- scripts/build-computer-macos.mjs
- scripts/build-sidecar.mjs
- src/ambient.d.ts
- src/host/sidecar-harness.ts
- src/index.ts
- src/main/computer/index.ts
- src/shared/runtime-types.ts
- test/sidecar-smoke.test.ts
- tsconfig.json

## SHA256 清单（拷贝自 orca 1.4.214 快照的原件；改写/重命名前字节）

```
4202996a191fc48866df6cd118b532f1c250930b87876cbc543af3b347a27845  native/computer-use-macos/Package.swift
1eabe4e19f52bc6684c0b58e6cbc2c92ccf8b8d95d160205e3164432e9951601  native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift
66caabec17f4880b2088222a79684ccfc1d7ae5ee053595cc0e17264022602c2  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/ActionArgumentValidation.swift
e685cbc26ec9719a85ea199e00218ea373ab33129f8d2617771276b29d04ca47  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AgentSessionOwnership.swift
6e2f8da5367bf5e21bad695ec6392563547b5f6428a4986855a1660628b2ba2e  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AttributeValueCoercion.swift
1f1c221eaed16166816091abca6d03a05f471a42edc0699a5e254bb281ad963a  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AuthenticatedConnectionHangupMonitor.swift
5d9c0739a48d91f58fef12beed451d58cb29bab70595bb3f9cff0676a9e1501d  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/ComputerSnapshotCachePolicy.swift
3b0feef877b6f003503f17563771f42a8f35dc429677c31fe62b1626b6149a67  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/KeyboardInputSafety.swift
917958923b28c493fe290285a6bf68f6dcf814cf0be7d16bb27bcc562f6e4a5a  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/NumericArgumentParsing.swift
e734280c8900abf44a5607ad75cc8ab6170aa35bb1b634831328e60ee9ba7f89  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionStatusSnapshot.swift
a1dacad77c755d6ff40aa139adf105af8d44426a7639455dd5d15e6794535f66  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionTrustSettling.swift
dc73aeecff934ffec7fe1ec9e6e2b1aec714c80483320f8d4948633db53a35f8  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/SnapshotRendering.swift
7beb128e95a8e4ed0f18e188a7a97231d6fd70a9e130ca1a4c6adff5eda395eb  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/SyntheticMouseClickDelivery.swift
a91421666b734fe27c4b9ba042a6cee8e2a23a301550f041fb4888b0ba94ab53  native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/UnixSocketPathSafety.swift
d4240bcdfebe672453e0be6107a2a05abf9ccf8b7e6340e3aa6b76f2c1eb6fc1  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/ActionArgumentValidationTests.swift
9a80bb0e559f62ef20db9786ae59a774b69c95114548865a7a577c61f056750b  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AgentEntrypointSourceSafetyTests.swift
9bfce5243ea699ba737eb70a735b9dd3332697daab80e77face201c98a881b74  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AgentSessionOwnershipTests.swift
e2c2c7aa38725b3f0a4c6ec823db367307e8dd983cdd33ea3431b91391dc7223  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AttributeValueCoercionTests.swift
c3c180d937a321e4948928b34a3cd6c47d4e1bfa38a725a1c28aaf8af07e94cc  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/AuthenticatedConnectionHangupMonitorTests.swift
83bc853e9bd26e4674fdeca4a28641e0dedaed1cd6a649ddd03769ca626b8b50  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/ComputerSnapshotCachePolicyTests.swift
1c0283ecb60e37385fa3b705c41ea0f457dcd26344b9b3eeef364ceb7689a4bc  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/KeyboardInputSafetyTests.swift
4a9dbf457226a3df69c82086aa6405b6f5de0a53e820ddd72cbe123ba9e13e7d  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/NumericArgumentParsingTests.swift
dce1589ed328de886a092c45843888c5e8ab6fc0877dabd3dfe42c8364666c0c  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/PermissionStatusSnapshotTests.swift
c7f558241d379a93c62c7daf216ba9ee5b5d44fa7fadc7cd9dafedf5a004e907  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/PermissionTrustSettlingTests.swift
5f30e4af3f0ed2e760326309002260aa05fc7eec2dd3895bd993ee3718da861d  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/ScreenCapturePermissionPreflightSafetyTests.swift
d52d1110bf9251ce5e52d130ebdeaafedca5aa4a6352677e5a1d8bb85c004704  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/SnapshotRenderingTests.swift
f365817232adab5d93712232f53722ec2352535d96ac07e4794f4ce47158bd55  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/SyntheticMouseClickDeliveryTests.swift
1183272320d8406e55daf03ef8559d68619ea2e3a3aef3dbe92cae1680ee045c  native/computer-use-macos/Tests/OrcaComputerUseMacOSTests/UnixSocketPathSafetyTests.swift
a6d534d37151777d419505f724a0fb3ad6d6d6ccccd3ce036759d8a913af1d37  src/main/computer/computer-action-verification-normalization.test.ts
d774a429abd864b4c5296efcc17191cc31216638cb7169c19c79d9db88c1a159  src/main/computer/computer-action-verification-normalization.ts
2377529bc5c35f890796140b32b55a956397a5ede91e400e1564ba66c0544e22  src/main/computer/computer-clipboard-paste-validation.ts
706912e0f1460b73a049b6cadf2801ffbc16324a25eaa1c08ce5024f773bec61  src/main/computer/computer-provider-action-validation.ts
f4ed1fbf98916b4f7acdb430e110475af29eb8b7c684e09d9474fbb19cf1c748  src/main/computer/computer-provider-lifecycle.test.ts
92921f1d06764d0fe0d1f65067e856ba9812e55388f399879f21f8eaa39820ba  src/main/computer/computer-provider-lifecycle.ts
e074b2fb1dabb8a6ed54abc9ba728f216b79906263295385c6b66f816815f2ce  src/main/computer/computer-provider-unavailable-message.test.ts
31f1e9f4a1608ada65f9e0dfb2e75e93ce9bd1de6e2e1ea6088ac02920009051  src/main/computer/computer-provider-unavailable-message.ts
f11aae13723625d747fcf13e68b8714c4447eef65ab0ba099a856822efeb9659  src/main/computer/computer-sidecar-diagnostics.test.ts
8ee413b81351f0cca9b3afde7d5823f49eb473bdc387b4c3805e2e77359de831  src/main/computer/computer-sidecar-diagnostics.ts
39b12973b1abbfb21187cd7e46d73256e2553db056cadc1823be57b03898bc55  src/main/computer/computer-sidecar-paste-validation.ts
d364b6cf043d21236faebc2646cd798b88e46c7247ba8df9caf52092363ba48d  src/main/computer/desktop-script-action.ts
eb1bf9e658671538d79a7e747b5b60ffc31212fc26234737bbfe89e7de793c04  src/main/computer/desktop-script-provider-bridge.ts
f96ecf4f234cf768a566bfa289dd397528521534b7ea192025ea55f524c0e1bf  src/main/computer/desktop-script-provider-client.ts
bb364125519392ccb03c0089968e271c03d40e7832b7e5b1a33fd55cbe2e7aaa  src/main/computer/desktop-script-provider-params.ts
19eadb58b628564454482549758f1b8cdf5d9410e8e234299b9290fdd360a82e  src/main/computer/desktop-script-provider-paths.ts
a5b5aaca8e4b9918a3ff2f37f35a57fc879ddb79dfd2f223a6e4c70b050ccb12  src/main/computer/desktop-script-provider-test-harness.ts
4cbddb0f8173a2baa7506ba3094beb4dc1a8ab220c720cfad45f57260b60e2c8  src/main/computer/desktop-script-provider-types.ts
2111986042883960a0d3858c2f7e025850291b34c5e17d69a6039f73454547c3  src/main/computer/desktop-script-request-queue.ts
0361880b54409f401c90c908a17c83d0ac73192680a2623ca74f37c5ed44372a  src/main/computer/desktop-script-runtime-availability.ts
846c340c575814eedc241fdaa902451202abaf1874a5d566d78575a6fdacd006  src/main/computer/desktop-script-runtime-host.ts
9d1cc5f0058e7fe99ec5f2148ca744b5a49a24e46d7f7aeedee6bdb7fcc8d649  src/main/computer/desktop-script-serve-channel.ts
bc235f0aa3e45637e0fff8fbe0a9ff10dd496cac98b58f7f3302f6a32afdbf62  src/main/computer/desktop-script-snapshot-cache.ts
bf2420b9111b6e8af48d2d490b13fa51da235054c34a617d362a7131d4b3859b  src/main/computer/desktop-script-snapshot-rendering.ts
2160ff110985d796edbe04044e4dcc551e69025befc42b4181605ae365917981  src/main/computer/desktop-script-snapshot-store.ts
83ea94c983419796fdc0984d921beeeb1b52ea3b115058474e66759c747df43d  src/main/computer/macos-computer-use-permission-status.ts
69253d28661f924e82887be96bfb8e6b61907505d0fb1c36ecc5738bb24b5550  src/main/computer/macos-computer-use-permissions.ts
ff1ae2e0ef41ec4d9a0d15e8ea47a951a5b7d919d1cfcb274ffb18f1d031ca78  src/main/computer/macos-native-provider-availability.ts
9c8eeb4266802bd0fff154980028b218c18d124318e4635035e100b8eee76924  src/main/computer/macos-native-provider-client.ts
e5ff8ba1c2ecccd6a3c31720d0fd72dffd9cee4f488c9437c91617cf3941cb4c  src/main/computer/macos-native-provider-contract.ts
81578ad9ea66917a57d81d42b275a3f826e6d2c00641eb764f31d308575277a0  src/main/computer/macos-native-provider-paths.ts
1a63e8045c707fe73d69fb36e83fa708561e91bd1e0112e68460555829ef9de7  src/main/computer/macos-native-provider-process-reaping.ts
d36d60127e7359d7c53047256cda70324f852f6fd6641bb40500eaf9ae0cd714  src/main/computer/macos-native-provider-socket.ts
c26cae15e5f4a64c870ee315df63bb570f46ea38d5d62afb91c102e2b481eeb8  src/main/computer/macos-native-provider-transport.ts
f4d011837b8dd7190484dd8c1a8bf2838dfd8d2945448e712cf693db039146e1  src/main/computer/runtime-client-error.ts
117c32ed7e5924dcfb48cb8acf951d8f612443bcb523fcca93fa568979f5f097  src/main/computer/sidecar-client.ts
4d98b52a399885d91aa42e0c8b76b9b7b8f19ea9b099d24de9bc286a5f8608a5  src/main/computer/sidecar-entry.ts
7e5ab6b2058013b63a7929ba05c3fb4f2f00906cdcc6fee071741db0043b116d  src/main/computer/windows-powershell-execution-policy.test.ts
fdff6a30b7ff7e73f9a4337fb1820cc0a5e6b4655cf209f5b6c63d23791b64f0  src/main/computer/windows-powershell-execution-policy.ts
f95a98e841599ea7056ac7bc6f25b015d2e6abcd8f857a69c4c97071720c77e3  src/main/macos-tcc-reset.ts
91bd2a883048a56f8c3966057a062bac75f48f9e1b5670d8d7958f8c7fe21140  src/shared/app-environment.ts
d08e942c7feca7a5833b6e95fbad078306c5e8cee9fcc3c63dc3c4447be472bc  src/shared/child-process/bounded-output-sink.ts
d91ff09b26c9a23e26c2a2f92b129879cd6d0bddea14cd3bcac5d4489fecfca0  src/shared/child-process/child-termination-reporter.ts
d3e9ae81766d52a9ded14c0ac764be847387d0bcfffaf6f24b3b1cbd887ec4d3  src/shared/child-process/process-spec.ts
62848f063785e15cb0231deb622b043e81484ed3040c612afdc4f98fa2db06ab  src/shared/child-process/process-tree-kill-gate.ts
e8876f3c33cc32349313b39725263f9714afaba02be974a78c735dff5315acc6  src/shared/child-process/process-tree-termination.ts
f4d9683c0a0d2ea3ceb9c99b5b713b502496a2f3f982e2c63728063d5f1b239d  src/shared/child-process/run-process.ts
bc079eea792bbb05faeb21f15e150c6b477ebcd7aa6524e821c15b39e9494e68  src/shared/child-process/spawn-observer.ts
e1e06c941550fe6dd73580c14715c4cf31bcdb3e8e518fed5bdfdc3b11e9f852  src/shared/child-process/spawn-resolution.ts
5044e3a9140a19c8bb713044de655b611244659a754f32e5a5df7f519df40eb3  src/shared/child-process/windows-cmd-shim-resolution.ts
dd51e7944c17e6871f62c23b2d25d05318a2a379d661e5c758b515304f84dc3e  src/shared/child-process/windows-command-line.ts
0c42c7c454534a0937f4153e9708aeb243bd930d130ffc6493ac42d21405606e  src/shared/child-process/windows-system-binary.ts
50f3155063244d6d12ac1493c80029a75df256c031f986f76da64a94152d0c38  src/shared/clipboard-text.ts
3e8a81b8b1b13cec06c7f60fafe67a63727346bc2f718a6ba46e7a8589412df4  src/shared/computer-use-error-recovery.test.ts
7ccf7009369bef52694a114029906f7d9ee3991b79eb9a50b9e1cb957bf311ba  src/shared/computer-use-error-recovery.ts
37fa85fceb97056c0a1657e0ee5adb24277194b931dcecf0f47e571ed8352ffc  src/shared/computer-use-key-spec.test.ts
ead25f5342242bb514b3dc76b459885007d4269ce0f9b058060c2cc0f3d9f23c  src/shared/computer-use-key-spec.ts
da887148b3d66e5fd1e6224e6a8da798c6180152fbca4b7db4422582308152dd  src/shared/computer-use-permissions-types.ts
c4c793cae14a1a6d50f5ae587a7daa2de8d6c54a22cfb4aa54a9a4c7b12a7f9d  src/shared/computer-use-runtime-types.ts
d291b71f09eb88f24a849d0ae310f946deb7f93b0b6b490b6ea5a605ab7a53cf  src/shared/event-loop-yield.ts
e248392407dc622e8a324ea76ac051745a2936b0dc77b11f9ddf2553217a5848  src/shared/growing-byte-buffer.ts
addea88bc11c725192be2ff617b91315a875113844c95de03e5529cf3d7ef2e2  src/shared/own-retained-string.ts
1ca0bb35dfff2d9f3c02caee3d05b0e0c97378df71c878622acf703524d2c475  src/shared/owned-utf16-suffix.ts
86de970b4157487bed2cb5241ddca353b3b30b4fa35983d92a309f344e1246c2  src/shared/rpc-contract/computer-params.ts
d7140b8ad18783788dbfb5ec930627dcfe3095067913af701f8a639265c302be  src/shared/rpc-contract/computer-schemas-params.ts
a17678182a193ff09e0a7d4a5047f0abb2b84d5cd4f843ba9541b4171028eb48  src/shared/rpc-contract/rpc-param-primitives.ts
01574b287b2d6ab0758112887e356c0d270b25db1b72651925ba8329eb4224e6  src/shared/utf8-byte-limits.ts
```
