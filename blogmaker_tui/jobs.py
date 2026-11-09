"""blogMaker TUI 的動作層：只負責呼叫 src/article-cli.mjs 並整理回傳的 JSON。

不碰 Blogger 憑證，也不重做任何發布規則（發布鎖、journal、不得取消公開都在 Node 端）。
引數一律以 list 傳給 subprocess、不經 shell，且送出前先驗證格式；回來的文字先清掉終端機控制碼。
"""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
NODE = os.getenv("BLOGMAKER_NODE", "node")  # 需要 Node 24+
LIST_TIMEOUT = 120
PUBLISH_TIMEOUT = 300

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
_FINGERPRINT = re.compile(r"[a-f0-9]{64}")
_STATUSES = {"draft", "published"}
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
# 雙向文字控制字元（U+202A–202E、U+2066–2069）用 chr() 組出來，原始碼本身不放字面字元（Trojan Source）。
_BIDI = "".join(chr(code) for code in [*range(0x202A, 0x202F), *range(0x2066, 0x206A)])
_CONTROL = re.compile(rf"[\x00-\x08\x0b-\x1f\x7f-\x9f{_BIDI}]")


def clean(value: Any) -> Any:
    """文章標題、內文來自檔案或影片流程，顯示前先拿掉跳脫序列與控制字元（保留換行，Tab 換成兩個空白）。"""
    if isinstance(value, str):
        return _CONTROL.sub("", _ANSI.sub("", value)).replace("\t", "  ")
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    return value


def _check(article_id: str, fingerprint: str, status: str = "draft") -> None:
    if not _ID.fullmatch(article_id):
        raise ValueError("文章 id 不合法")
    if not _FINGERPRINT.fullmatch(fingerprint):
        raise ValueError("文章 fingerprint 不合法")
    if status not in _STATUSES:
        raise ValueError("發布狀態不合法")


def _cli(*args: str, timeout: int) -> Any:
    command = [NODE, "--env-file-if-exists=.env", "src/article-cli.mjs", "--root", str(ROOT), *args]
    try:
        result = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("blogMaker 執行逾時；請先到 Blogger 核對文章狀態，再按 r 重新整理") from error
    except FileNotFoundError as error:
        raise RuntimeError("找不到 node；需要 Node 24+（可用 BLOGMAKER_NODE 指定路徑）") from error
    if result.returncode:
        raise RuntimeError(clean((result.stderr or "blogMaker 執行失敗")[-800:]).strip())
    try:
        return clean(json.loads(result.stdout))
    except json.JSONDecodeError as error:
        raise RuntimeError("blogMaker 回傳的內容不是有效 JSON") from error


def articles(remote: bool = True) -> dict[str, Any]:
    """盤點所有文章。remote=True 會逐篇向 Blogger 核對實際狀態（需要憑證，沒有時 Node 端會退回離線並警告）。"""
    return _cli("list", *(["--remote"] if remote else []), timeout=LIST_TIMEOUT)


def preview(article_id: str, fingerprint: str) -> Path:
    """產生離線 HTML 預覽，回傳 build/ 內的檔案路徑。"""
    _check(article_id, fingerprint)
    path = Path(
        _cli("preview", "--id", article_id, "--fingerprint", fingerprint, timeout=LIST_TIMEOUT)["path"]
    )
    resolved = path.resolve()
    if not resolved.is_relative_to((ROOT / "build").resolve()) or resolved.suffix != ".html":
        raise ValueError("blogMaker 預覽路徑不合法")
    return resolved


def publish(article_id: str, fingerprint: str, status: str) -> dict[str, Any]:
    """上傳或更新所選的那一個版本；檔案在畫面顯示之後被改過時，Node 端會拒絕。"""
    _check(article_id, fingerprint, status)
    return _cli(
        "publish",
        "--id",
        article_id,
        "--fingerprint",
        fingerprint,
        "--status",
        status,
        timeout=PUBLISH_TIMEOUT,
    )
