# -*- coding: utf-8 -*-
"""2048 —— 经典米色桌面版(单文件,Flet/Material)

玩法:↑↓←→ 或 WASD 移动方块,相同数字相撞合并,冲向 2048!
界面按钮与达成目标后的弹窗也可操作;最高分自动保存到本地。

运行:
    pip install flet
    python 2048_flet.py

网页版(无需 Python 环境):打开同目录的 index.html 即玩,
或访问在线地址(见 README)。
"""
from __future__ import annotations

import json
import random
from collections.abc import Iterable
from pathlib import Path
from typing import cast

import flet as ft

BEST_FILE = Path(__file__).resolve().parent / ".2048_flet_best.json"

CELL = 78          # 单元格边长
GAP = 6            # 间距

SIZE = 4           # 棋盘边长

# 经典配色:value -> (背景色, 文字色)
TILE_COLORS: dict[int, tuple[str, str]] = {
    0: ("#cdc1b4", "#cdc1b4"),
    2: ("#eee4da", "#776e65"),
    4: ("#ede0c8", "#776e65"),
    8: ("#f2b179", "#f9f6f2"),
    16: ("#f59563", "#f9f6f2"),
    32: ("#f67c5f", "#f9f6f2"),
    64: ("#f65e3b", "#f9f6f2"),
    128: ("#edcf72", "#f9f6f2"),
    256: ("#edcc61", "#f9f6f2"),
    512: ("#edc850", "#f9f6f2"),
    1024: ("#edc53f", "#f9f6f2"),
    2048: ("#edc22e", "#f9f6f2"),
}
COLOR_FALLBACK = ("#3c3a32", "#f9f6f2")     # 超过 2048 的方块


# ============================ 游戏核心逻辑 ============================ #
class Game:
    """一个 4x4 的 2048 对局(纯逻辑,不含任何界面代码)。"""

    DIRECTIONS = ("left", "right", "up", "down")

    def __init__(self, size: int = SIZE) -> None:
        self.size = size
        self.score = 0
        self.best = 0
        self.won = False          # 是否已达成 2048(只庆祝一次)
        self.over = False         # 无路可走
        self.grid: list[list[int]] = [[0] * size for _ in range(size)]
        self.reset()

    def reset(self) -> None:
        """开新局。"""
        self.score = 0
        self.won = False
        self.over = False
        self.grid = [[0] * self.size for _ in range(self.size)]
        self.spawn()
        self.spawn()

    def spawn(self) -> None:
        """在随机空格放一个新方块:90% 是 2,10% 是 4。"""
        empty = [(r, c) for r in range(self.size)
                 for c in range(self.size) if self.grid[r][c] == 0]
        if not empty:
            return
        r, c = random.choice(empty)
        self.grid[r][c] = 4 if random.random() < 0.1 else 2

    @staticmethod
    def _slide_line(line: list[int]) -> tuple[list[int], int]:
        """把一行向左压缩+合并,返回 (新行, 本次得分)。"""
        tiles = [v for v in line if v]
        out: list[int] = []
        gained = 0
        i = 0
        while i < len(tiles):
            if i + 1 < len(tiles) and tiles[i] == tiles[i + 1]:
                merged = tiles[i] * 2
                out.append(merged)
                gained += merged
                i += 2
            else:
                out.append(tiles[i])
                i += 1
        out += [0] * (len(line) - len(out))
        return out, gained

    def move(self, direction: str) -> bool:
        """向指定方向滑动。返回棋盘是否有变化。"""
        if direction not in self.DIRECTIONS:
            raise ValueError(f"unknown direction: {direction}")

        n = self.size
        lines = [row[:] for row in self.grid]
        if direction in ("right", "down"):
            lines = [list(reversed(row)) for row in lines]
        if direction in ("up", "down"):
            lines = [list(col) for col in zip(*lines)]

        moved = False
        gained_total = 0
        new_lines: list[list[int]] = []
        for line in lines:
            new_line, gained = self._slide_line(line)
            gained_total += gained
            if new_line != line:
                moved = True
            new_lines.append(new_line)

        if not moved:
            return False

        if direction in ("up", "down"):
            new_lines = [list(col) for col in zip(*new_lines)]
        if direction in ("right", "down"):
            new_lines = [list(reversed(row)) for row in new_lines]

        self.grid = new_lines
        self.score += gained_total
        self.best = max(self.best, self.score)

        if any(2048 in row for row in self.grid):
            self.won = True

        self.spawn()
        self.over = not self.moves_available()
        return True

    def moves_available(self) -> bool:
        """还有没有任何一步可走?"""
        n = self.size
        for r in range(n):
            for c in range(n):
                v = self.grid[r][c]
                if v == 0:
                    return True
                if c + 1 < n and self.grid[r][c + 1] == v:
                    return True
                if r + 1 < n and self.grid[r + 1][c] == v:
                    return True
        return False


# ============================== 界面层 ============================== #
def load_best() -> int:
    try:
        return int(json.loads(BEST_FILE.read_text("utf-8"))["best"])
    except Exception:
        return 0


def save_best(best: int) -> None:
    try:
        BEST_FILE.write_text(json.dumps({"best": best}), "utf-8")
    except Exception:
        pass


def font_for(value: int) -> int:
    """按位数自适应字号。"""
    digits = len(str(value)) if value else 1
    return 30 if digits <= 2 else 25 if digits == 3 else 20


def make_cell() -> tuple[ft.Container, ft.Text]:
    """创建一个格子,返回 (容器, 文字) 引用对——之后直接改属性刷新,
    不必再从 container.content 里取,免去类型收窄。"""
    text = ft.Text("", size=30, weight=ft.FontWeight.BOLD)
    container = ft.Container(
        width=CELL,
        height=CELL,
        border_radius=8,
        bgcolor="#CDC1B4",
        alignment=ft.Alignment.CENTER,
        content=text,
    )
    return container, text


def as_controls(children: Iterable[ft.Control]) -> list[ft.Control]:
    """把子控件列表显式声明为 list[Control]。

    flet 的参数类型声明为不可变的 ``list[Control]`` 而非协变的
    ``Sequence``,导致 ``list[Row]`` / ``list[Container]`` 传参时
    Pylance 误报。cast 只是给类型检查器看,运行时原样传递。
    """
    return cast("list[ft.Control]", children)


class UI:
    """把 Game 渲染成 Flet 界面(经典米色主题)。"""

    def __init__(self, page: ft.Page) -> None:
        self.page = page
        self.game = Game()
        self.game.best = load_best()
        self.win_dialog_shown = False

        self.cells: list[list[ft.Container]] = []
        self.cell_texts: list[list[ft.Text]] = []
        for _r in range(self.game.size):
            row_cells: list[ft.Container] = []
            row_texts: list[ft.Text] = []
            for _c in range(self.game.size):
                cell, text = make_cell()
                row_cells.append(cell)
                row_texts.append(text)
            self.cells.append(row_cells)
            self.cell_texts.append(row_texts)

        self.score_value = ft.Text("0", size=22, weight=ft.FontWeight.BOLD,
                                   color="#FFFFFF")
        self.best_value = ft.Text(str(self.game.best), size=22,
                                  weight=ft.FontWeight.BOLD, color="#FFFFFF")
        self.hint = ft.Text("", size=15, weight=ft.FontWeight.W_600,
                            color="#8F7A66")

        board = ft.Column(
            as_controls(
                [
                    ft.Row(as_controls(self.cells[r]), spacing=GAP,
                           wrap=False, alignment=ft.MainAxisAlignment.CENTER)
                    for r in range(self.game.size)
                ]
            ),
            spacing=GAP,
        )

        self.directions = ft.Row(
            [
                ft.IconButton(icon=ft.Icons.KEYBOARD_ARROW_LEFT,
                              icon_size=30,
                              on_click=lambda e, d="left": self.do_move(d)),
                ft.IconButton(icon=ft.Icons.KEYBOARD_ARROW_UP,
                              icon_size=30,
                              on_click=lambda e, d="up": self.do_move(d)),
                ft.IconButton(icon=ft.Icons.KEYBOARD_ARROW_DOWN,
                              icon_size=30,
                              on_click=lambda e, d="down": self.do_move(d)),
                ft.IconButton(icon=ft.Icons.KEYBOARD_ARROW_RIGHT,
                              icon_size=30,
                              on_click=lambda e, d="right": self.do_move(d)),
            ],
            alignment=ft.MainAxisAlignment.CENTER, spacing=4,
        )

        page.title = "2048 · Flet 版"
        page.bgcolor = "#FAF8EF"
        page.padding = 24
        if not page.web:
            page.window.width = 430
            page.window.height = 750
        page.on_keyboard_event = self.on_key
        page.add(
            ft.Row(
                [
                    ft.Text("2048", size=44, weight=ft.FontWeight.BOLD,
                            color="#776E65"),
                    ft.Container(expand=True),
                    self.score_chip("分数", self.score_value),
                    self.score_chip("最高", self.best_value),
                ],
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            ),
            ft.Row(
                [
                    ft.Text("合并方块,冲向 2048!", color="#A8997F"),
                    ft.Container(expand=True),
                    ft.Button(
                        "新游戏",
                        icon=ft.Icons.RESTART_ALT,
                        on_click=self.restart,
                        bgcolor="#8F7A66",
                        color="#FFFFFF",
                    ),
                ]
            ),
            ft.Container(height=12),
            ft.Column([board, ft.Container(height=10), self.hint,
                       self.directions],
                      horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                      spacing=2),
        )
        self.refresh()

    # ------------------------------------------------------------ #
    @staticmethod
    def score_chip(label: str, value: ft.Text) -> ft.Container:
        return ft.Container(
            bgcolor="#BBADA0",
            border_radius=8,
            padding=ft.Padding(left=16, right=16, top=6, bottom=6),
            content=ft.Column(
                [
                    ft.Text(label, size=12, color="#EEE4DA"),
                    value,
                ],
                spacing=0,
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
            ),
        )

    # ------------------------------------------------------------ #
    def refresh(self) -> None:
        g = self.game
        self.score_value.value = str(g.score)
        self.best_value.value = str(max(g.best, g.score))
        for r in range(g.size):
            for c in range(g.size):
                v = g.grid[r][c]
                text = self.cell_texts[r][c]
                bg, fg = TILE_COLORS.get(v, COLOR_FALLBACK)
                self.cells[r][c].bgcolor = bg.upper()
                text.color = fg.upper()
                text.value = str(v) if v else ""
                text.size = font_for(v)
        self.page.update()

    # ------------------------------------------------------------ #
    def on_key(self, e: ft.KeyboardEvent) -> None:
        k = e.key.lower()
        table = {
            "arrow up": "up", "w": "up",
            "arrow down": "down", "s": "down",
            "arrow left": "left", "a": "left",
            "arrow right": "right", "d": "right",
        }
        if k in table:
            self.do_move(table[k])

    def do_move(self, direction: str) -> None:
        g = self.game
        if not g.move(direction):
            return
        save_best(max(g.best, g.score))
        self.refresh()
        if g.won and not self.win_dialog_shown:
            self.show_win_dialog()
        elif g.over:
            self.show_game_over_dialog(g)

    # ------------------------------------------------------------ #
    def show_win_dialog(self) -> None:
        """达成 2048:让玩家选择继续挑战或开新局。"""
        self.win_dialog_shown = True
        dlg = ft.AlertDialog(
            modal=True,
            title=ft.Text("🎉 达成 2048!"),
            content=ft.Text(f"当前得分 {self.game.score}。\n要继续冲击更高分,"
                            f"还是开新的一局?"),
            actions=[
                ft.TextButton("继续挑战",
                              on_click=lambda e: self.close_dialog()),
                ft.Button("再来一局",
                          on_click=lambda e: self.restart_from_dialog(),
                          bgcolor="#8F7A66", color="#FFFFFF"),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.show_dialog(dlg)

    def show_game_over_dialog(self, g: Game) -> None:
        dlg = ft.AlertDialog(
            modal=True,
            title=ft.Text("游戏结束"),
            content=ft.Text(f"本局得分:{g.score}\n最高纪录:"
                            f"{max(g.best, g.score)}"),
            actions=[
                ft.Button(
                    "再来一局",
                    on_click=lambda e: self.restart_from_dialog(),
                    bgcolor="#8F7A66", color="#FFFFFF"),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.show_dialog(dlg)

    def close_dialog(self) -> None:
        self.page.pop_dialog()

    def restart_from_dialog(self) -> None:
        self.close_dialog()
        self.restart(None)

    def restart(self, _e=None) -> None:
        self.win_dialog_shown = False
        self.game.reset()
        self.refresh()


def main(page: ft.Page) -> None:
    UI(page)


if __name__ == "__main__":
    ft.run(main)
