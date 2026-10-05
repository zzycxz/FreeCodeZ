#!/usr/bin/env python3
"""条目 12 子项②：soffice 隔离 profile 测试——宏绝不写真实 profile。"""
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import xlsx

def main() -> int:
    real_macro_mac = Path.home() / "Library/Application Support/LibreOffice/4/user/basic/Standard/Module1.xba"
    real_macro_linux = Path.home() / ".config/libreoffice/4/user/basic/Standard/Module1.xba"
    before_mac = real_macro_mac.exists()
    before_linux = real_macro_linux.exists()

    # 隔离 profile 建宏（soffice 不在环境时仅验写入位置——宏写只落隔离区）
    root = xlsx._isolated_profile_root()
    assert root.startswith("/tmp") or "/T/" in root or "temp" in root.lower(), root
    ok = xlsx._setup_libreoffice_macro(root)
    assert ok, "isolated macro setup failed"
    isolated_macro = Path(root) / "user" / "basic" / "Standard" / "Module1.xba"
    assert isolated_macro.exists(), isolated_macro
    content = isolated_macro.read_text()
    assert "RecalculateAndSave" in content

    # 真实 profile 零触碰
    assert real_macro_mac.exists() == before_mac, "macOS 真实 profile 被触碰!"
    assert real_macro_linux.exists() == before_linux, "Linux 真实 profile 被触碰!"
    print("PASS isolated macro in", root)
    print("PASS real profile untouched (mac/linux)")

    # UserInstallation 隔离 flag 在 lo_cmd 构造路径上（源级锚）
    src = Path(xlsx.__file__).read_text()
    assert "-env:UserInstallation=file://" in src, "lo_cmd 缺隔离 env flag"
    assert src.count("-env:UserInstallation=file://") >= 2, "初始化与 lo_cmd 两处都要带"
    print("PASS UserInstallation flag on both soffice calls")
    print("ALL-PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
