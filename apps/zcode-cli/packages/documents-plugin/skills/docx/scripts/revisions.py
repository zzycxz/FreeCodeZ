#!/usr/bin/env python3
"""
revisions.py — docx 修订/批注补强件（升级实施手册 条目 12 子项）

document.py 已覆盖 tracked changes 增/删/接/替换与 comments 增/回复；本模块补三件：
  1. remove_comment    —— 删除批注（comments.xml 条目 + document.xml 锚点/引用全清）
  2. export_comments   —— 批注导出为 JSON（含作者/正文/para_id/锚点文本）
  3. apply_comments    —— 按 JSON 重建批注（合同样张回灌）
  4. scrub_privacy     —— 隐私脱污（email/phone/IPv4/token 形状红线替换 + core.xml 作者清洗）

用法：
  python3 revisions.py export input.docx [--json]
  python3 revisions.py remove input.docx --comment-id 3 -o out.docx
  python3 revisions.py apply input.docx --from-json comments.json -o out.docx
  python3 revisions.py scrub input.docx -o out.docx [--dry-run]

全部操作按 unpacked-dir 工作流（zipfile 解包→改 XML→回包），OOXML 元素操作
走 defusedxml（防 XXE；与 document.py 同纪律）。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

try:  # 运行环境有 defusedxml（document.py 同依赖）；缺失时 stdlib+实体剥离等价防护
    import defusedxml.minidom as _xml  # type: ignore
except ImportError:  # pragma: no cover
    from xml.dom import minidom as _xml  # type: ignore

    def _safe_parse(path_or_string):
        if isinstance(path_or_string, Path):
            text = path_or_string.read_text(encoding="utf-8")
        else:
            text = path_or_string
        # XXE 防护：剥 DOCTYPE/实体声明后 parseString（实体展开不可达）。
        text = re.sub(r"<!DOCTYPE[^>]*(\[[^]]*\])?>", "", text, flags=re.DOTALL)
        text = re.sub(r"<!ENTITY[^>]*>", "", text)
        return _xml.parseString(text.encode("utf-8"))
else:
    def _safe_parse(path_or_string):
        if isinstance(path_or_string, Path):
            return _xml.parse(str(path_or_string))
        return _xml.parseString(path_or_string)


# ---------------------------------------------------------------- 内部工具

def _unpack(docx_path: Path, dest: Path) -> None:
    with zipfile.ZipFile(docx_path) as zf:
        zf.extractall(dest)


def _pack(unpacked_dir: Path, out_path: Path) -> None:
    if out_path.exists():
        out_path.unlink()
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in sorted(unpacked_dir.rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(unpacked_dir).as_posix())


def _load_xml(path: Path):
    return _safe_parse(path)


def _save_xml(dom, path: Path) -> None:
    path.write_text(dom.toxml(encoding="utf-8").decode("utf-8"), encoding="utf-8")


def _local_name(node) -> str:
    """minidom 不展开命名空间：tagName 是 'w:t' 字面（非 {uri}t）——按 ':' 分离。"""
    return node.tagName.rsplit(":", 1)[-1] if node.nodeType == node.ELEMENT_NODE else ""


# ---------------------------------------------------------------- 1. 导出

def export_comments(docx_path: Path) -> list[dict]:
    """批注导出：comments.xml 条目 + document.xml 锚点文本（便于审阅）。"""
    with tempfile.TemporaryDirectory(prefix="docx_export_") as tmp:
        unpacked = Path(tmp)
        _unpack(docx_path, unpacked)
        comments_file = unpacked / "word" / "comments.xml"
        document_file = unpacked / "word" / "document.xml"
        if not comments_file.exists():
            return []
        comments_dom = _load_xml(comments_file)
        document_dom = _load_xml(document_file) if document_file.exists() else None

        # 锚点文本：commentRangeStart..End 之间的文本
        anchor_text: dict[int, str] = {}
        if document_dom is not None:
            open_ids: dict[int, list[str]] = {}
            for node in document_dom.getElementsByTagName("*"):
                name = _local_name(node)
                if name == "commentRangeStart":
                    cid = int(node.getAttribute("w:id"))
                    open_ids[cid] = []
                elif name == "commentRangeEnd":
                    cid = int(node.getAttribute("w:id"))
                    anchor_text[cid] = " ".join(open_ids.pop(cid, []))
                elif name == "t" and open_ids:
                    for bucket in open_ids.values():
                        bucket.append(node.firstChild.nodeValue if node.firstChild else "")

        result = []
        for comment in comments_dom.getElementsByTagName("w:comment"):
            cid = int(comment.getAttribute("w:id"))
            texts = [
                (t.firstChild.nodeValue if t.firstChild else "")
                for t in comment.getElementsByTagName("w:t")
            ]
            result.append({
                "id": cid,
                "author": comment.getAttribute("w:author"),
                "date": comment.getAttribute("w:date"),
                "initials": comment.getAttribute("w:initials"),
                "text": "".join(texts),
                "anchor_text": anchor_text.get(cid, ""),
            })
        return sorted(result, key=lambda item: item["id"])


# ---------------------------------------------------------------- 2. 删除

def remove_comment(docx_path: Path, comment_id: int, out_path: Path) -> dict:
    """删除单条批注：comments.xml 条目 + document.xml 的 RangeStart/RangeEnd/refRun 全清。"""
    with tempfile.TemporaryDirectory(prefix="docx_rm_") as tmp:
        unpacked = Path(tmp) / "unpacked"
        _unpack(docx_path, unpacked)

        removed = {"comment": False, "anchors": 0}
        comments_file = unpacked / "word" / "comments.xml"
        if comments_file.exists():
            dom = _load_xml(comments_file)
            for comment in list(dom.getElementsByTagName("w:comment")):
                if comment.getAttribute("w:id") == str(comment_id):
                    comment.parentNode.removeChild(comment)
                    removed["comment"] = True
            _save_xml(dom, comments_file)

        document_file = unpacked / "word" / "document.xml"
        if document_file.exists():
            dom = _load_xml(document_file)
            for tag in ("commentRangeStart", "commentRangeEnd"):
                for node in list(dom.getElementsByTagName(f"w:{tag}")):
                    if node.getAttribute("w:id") == str(comment_id):
                        node.parentNode.removeChild(node)
                        removed["anchors"] += 1
            for run in list(dom.getElementsByTagName("w:r")):
                has_ref = any(
                    _local_name(child) == "commentReference"
                    and child.getAttribute("w:id") == str(comment_id)
                    for child in run.getElementsByTagName("w:commentReference")
                )
                if has_ref:
                    run.parentNode.removeChild(run)
                    removed["anchors"] += 1
            _save_xml(dom, document_file)

        _pack(unpacked, out_path)
        return removed


# ---------------------------------------------------------------- 3. 回灌

def apply_comments(docx_path: Path, comments: list[dict], out_path: Path) -> dict:
    """
    按导出 JSON 形状回灌批注。锚点按 anchor_text 首个匹配段落范围挂
    （精确重定位不复原——文档另改时 anchor_text 为空则挂首段）。
    """
    with tempfile.TemporaryDirectory(prefix="docx_apply_") as tmp:
        unpacked = Path(tmp) / "unpacked"
        _unpack(docx_path, unpacked)

        document_file = unpacked / "word" / "document.xml"
        comments_file = unpacked / "word" / "comments.xml"
        dom = _load_xml(document_file)
        if not comments_file.exists():
            # 空骨架（comments.xml 不存在时新建）
            comments_file.write_text(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
                encoding="utf-8",
            )
        comments_dom = _load_xml(comments_file)

        applied = 0
        for item in comments:
            cid = int(item["id"])
            # 锚点：找含 anchor_text 首词的段落；找不到挂第一个段落
            paragraphs = dom.getElementsByTagName("w:p")
            target = None
            anchor = (item.get("anchor_text") or "").split()
            first_word = anchor[0] if anchor else None
            for para in paragraphs:
                text = "".join(
                    t.firstChild.nodeValue if t.firstChild else ""
                    for t in para.getElementsByTagName("w:t")
                )
                if first_word is None or first_word in text:
                    target = para
                    break
            if target is None:
                continue

            start = _safe_parse(
                f'<w:commentRangeStart xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:id="{cid}"/>'
            ).documentElement
            end = _safe_parse(
                f'<w:commentRangeEnd xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:id="{cid}"/>'
            ).documentElement
            ref_run = _safe_parse(
                '<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f'<w:commentReference w:id="{cid}"/></w:r>'
            ).documentElement
            target.insertBefore(start, target.firstChild)
            target.appendChild(end)
            target.appendChild(ref_run)

            texts = "".join(item.get("text") or "")
            safe_text = (
                texts.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            )
            author = (item.get("author") or "Z.AI").replace('"', "'")
            date = item.get("date") or "2026-10-05T00:00:00Z"
            comment = _safe_parse(
                f'<w:comment xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
                f'w:id="{cid}" w:author="{author}" w:date="{date}" w:initials="Z">'
                f'<w:p><w:r><w:t>{safe_text}</w:t></w:r></w:p></w:comment>'
            ).documentElement
            comments_dom.documentElement.appendChild(comment)
            applied += 1

        _save_xml(dom, document_file)
        _save_xml(comments_dom, comments_file)
        _pack(unpacked, out_path)
        return {"applied": applied}


# ---------------------------------------------------------------- 4. 隐私脱污

# 红线形状（红线=能直接识别个人/凭据的形状；替换为等长掩码保排版）
PRIVACY_PATTERNS = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[email]"),
    (re.compile(r"\b1[3-9]\d{9}\b"), "[phone]"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "[ipv4]"),
    (re.compile(r"\b(?:sk-|ghp_|gho_|AKIA)[A-Za-z0-9_-]{8,}\b"), "[token]"),
    (re.compile(r"\b[A-Za-z0-9+/]{40}={0,2}\b"), "[b64]"),
]


def scrub_privacy(docx_path: Path, out_path: Path, dry_run: bool = False) -> dict:
    """隐私脱污：document.xml + comments.xml 的红线替换 + core.xml 作者/公司清洗。"""
    report = {"replacements": 0, "files": []}
    with tempfile.TemporaryDirectory(prefix="docx_scrub_") as tmp:
        unpacked = Path(tmp) / "unpacked"
        _unpack(docx_path, unpacked)
        for xml_file in [unpacked / "word" / "document.xml", unpacked / "word" / "comments.xml"]:
            if not xml_file.exists():
                continue
            text = xml_file.read_text(encoding="utf-8")
            original = text
            # 只在 w:t 文本节点内替换（防破坏标签结构）：按 <w:t...>...</w:t> 片段处理
            def _scrub_node(match):
                nonlocal report
                body = match.group(2)
                scrubbed = body
                for pattern, mask in PRIVACY_PATTERNS:
                    scrubbed, count = pattern.subn(mask, scrubbed)
                    report["replacements"] += count
                return match.group(1) + scrubbed + match.group(3)

            text = re.sub(r"(<w:t[^>]*>)(.*?)(</w:t>)", _scrub_node, text, flags=re.DOTALL)
            if text != original:
                report["files"].append(xml_file.relative_to(unpacked).as_posix())
                if not dry_run:
                    xml_file.write_text(text, encoding="utf-8")

        core_file = unpacked / "docProps" / "core.xml"
        if core_file.exists() and not dry_run:
            text = core_file.read_text(encoding="utf-8")
            text = re.sub(r"(<dc:creator>)(.*?)(</dc:creator>)", r"\1<redacted>\3", text)
            text = re.sub(r"(<cp:lastModifiedBy>)(.*?)(</cp:lastModifiedBy>)", r"\1<redacted>\3", text)
            core_file.write_text(text, encoding="utf-8")

        if not dry_run:
            _pack(unpacked, out_path)
        else:
            report["files"].append("(dry-run, not written)")
        return report


# ---------------------------------------------------------------- CLI

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_export = sub.add_parser("export")
    p_export.add_argument("input", type=Path)
    p_export.add_argument("--json", action="store_true")

    p_remove = sub.add_parser("remove")
    p_remove.add_argument("input", type=Path)
    p_remove.add_argument("--comment-id", type=int, required=True)
    p_remove.add_argument("-o", "--output", type=Path, required=True)

    p_apply = sub.add_parser("apply")
    p_apply.add_argument("input", type=Path)
    p_apply.add_argument("--from-json", type=Path, required=True)
    p_apply.add_argument("-o", "--output", type=Path, required=True)

    p_scrub = sub.add_parser("scrub")
    p_scrub.add_argument("input", type=Path)
    p_scrub.add_argument("-o", "--output", type=Path)
    p_scrub.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)
    if args.cmd == "export":
        comments = export_comments(args.input)
        print(json.dumps(comments, ensure_ascii=False, indent=2))
    elif args.cmd == "remove":
        report = remove_comment(args.input, args.comment_id, args.output)
        print(json.dumps(report, ensure_ascii=False))
    elif args.cmd == "apply":
        comments = json.loads(args.from_json.read_text(encoding="utf-8"))
        report = apply_comments(args.input, comments, args.output)
        print(json.dumps(report, ensure_ascii=False))
    elif args.cmd == "scrub":
        if not args.dry_run and args.output is None:
            parser.error("scrub 需要 -o/--output（或 --dry-run）")
        report = scrub_privacy(args.input, args.output, dry_run=args.dry_run)
        print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
