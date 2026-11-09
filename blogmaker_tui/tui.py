"""互動式 TUI（在 Mac 上跑）：看文章、離線預覽、上傳 Blogger 草稿、公開文章。

畫面只負責呈現與按鍵；所有動作在 jobs.py（再交給 Node 的 src/article-cli.mjs）。耗時動作都放在背景執行緒，
不會卡住畫面。文章標題與內文可能來自影片流程，一律當純文字顯示，不讓其中的 [標記] 被當成格式。
"""

import webbrowser
from collections.abc import Callable
from typing import Any, ClassVar

from rich.text import Text
from textual import events, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import DataTable, Footer, Header, Input, Label, Static

from . import jobs

CATEGORIES = ["all", "tech", "kids", "husky", "other"]
CATEGORY_ZH = {"all": "全部", "tech": "Tech", "kids": "兒童", "husky": "Husky", "other": "未分類"}
STATUS_ZH = {"DRAFT": "草稿", "LIVE": "已公開", "SCHEDULED": "排程中", "UNKNOWN": "待確認"}
MIN_WIDTH, MIN_HEIGHT = 50, 16  # 確認視窗在更小的終端機會被截掉，這時不接受確認


def state_text(article: dict[str, Any]) -> str:
    """優先顯示 Blogger 遠端的實際狀態；只有本機紀錄時標明「本機紀錄」，與遠端不同時標明「紀錄過時」。"""
    record, remote = article["record"], article["remote"]
    if not record:
        return "未上傳"
    text: str
    if remote and remote.get("error"):
        text = "遠端找不到" if "404" in remote["error"] else "遠端讀取失敗"
    elif remote and remote.get("status"):
        text = STATUS_ZH.get(remote["status"]) or str(remote["status"])
        if remote["status"] != record["status"]:
            text += "·紀錄過時"
    else:
        text = f"{STATUS_ZH.get(record['status'], '有紀錄')}（本機紀錄）"
    return text + ("·有修改" if article["changed"] else "")


def is_live(article: dict[str, Any]) -> bool:
    """已公開或排程的文章不能用草稿動作處理（Node 端也會擋，這裡先過濾以免整批失敗）。"""
    remote, record = article["remote"], article["record"]
    status = (remote or {}).get("status") or (record or {}).get("status")
    return status in {"LIVE", "SCHEDULED"}


def detail_text(article: dict[str, Any]) -> Text:
    """回傳 Text 而不是含標記的字串：標題與內文是不受信任的文字，不能進 Textual 的標記解析器。"""
    record, remote = article["record"], article["remote"]
    if remote is None:
        remote_line = "未核對"
    elif remote.get("error"):
        remote_line = f"讀取失敗：{remote['error']}"
    else:
        remote_line = STATUS_ZH.get(remote.get("status"), str(remote.get("status")))
    lines = [
        f"檔案：{article['path']}　分類：{CATEGORY_ZH.get(article['category'], article['category'])}　日期：{article['date'] or '-'}",
        f"標籤：{'、'.join(article['labels']) or '-'}",
        f"狀態：{state_text(article)}",
        f"本機發布紀錄：{STATUS_ZH.get(record['status'], record['status']) if record else '無'}　Blogger 遠端：{remote_line}",
    ]
    if url := (remote or {}).get("url") or (record or {}).get("url"):
        lines.append(f"Blogger 網址：{url}")
    lines += ["", article["summary"] or "（沒有摘要）", "", article["body"]]
    return Text.assemble((article["title"], "bold"), "\n", "\n".join(lines))


class Confirm(ModalScreen[bool]):
    """確認視窗：一般按 y 確認、n／Esc 取消；require 有值時必須輸入該字串才能確認（用在公開文章）。"""

    BINDINGS: ClassVar[list[Binding]] = [Binding("escape", "cancel", "取消")]

    def __init__(self, message: str, require: str | None = None) -> None:
        super().__init__()
        self.message, self.require = message, require

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Label(self.message, markup=False)  # 訊息內含文章標題，不當標記解析
            if self.require:
                yield Input(placeholder=f"輸入 {self.require} 後按 Enter 確認，Esc 取消")
            else:
                yield Label("[b]y[/b] 確認　　[b]n[/b] 或 [b]Esc[/b] 取消")

    def _fits(self) -> bool:
        """終端機太小時，視窗內容會被截掉；看不到完整的文章與目標就不能確認。"""
        size = self.app.size
        if size.width >= MIN_WIDTH and size.height >= MIN_HEIGHT:
            return True
        self.app.notify(
            "終端機太小，看不到完整確認內容；請放大後再確認（Esc 取消）", severity="warning", markup=False
        )
        return False

    def on_key(self, event: events.Key) -> None:
        if not self.require and event.key in ("y", "n"):
            event.stop()
            if event.key == "n" or self._fits():
                self.dismiss(event.key == "y")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.value != self.require:
            self.app.notify(
                f"確認文字不符；請輸入 {self.require}（全大寫）後按 Enter，或按 Esc 取消",
                severity="warning",
                markup=False,
            )
        elif self._fits():
            self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)


class Detail(ModalScreen[None]):
    BINDINGS: ClassVar[list[Binding]] = [
        Binding("escape", "close", "關閉"),
        Binding("enter", "close", "關閉"),
        Binding("q", "close", "關閉"),
    ]

    def __init__(self, text: Text) -> None:
        super().__init__()
        self.text = text

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="dialog"):
            yield Static(self.text)
            yield Label("[b]Esc[/b] 或 [b]Enter[/b] 關閉")

    def action_close(self) -> None:
        self.dismiss(None)


class BM(App):
    TITLE = "blogMaker"
    CSS = """
    #dialog { width: 78%; max-width: 100; height: auto; max-height: 85%; padding: 1 2; border: thick $warning; background: $surface; margin: 2 0; align-horizontal: center; }
    ModalScreen { align: center middle; }
    #status { height: auto; max-height: 3; padding: 0 1; color: $text-muted; }
    """
    BINDINGS: ClassVar[list[Binding]] = [
        Binding("r", "refresh", "重新整理"),
        Binding("space", "toggle_select", "勾選"),
        Binding("escape", "clear_selection", "清除勾選", show=False),
        Binding("c", "category", "分類"),
        Binding("p", "preview", "預覽"),
        Binding("u", "upload_draft", "上傳草稿"),
        Binding("P", "publish", "公開"),
        Binding("q", "quit", "離開"),
        Binding("ctrl+c", "quit", "離開", show=False, priority=True),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.theme = "ansi-light"  # 不畫 truecolor 底色，淺色／深色都跟著終端機主題走
        self.data: list[dict[str, Any]] = []
        self.blog_id = ""
        self.warnings: list[str] = []
        self.category = "all"
        self.selected: set[str] = set()  # 勾選的文章 id；u 會批次上傳草稿
        self.busy = False  # 有動作在背景執行時，不接受新的動作也不能離開

    # ----- 畫面 -----
    def compose(self) -> ComposeResult:
        yield Header()
        yield DataTable(cursor_type="row", zebra_stripes=True)
        yield Static("載入中…", id="status")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one(DataTable).add_columns("選", "狀態", "分類", "標題", "標籤", "日期", "檔案")
        self.action_refresh()  # 不設定時鐘自動更新：每次盤點都會逐篇向 Blogger 查狀態，只在開啟、按 r 與動作完成後執行

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Enter 會被表格攔截（選取列），所以用這個事件開詳情，而不是 App 層的快捷鍵。"""
        self.action_detail()

    def say(self, msg: str, error: bool = False) -> None:
        self.query_one("#status", Static).update(Text(msg))  # Text 不解析標記；訊息裡常有標題與錯誤原文
        self.notify(
            msg, severity="error" if error else "information", timeout=10 if error else 5, markup=False
        )

    def visible(self) -> list[dict[str, Any]]:
        return [a for a in self.data if self.category == "all" or a["category"] == self.category]

    def fill(self, result: dict[str, Any]) -> None:
        cur = self.current()
        self.blog_id, self.warnings, self.data = result["blogId"], result["warnings"], result["articles"]
        self.selected &= {a["id"] for a in self.data}  # 已經不存在的文章不保留勾選
        self.redraw(cur["id"] if cur else None)

    def redraw(self, keep: str | None = None) -> None:
        """依 self.data、分類與 self.selected 重畫表格，游標停回 keep。文字一律用 Text，不解析標記。"""
        table = self.query_one(DataTable)
        table.clear()
        rows = self.visible()
        for a in rows:
            table.add_row(
                Text("✅" if a["id"] in self.selected else "⬜"), Text(state_text(a)),
                Text(CATEGORY_ZH.get(a["category"], a["category"])), Text(a["title"]),
                Text("、".join(a["labels"])), Text(a["date"]), Text(a["path"]), key=a["id"],
            )  # fmt: skip
        if keep and any(a["id"] == keep for a in rows):
            table.move_cursor(row=table.get_row_index(keep))
        self.sub_title = f"{CATEGORY_ZH[self.category]} {len(rows)} 篇　Blog ID：{self.blog_id or '未設定'}"
        picked = f"　已勾選 {len(self.selected)} 篇（u 批次上傳草稿，Esc 清除）" if self.selected else ""
        warned = "".join(f"\n⚠ {w}" for w in self.warnings)
        self.query_one("#status", Static).update(
            Text(f"狀態以 Blogger 遠端為準（r 重新核對）　Enter=詳情　空白=勾選{picked}{warned}")
        )

    def current(self) -> dict[str, Any] | None:
        table = self.query_one(DataTable)
        if not self.data or table.row_count == 0:
            return None
        key = table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value
        return next((a for a in self.data if a["id"] == key), None)

    # ----- 背景工作 -----
    @work(thread=True, exclusive=True, group="refresh")
    def action_refresh(self) -> None:
        try:
            result = jobs.articles()
        except Exception as error:  # noqa: BLE001 連線失敗等任何錯誤都只顯示訊息，不讓 TUI 掛掉；畫面保留上一份列表
            self.call_from_thread(self.say, f"重新整理失敗：{error}（按 r 重試）", True)
            return
        self.call_from_thread(self.fill, result)

    def run_task(self, label: str, fn: Callable[[], object]) -> None:
        self.busy = True
        self.background(label, fn)

    @work(thread=True, group="task")
    def background(self, label: str, fn: Callable[[], object]) -> None:  # 不能叫 _task：App 內部已有同名屬性
        self.call_from_thread(self.say, f"{label}…")
        try:
            result = fn()
        except Exception as error:  # noqa: BLE001 任何失敗都要顯示給使用者，並照常重新整理
            self.call_from_thread(self.say, f"✗ {label}失敗：{error}", True)
            # 通知 10 秒就消失，長訊息來不及看：另外用視窗留著，按 Esc 才關
            self.call_from_thread(
                self.push_screen, Detail(Text.assemble((f"✗ {label}失敗", "bold"), f"\n\n{error}"))
            )
        else:
            self.call_from_thread(self.say, f"✓ {label}完成" + (f"：{result}" if result else ""))
        finally:
            self.call_from_thread(self._finish)

    def _finish(self) -> None:
        # 先解除 busy 再重新整理；重新整理失敗只會另外顯示，不會把已成功的動作改成失敗。
        self.busy = False
        self.action_refresh()

    def ask(self, message: str, then: Callable[[], None], require: str | None = None) -> None:
        self.push_screen(Confirm(message, require), lambda ok: then() if ok else self.say("已取消，沒有送出"))

    def _free(self) -> bool:
        """彈窗開著或有動作在執行時，不接受新的動作（App 層的快捷鍵在彈窗上也會觸發）。"""
        if len(self.screen_stack) > 1:
            return False
        if self.busy:
            self.say("正在處理上一個動作，請等結果出現後再操作", True)
            return False
        return True

    def _can_write(self) -> bool:
        if not self._free():
            return False
        if not (self.blog_id.isascii() and self.blog_id.isdigit()):
            self.say("請先設定 BLOGGER_BLOG_ID 與 Blogger OAuth（見 docs/blogger.md）；p 仍可離線預覽", True)
            return False
        return True

    # ----- 動作 -----
    def action_detail(self) -> None:
        if (a := self.current()) and self._free():
            self.push_screen(Detail(detail_text(a)))

    def action_toggle_select(self) -> None:
        if not (a := self.current()) or not self._free():
            return
        self.selected ^= {a["id"]}
        self.redraw(a["id"])
        self.query_one(DataTable).action_cursor_down()  # 連按空白可以一路往下勾

    def action_clear_selection(self) -> None:
        if self.selected and self._free():
            self.selected.clear()
            cur = self.current()
            self.redraw(cur["id"] if cur else None)

    def action_category(self) -> None:
        if not self._free():
            return
        self.category = CATEGORIES[(CATEGORIES.index(self.category) + 1) % len(CATEGORIES)]
        self.selected.clear()  # 換分類時清除勾選，避免批次上傳到畫面上看不見的文章
        self.redraw()

    def action_preview(self) -> None:
        if not (a := self.current()) or not self._free():
            return

        def open_preview() -> str:
            path = jobs.preview(a["id"], a["fingerprint"])
            webbrowser.open(path.as_uri())
            return path.name

        self.run_task(f"產生預覽「{a['title']}」", open_preview)

    def action_upload_draft(self) -> None:
        if not self._can_write():
            return
        current = self.current()
        chosen = (
            [a for a in self.data if a["id"] in self.selected]
            if self.selected
            else [current]
            if current
            else []
        )
        if not chosen:
            return
        todo = [a for a in chosen if not is_live(a)]
        if not todo:
            return self.say("已公開或排程的文章不能用草稿動作取消公開；請到 Blogger 處理", True)
        lines = [
            f"上傳 {len(todo)} 篇到 Blogger 草稿？　目標 Blog ID：{self.blog_id}",
            *(f"  {a['title']}　{a['path']}" for a in todo[:10]),
        ]
        if len(todo) > 10:
            lines.append(f"  …另 {len(todo) - 10} 篇")
        if len(chosen) > len(todo):
            lines.append(f"（另 {len(chosen) - len(todo)} 篇已公開或排程，已略過）")
        lines.append("使用目前的 Markdown，不呼叫 AI，不會公開文章。")

        def run() -> str:
            failed: list[str] = []
            for a in todo:
                try:
                    jobs.publish(a["id"], a["fingerprint"], "draft")
                except Exception as error:  # noqa: BLE001 單篇失敗不中斷其餘，最後一起回報
                    failed.append(f"{a['title']}：{error}")
                else:
                    # 成功的取消勾選，失敗的保留方便重試；用 lambda 是因為 call_from_thread 取不到內建方法的簽名
                    self.call_from_thread(lambda article_id=a["id"]: self.selected.discard(article_id))
            if failed:
                raise RuntimeError(
                    f"成功 {len(todo) - len(failed)} 篇、失敗 {len(failed)} 篇\n" + "\n".join(failed)
                )
            return f"{len(todo)} 篇"

        label = f"上傳草稿「{todo[0]['title']}」" if len(todo) == 1 else f"上傳 {len(todo)} 篇草稿"
        self.ask("\n".join(lines), lambda: self.run_task(label, run))

    def action_publish(self) -> None:
        if not self._can_write() or not (a := self.current()):
            return
        others = "\n（已勾選的其他文章不會處理）" if self.selected - {a["id"]} else ""
        message = (
            "公開／更新公開文章？任何人都可能看見內容。\n"
            f"文章：{a['title']}\n檔案：{a['path']}\n目標 Blog ID：{self.blog_id}\n"
            "只處理游標所在這一篇，使用目前的 Markdown，不呼叫 AI。\n"
            f"影片的公開可見性須另到影片平台確認。{others}"
        )

        def run() -> str:
            receipt = jobs.publish(a["id"], a["fingerprint"], "published")
            return f"Post ID {receipt['postId']}"

        self.ask(message, lambda: self.run_task(f"公開「{a['title']}」", run), require="PUBLISH")

    async def action_quit(self) -> None:
        if self.busy:
            self.say(
                "同步尚未完成，中途離開會留下需要核對的狀態；請等結果出現。真的卡住時可關閉終端機，重開後按 r 核對。",
                True,
            )
            return
        self.exit()


def run() -> None:
    BM().run()
