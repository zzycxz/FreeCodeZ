#!/usr/bin/env python3
"""合同样张全对验证（条目 12 子项①）：export→scrub→remove-all→apply-all 幂等闭环。
运行：python3 test_revisions_e2e.py（自建样张，零外部依赖）。"""
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
WORK = Path(tempfile.mkdtemp(prefix="docx_e2e_"))

def build_sample(path):
    import zipfile
    doc_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Contract party alice@example.com sign phone 13800138000</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>
<w:p><w:commentRangeStart w:id="2"/><w:r><w:t>server 10.0.0.5 token sk-abc123def456ghi789 is real</w:t></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>
<w:p><w:r><w:t>clean paragraph without pii</w:t></w:r></w:p>
</w:body></w:document>"""
    comments_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:comment w:id="1" w:author="ReviewerA" w:date="2026-10-01T10:00:00Z" w:initials="R"><w:p><w:r><w:t>Check email of signer</w:t></w:r></w:p></w:comment>
<w:comment w:id="2" w:author="ReviewerB" w:date="2026-10-02T11:00:00Z" w:initials="B"><w:p><w:r><w:t>This token must not leak</w:t></w:r></w:p></w:comment>
</w:comments>"""
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""
    core_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>RealUserName</dc:creator><cp:lastModifiedBy>RealUserName</cp:lastModifiedBy>
</cp:coreProperties>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
    doc_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>"""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", doc_xml)
        zf.writestr("word/_rels/document.xml.rels", doc_rels)
        zf.writestr("word/comments.xml", comments_xml)
        zf.writestr("docProps/core.xml", core_xml)

# 合同样张全对验证（条目 12 子项①）：export→scrub→remove-all→apply-all 幂等闭环
import json, re, subprocess, sys, zipfile
from pathlib import Path



def run(*args):
    return subprocess.run([sys.executable, str(SCRIPTS_DIR / "revisions.py"), *args], capture_output=True, text=True, check=True)

build_sample(WORK / "sample.docx")
(WORK / "comments.json").write_text(run("export", str(WORK / "sample.docx"), "--json").stdout)
# 1. 导出基线
base = json.loads((WORK / "comments.json").read_text())
assert [c["id"] for c in base] == [1, 2], base
assert base[0]["anchor_text"].startswith("Contract party"), base[0]["anchor_text"]
print("PASS export: 2 条批注+锚点文本正确")

# 2. scrub 红线零残留
run("scrub", str(WORK / "sample.docx"), "-o", "/tmp/e2e-scrubbed.docx")
with zipfile.ZipFile("/tmp/e2e-scrubbed.docx") as zf:
    doc = zf.read("word/document.xml").decode()
    core = zf.read("docProps/core.xml").decode()
assert not re.search(r"alice@example|13800138000|sk-abc|10\.0\.0\.5", doc), "PII 残留"
assert set(re.findall(r"\[(email|phone|ipv4|token)\]", doc)) == {"email", "phone", "ipv4", "token"}
assert "<dc:creator><redacted></dc:creator>" in core
print("PASS scrub: 4 红线全掩码+作者清洗+正文零残留")

# 3. remove 全部 → 干净文档
for cid in (1, 2):
    src = "/tmp/e2e-scrubbed.docx" if cid == 1 else "/tmp/e2e-rm1.docx"
    dst = f"/tmp/e2e-rm{cid}.docx"
    report = json.loads(run("remove", src, "--comment-id", str(cid), "-o", dst).stdout)
    assert report["comment"] is True, report
remaining = json.loads(run("export", "/tmp/e2e-rm2.docx", "--json").stdout)
assert remaining == [], remaining
print("PASS remove-all: 2 条全清（批注+锚点）")

# 4. apply 全量回灌 → 与基线全对（id/author/text/anchor 首词）
applied = json.loads(run("apply", "/tmp/e2e-rm2.docx", "--from-json", str(WORK / "comments.json"), "-o", "/tmp/e2e-final.docx").stdout)
assert applied == {"applied": 2}, applied
final = json.loads(run("export", "/tmp/e2e-final.docx", "--json").stdout)
assert [c["id"] for c in final] == [1, 2], final
for original, back in zip(base, final):
    assert back["text"] == original["text"]
    assert back["author"] == original["author"]
    # apply 目标是 scrubbed 文档——锚点文本是掩码形态（语义正确）；比首词定位一致即可。
    assert back["anchor_text"].split()[0] == original["anchor_text"].split()[0], (back["anchor_text"], original["anchor_text"])
print("PASS apply-all: 合同样张全对（id/author/text/锚点首词一致）")
print("ALL-PASS")
