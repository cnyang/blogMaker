"""jobs.py：只確認「呼叫 Node CLI 的方式」與「進來的文字」是否安全；發布規則本身由 Node 端的測試負責。"""

import json
import subprocess
from typing import Any

import pytest

from blogmaker_tui import jobs

FP = "a" * 64


class _P:
    def __init__(self, out: str = "", err: str = "", code: int = 0) -> None:
        self.stdout, self.stderr, self.returncode = out, err, code


class Run:
    """取代 subprocess.run：記錄每次呼叫的 (args, kwargs)，並回傳預先放好的 JSON。"""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.reply: Any = {}

    def __call__(self, args: list[str], **kwargs: Any) -> _P:
        self.calls.append((args, kwargs))
        return _P(json.dumps(self.reply))


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch) -> Run:
    fake = Run()
    monkeypatch.setattr(jobs.subprocess, "run", fake)
    return fake


def test_articles_runs_the_cli_without_a_shell_and_asks_for_remote_status(run: Run) -> None:
    run.reply = {"blogId": "123", "warnings": [], "articles": []}
    assert jobs.articles()["blogId"] == "123"
    args, kwargs = run.calls[0]
    assert isinstance(args, list) and kwargs.get("shell") is not True
    assert args[0] == jobs.NODE and args[-2:] == ["list", "--remote"]
    script = args.index("src/article-cli.mjs")
    assert args[script + 1 : script + 3] == ["--root", str(jobs.ROOT)]
    assert kwargs["cwd"] == jobs.ROOT and kwargs["check"] is False and kwargs["timeout"]
    jobs.articles(remote=False)
    assert "--remote" not in run.calls[1][0]


def test_text_from_articles_is_stripped_of_terminal_control_sequences(run: Run) -> None:
    evil = "標題\x1b[2J\x1b]0;owned\x07\x00\x9b" + chr(0x202E) + "結尾\t內文"
    run.reply = {
        "blogId": "1",
        "warnings": [evil],
        "articles": [
            {"id": "a", "title": evil, "labels": [evil], "body": "第一行\n第二行\x1b[31m", "record": None}
        ],
    }
    result = jobs.articles()
    article = result["articles"][0]
    assert article["title"] == "標題結尾  內文" and article["labels"] == ["標題結尾  內文"]
    assert result["warnings"] == ["標題結尾  內文"]
    assert article["body"] == "第一行\n第二行"  # 換行保留，其餘控制碼都拿掉
    assert article["id"] == "a" and article["record"] is None


def test_preview_only_accepts_an_html_file_inside_build(run: Run) -> None:
    run.reply = {"path": str(jobs.ROOT / "build" / "a.html")}
    assert jobs.preview("a", FP) == jobs.ROOT / "build" / "a.html"
    args = run.calls[0][0]
    assert args[args.index("preview") :] == ["preview", "--id", "a", "--fingerprint", FP]
    bad_paths = [
        "/etc/passwd",
        str(jobs.ROOT / "build" / "a.txt"),
        str(jobs.ROOT / "posts" / "a.html"),
        str(jobs.ROOT / "build" / ".." / "x.html"),
    ]
    for bad in bad_paths:
        run.reply = {"path": bad}
        with pytest.raises(ValueError, match="預覽路徑"):
            jobs.preview("a", FP)


def test_publish_passes_exactly_the_selected_version_and_status(run: Run) -> None:
    run.reply = {"postId": "77", "status": "DRAFT", "url": "https://x.test/77"}
    assert jobs.publish("tech-a_1", FP, "draft")["status"] == "DRAFT"
    args = run.calls[0][0]
    assert args[args.index("publish") :] == [
        "publish",
        "--id",
        "tech-a_1",
        "--fingerprint",
        FP,
        "--status",
        "draft",
    ]


@pytest.mark.parametrize(
    ("article_id", "fingerprint", "status"),
    [
        ("a b", FP, "draft"),
        ("../x", FP, "draft"),
        ("", FP, "draft"),
        ("a;rm -rf ~", FP, "draft"),
        ("a\n", FP, "draft"),
        ("a", "short", "draft"),
        ("a", FP.upper(), "draft"),
        ("a", FP, "scheduled"),
        ("a", FP, "DRAFT"),
        ("a", FP, "--status"),
    ],
)
def test_bad_arguments_never_reach_node(run: Run, article_id: str, fingerprint: str, status: str) -> None:
    with pytest.raises(ValueError, match="不合法"):
        jobs.publish(article_id, fingerprint, status)
    if status in {"draft", "published"}:  # preview 沒有 status，只驗證 id 與 fingerprint
        with pytest.raises(ValueError, match="不合法"):
            jobs.preview(article_id, fingerprint)
    assert run.calls == []


def test_cli_failure_timeout_and_missing_node_become_readable_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        jobs.subprocess, "run", lambda *_a, **_k: _P(err="錯誤：文章已變更或移除\n" + "x" * 2000, code=1)
    )
    with pytest.raises(RuntimeError) as failed:
        jobs.articles()
    assert len(str(failed.value)) <= 800  # 只留尾端，避免整頁錯誤灌進畫面

    def timeout(*_a: Any, **_k: Any) -> None:
        raise subprocess.TimeoutExpired("node", 1)

    monkeypatch.setattr(jobs.subprocess, "run", timeout)
    with pytest.raises(RuntimeError, match="逾時.*Blogger"):
        jobs.publish("a", FP, "draft")

    def missing(*_a: Any, **_k: Any) -> None:
        raise FileNotFoundError

    monkeypatch.setattr(jobs.subprocess, "run", missing)
    with pytest.raises(RuntimeError, match="Node 24"):
        jobs.articles()
    monkeypatch.setattr(jobs.subprocess, "run", lambda *_a, **_k: _P(out="not json"))
    with pytest.raises(RuntimeError, match="不是有效"):
        jobs.articles()
