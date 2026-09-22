# -*- coding: utf-8 -*-
# 删除「升级」入口孤儿 i18n 键（双语同步）。正则吞掉 "key":\n "value" 多行续行形态，
# 避免按 key 删行留下孤儿续行炸语法（provider-intake 批次教训）。
import io
import re

KEYS = [
    "settings.modelProvider.codingPlan.purchaseBanner.teamStandardDescription",
    "settings.modelProvider.codingPlan.purchaseBanner.teamAdvancedDescription",
]

FILES = [
    "packages/ui/src/i18n/locales/zh-CN.ts",
    "packages/ui/src/i18n/locales/en-US.ts",
]

for path in FILES:
    with io.open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    for key in KEYS:
        pattern = re.compile(
            r'\n  "' + re.escape(key) + r'":\s*"(?:[^"\\]|\\.)*"[ \t]*,'
        )
        text, n = pattern.subn("", text)
        print(("OK  " if n == 1 else "WARN") , path, key, "removed=%d" % n)
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
print("DONE")
