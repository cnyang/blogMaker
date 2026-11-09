"""TUI：用 Textual 無頭模式實際按鍵。jobs 的所有動作都換成記錄呼叫的假函式，不會執行 Node 也不會連 Blogger。"""

import asyncio
import hashlib
import threading
from collections.abc import Callable
from typing import Any

import pytest

from blogmaker_tui import jobs, tui


def fingerprint(article_id: str) -> str:
    return hashlib.sha256(article_id.encode()).hexdigest()


def art(
    article_id: str,
    title: str,
    *,
    category: str = "tech",
    record: dict | None = None,
    remote: dict | None = None,
    changed: bool = False,
    body: str = "內文",
) -> dict[str, Any]:
    return {
        "id": article_id, "title": title, "path": f"posts/{article_id}.md", "category": category,
        "date": "2026-11-09", "labels": ["技術"], "summary": "摘要", "body": body,
        "fingerprint": fingerprint(article_id), "record": record, "changed": changed, "remote": remote,
    }  # fmt: skip


def rec(status: str = "DRAFT") -> dict[str, str]:
    return {"postId": "77", "status": status, "url": "https://x.test/77"}


class Env:
    def __init__(
        self, monkeypatch: pytest.MonkeyPatch, articles: list[dict], *, blog_id: str = "123"
    ) -> None:
        self.articles, self.blog_id, self.warnings = articles, blog_id, []
        self.calls: list[tuple] = []
        self.list_calls = 0
        self.list_error: dict[int, Exception] = {}  # 第幾次盤點要失敗（從 1 起算）
        self.publish_error: dict[str, Exception] = {}
        monkeypatch.setattr(jobs, "articles", self._articles)
        monkeypatch.setattr(jobs, "publish", self._publish)
        monkeypatch.setattr(jobs, "preview", self._preview)
        monkeypatch.setattr(tui.webbrowser, "open", lambda url: self.calls.append(("open", url)) or True)

    def _articles(self, remote: bool = True) -> dict[str, Any]:
        self.list_calls += 1
        self.calls.append(("list", remote))
        if error := self.list_error.get(self.list_calls):
            raise error
        return {"blogId": self.blog_id, "warnings": self.warnings, "articles": self.articles}

    def _publish(self, article_id: str, fp: str, status: str) -> dict[str, Any]:
        self.calls.append(("publish", article_id, fp, status))
        if error := self.publish_error.get(article_id):
            raise error
        return {"postId": "77", "status": "LIVE" if status == "published" else "DRAFT", "url": ""}

    def _preview(self, article_id: str, fp: str) -> Any:
        self.calls.append(("preview", article_id, fp))
        return jobs.ROOT / "build" / f"{article_id}.html"

    def writes(self) -> list[tuple]:
        return [call for call in self.calls if call[0] == "publish"]


Step = str | Callable[[tui.BM], None]


def drive(env: Env, *steps: Step, size: tuple[int, int] = (160, 40)) -> tui.BM:
    """依序執行（按鍵字串或 callable），每一步後等背景工作結束。回傳 app 以便檢查。"""

    async def go() -> tui.BM:
        app = tui.BM()
        async with app.run_test(size=size) as pilot:
            await pilot.pause()
            await app.workers.wait_for_complete()
            for step in steps:
                if callable(step):
                    step(app)
                else:
                    await pilot.press(*step.split())
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.pause()
            return app

    return asyncio.run(go())


def cells(app: tui.BM) -> list[list[str]]:
    table = app.query_one(tui.DataTable)
    return [[str(cell) for cell in table.get_row_at(i)] for i in range(table.row_count)]


def capture(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, bool]]:
    messages: list[tuple[str, bool]] = []
    monkeypatch.setattr(tui.BM, "say", lambda _self, msg, error=False: messages.append((msg, error)))
    return messages


def test_table_shows_status_from_the_real_blogger_state_next_to_the_local_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(
        monkeypatch,
        [
            art("new", "新文章"),
            art("draft", "草稿文", record=rec("DRAFT"), remote={"status": "DRAFT"}),
            art("manual", "手動公開", record=rec("DRAFT"), remote={"status": "LIVE"}),
            art("gone", "遠端消失", record=rec("DRAFT"), remote={"error": "Blogger HTTP 404"}),
            art("offline", "沒核對", record=rec("LIVE")),
            art("edited", "改過", record=rec("DRAFT"), remote={"status": "DRAFT"}, changed=True),
        ],
    )
    seen: dict[str, Any] = {}
    drive(
        env,
        lambda app: seen.update(
            rows=cells(app), cols=[str(c.label) for c in app.query_one(tui.DataTable).columns.values()]
        ),
    )
    states = [row[1] for row in seen["rows"]]
    assert states == ["未上傳", "草稿", "已公開·紀錄過時", "遠端找不到", "已公開（本機紀錄）", "草稿·有修改"]
    assert seen["cols"] == ["選", "狀態", "分類", "標題", "標籤", "日期", "檔案"]
    assert [row[0] for row in seen["rows"]] == ["⬜"] * 6  # 勾選欄固定顯示
    assert env.calls[0] == ("list", True)  # 開啟時就向 Blogger 核對遠端狀態


def test_titles_are_shown_literally_not_as_markup(monkeypatch: pytest.MonkeyPatch) -> None:
    env = Env(monkeypatch, [art("a", "[bold]粗體[/bold] [/oops] [link=x]連結", body="[red]內文[/red] [/")])
    seen: dict[str, Any] = {}
    drive(
        env,
        lambda a: seen.update(rows=cells(a)),
        "enter",
        lambda a: seen.update(is_detail=isinstance(a.screen, tui.Detail), text=str(a.screen.query_one(tui.Static).render())),
    )  # fmt: skip
    assert seen["rows"][0][3] == "[bold]粗體[/bold] [/oops] [link=x]連結"
    assert seen["is_detail"]  # 詳情視窗也沒有因為壞掉的標記而崩潰
    assert "[red]內文[/red] [/" in seen["text"]


def test_category_filter_cycles_and_selection_only_counts_existing_articles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(
        monkeypatch,
        [
            art("t", "技術", category="tech"),
            art("k", "兒童", category="kids"),
            art("h", "Husky", category="husky"),
        ],
    )
    seen: list[list[str]] = []
    drive(
        env,
        lambda a: seen.append([r[3] for r in cells(a)]),
        "c", lambda a: seen.append([r[3] for r in cells(a)]),
        "c", lambda a: seen.append([r[3] for r in cells(a)]),
        "c", lambda a: seen.append([r[3] for r in cells(a)]),
        "c c", lambda a: seen.append([r[3] for r in cells(a)]),
    )  # fmt: skip
    assert seen == [["技術", "兒童", "Husky"], ["技術"], ["兒童"], ["Husky"], ["技術", "兒童", "Husky"]]


def test_space_toggles_selection_moves_down_and_escape_clears(monkeypatch: pytest.MonkeyPatch) -> None:
    env = Env(monkeypatch, [art("a", "A"), art("b", "B"), art("c", "C")])
    seen: dict[str, Any] = {}
    drive(
        env,
        "space space",
        lambda a: seen.update(first=[r[0] for r in cells(a)], chosen=set(a.selected)),
        "escape",
        lambda a: seen.update(after=[r[0] for r in cells(a)], chosen_after=set(a.selected)),
    )  # fmt: skip
    assert seen["first"] == ["✅", "✅", "⬜"] and seen["chosen"] == {"a", "b"}
    assert seen["after"] == ["⬜"] * 3 and seen["chosen_after"] == set()


def test_draft_upload_asks_first_and_sends_exactly_the_version_on_screen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(monkeypatch, [art("a", "文章 A")])
    seen: dict[str, Any] = {}
    drive(env, "u", lambda a: seen.update(screen=type(a.screen).__name__), "n")
    assert seen["screen"] == "Confirm" and env.writes() == []  # 取消就不送出
    drive(env, "u y")
    assert env.writes() == [("publish", "a", fingerprint("a"), "draft")]
    assert env.list_calls >= 3  # 每次開啟盤點一次；上傳完成後再核對一次


def test_batch_draft_upload_skips_live_posts_and_keeps_failed_ones_selected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(
        monkeypatch,
        [art("a", "A"), art("b", "B", record=rec(), remote={"status": "DRAFT"}), art("c", "C", record=rec("LIVE"), remote={"status": "LIVE"})],
    )  # fmt: skip
    env.publish_error["b"] = RuntimeError("Blogger HTTP 503")
    seen: dict[str, Any] = {}
    drive(
        env,
        "space space space",
        "u y",
        lambda a: seen.update(selected=set(a.selected), is_detail=isinstance(a.screen, tui.Detail), text=str(a.screen.query_one(tui.Static).render())),
    )  # fmt: skip
    assert env.writes() == [
        ("publish", "a", fingerprint("a"), "draft"),
        ("publish", "b", fingerprint("b"), "draft"),
    ]  # 已公開的 C 不送
    assert seen["selected"] == {"b", "c"}  # 成功的 A 取消勾選；失敗的 B 保留方便重試；略過的 C 沒動
    assert seen["is_detail"]  # 失敗原因留在視窗，不會 10 秒後消失
    assert "Blogger HTTP 503" in seen["text"]


def test_draft_upload_refuses_when_everything_chosen_is_already_live(monkeypatch: pytest.MonkeyPatch) -> None:
    env = Env(
        monkeypatch, [art("c", "C", record=rec("DRAFT"), remote={"status": "LIVE"})]
    )  # 本機紀錄過時，以遠端為準
    messages = capture(monkeypatch)
    drive(env, "u")
    assert env.writes() == []
    assert any("已公開" in msg and error for msg, error in messages)


def test_public_publish_needs_the_exact_word_and_only_acts_on_the_cursor_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(monkeypatch, [art("a", "A"), art("b", "B")])
    seen: dict[str, Any] = {}
    drive(env, "space escape")  # 勾選後清除，確認清除也不影響
    drive(
        env, "space", "P p u b l i s h enter", lambda a: seen.update(screen=type(a.screen).__name__), "escape"
    )
    assert env.writes() == [] and seen["screen"] == "Confirm"  # 大小寫不符：視窗保留、沒有送出
    drive(env, "space", "P P U B L I S H enter")
    assert env.writes() == [("publish", "b", fingerprint("b"), "published")]  # 勾了 a 但游標在 b → 只公開 b


def test_missing_blog_id_blocks_uploads_but_preview_still_works(monkeypatch: pytest.MonkeyPatch) -> None:
    env = Env(monkeypatch, [art("a", "A")], blog_id="")
    messages = capture(monkeypatch)
    drive(env, "u", "P", "p")
    assert env.writes() == []
    assert any("BLOGGER_BLOG_ID" in msg for msg, _ in messages)
    assert [c[0] for c in env.calls if c[0] in {"preview", "open"}] == ["preview", "open"]
    opened = next(c[1] for c in env.calls if c[0] == "open")
    assert opened == (jobs.ROOT / "build" / "a.html").as_uri()


def test_busy_task_blocks_new_actions_and_quit_until_it_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    env = Env(monkeypatch, [art("a", "A")])
    gate, started = threading.Event(), threading.Event()

    def slow(article_id: str, fp: str, status: str) -> dict[str, Any]:
        env.calls.append(("publish", article_id, fp, status))
        started.set()
        gate.wait(5)
        return {"postId": "77", "status": "DRAFT", "url": ""}

    monkeypatch.setattr(jobs, "publish", slow)

    async def go() -> None:
        app = tui.BM()
        async with app.run_test(size=(160, 40)) as pilot:
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.press("u")
            await pilot.pause()
            await pilot.press("y")
            await pilot.pause()
            while not started.is_set():
                await asyncio.sleep(0.01)
            assert app.busy
            await pilot.press("u")
            await pilot.pause()
            assert not isinstance(app.screen, tui.Confirm)  # 第二個動作被擋下
            for key in ("q", "ctrl+c"):
                await pilot.press(key)
                await pilot.pause()
                assert app.is_running  # 同步中不能離開，避免留下半完成的狀態
            gate.set()
            await app.workers.wait_for_complete()
            await pilot.pause()
            assert not app.busy
            await pilot.press("q")
            await pilot.pause()
        assert len(env.writes()) == 1

    asyncio.run(go())


def test_a_successful_upload_is_reported_as_success_even_if_the_refresh_afterwards_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(monkeypatch, [art("a", "A")])
    env.list_error[2] = RuntimeError("盤點失敗")
    messages = capture(monkeypatch)
    drive(env, "u y")
    texts = [msg for msg, _ in messages]
    assert any(msg.startswith("✓") and "A" in msg for msg in texts)
    assert any("重新整理失敗" in msg and "盤點失敗" in msg for msg in texts)
    assert not any(msg.startswith("✗") for msg in texts)


def test_confirmation_cannot_be_answered_when_the_terminal_is_too_small_to_show_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(monkeypatch, [art("a", "A")])
    drive(env, "u y", size=(40, 12))
    assert env.writes() == []
    drive(env, "P P U B L I S H enter", size=(40, 12))
    assert env.writes() == []


def test_warnings_from_the_cli_stay_visible_and_refresh_failure_keeps_the_old_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(monkeypatch, [art("a", "A")])
    env.warnings = ["無法核對 Blogger 遠端狀態：找不到有效 Google 憑證"]
    env.list_error[2] = RuntimeError("連線失敗")
    seen: dict[str, Any] = {}
    drive(
        env,
        lambda a: seen.update(status=str(a.query_one("#status", tui.Static).render())),
        "r",
        lambda a: seen.update(rows=cells(a)),
    )
    assert "無法核對 Blogger 遠端狀態" in seen["status"]
    assert [r[3] for r in seen["rows"]] == ["A"]  # r 失敗時畫面仍保留上一份列表


def test_preview_does_not_need_credentials_and_uses_the_listed_fingerprint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = Env(monkeypatch, [art("a", "A")])
    drive(env, "p")
    assert ("preview", "a", fingerprint("a")) in env.calls
    assert env.writes() == []
