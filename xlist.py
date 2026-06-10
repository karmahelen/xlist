# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "flask",
#     "pywebview",
#     "qtpy",
#     "PyQt6",
#     "PyQt6-WebEngine",
# ]
# ///

"""
xlist - Personal checklist app (Hearth app).

Stores lists in SQLite database (xlist.db).

Run:
    [uv run] xlist.py                 # native window
    [uv run] xlist.py --serve [port]  # LAN web access

Developer:  KarmaHelen
Contact:    xlist.primary904@passinbox.com
Support:    https://buymeacoffee.com/karmahelen
"""

import json
import re
import sqlite3
import sys
import threading
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Add parent directory so Hearth can be imported from root
sys.path.insert(0, str(BASE_DIR.parent))

from hearth import run

CONFIG_FILE = BASE_DIR / "xlist.json"

# App-level config, persisted to xlist.json (the standard Hearth per-app pattern).
# controls_collapsed — saved state of the toolbar's controls drawer (toggled directly).
# check_behavior   — what happens to an item when checked: "stay" (remain in place) or
#                    "sink" (drop below the unchecked items). Display-only; see xlist.js.
DEFAULT_CONFIG = {
    "controls_collapsed": False,
    "check_behavior": "stay",
}


def _load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            raw = f.read()
        # Tolerate trailing commas if the file was hand-edited.
        raw = re.sub(r",\s*([\]}])", r"\1", raw)
        cfg = json.loads(raw)
        # setdefault each key so configs written by older versions gain new keys.
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg
    return dict(DEFAULT_CONFIG)


def _save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


class XList:
    def __init__(self):
        self.db_path = BASE_DIR / "xlist.db"
        self.config = _load_config()
        # Serializes JSON writes in case serve-mode handles requests concurrently.
        self._config_lock = threading.Lock()
        self._init_db()

    # -- Config --

    def _save_config_locked(self):
        with self._config_lock:
            _save_config(self.config)

    def get_config(self):
        """Curated config for the frontend (mirrors xstocks' get_config pattern)."""
        return {
            "controls_collapsed": self.config["controls_collapsed"],
            "check_behavior": self.config["check_behavior"],
        }

    def set_controls_collapsed(self, collapsed):
        """Persist the controls-drawer state. Called fire-and-forget on toggle."""
        self.config["controls_collapsed"] = bool(collapsed)
        self._save_config_locked()
        return {"controls_collapsed": self.config["controls_collapsed"]}

    def set_settings(self, check_behavior):
        """Persist settings from the Settings view (Save). Batched like xstocks'
        set_settings so new settings can be added as extra params over time."""
        if check_behavior not in ("stay", "sink"):
            raise ValueError("check_behavior must be 'stay' or 'sink'")
        self.config["check_behavior"] = check_behavior
        self._save_config_locked()
        return {"check_behavior": self.config["check_behavior"]}

    # -- DB --

    def _init_db(self):
        con = self._connect()
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS lists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                position INTEGER
            )
            """
        )
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_position ON lists(position)"
        )
        # checked is a plain column on the item row, not an append-log: an item is
        # either done or not, right now, for one user — there's no history dimension
        # the way xstocks' quotes have. position preserves insertion order (lists
        # carry meaning in their ordering; alphabetizing would destroy it).
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS list_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                list_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                checked INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL,
                FOREIGN KEY (list_id) REFERENCES lists(id)
            )
            """
        )
        con.commit()
        con.close()

    def _connect(self):
        # New connection per call for thread safety in serve mode.
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    # -- Lists --

    def get_lists(self):
        """Return all lists ordered by position."""
        con = self._connect()
        rows = con.execute(
            "SELECT id, name FROM lists ORDER BY position ASC"
        ).fetchall()
        con.close()
        return [dict(r) for r in rows]

    def add_list(self, name, items=""):
        """Create a list. `items` is a raw textarea string, one item per line.
        Items are optional — an empty list is valid (add items afterward)."""
        name = name.strip()
        if not name:
            raise ValueError("List name is required")

        item_texts = [ln.strip() for ln in items.split("\n") if ln.strip()]

        con = self._connect()
        exists = con.execute(
            "SELECT id FROM lists WHERE name = ?", (name,)
        ).fetchone()
        if exists:
            con.close()
            return {"status": "name_exists"}

        next_pos = con.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM lists"
        ).fetchone()[0]
        cur = con.execute(
            "INSERT INTO lists (name, position) VALUES (?, ?)", (name, next_pos)
        )
        list_id = cur.lastrowid
        # Duplicate item text is allowed — a list item isn't an identifier the way
        # a ticker is, so "Battery" twice is legitimate. position + id distinguish them.
        for i, text in enumerate(item_texts, start=1):
            con.execute(
                "INSERT INTO list_items (list_id, text, checked, position) "
                "VALUES (?, ?, 0, ?)",
                (list_id, text, i),
            )
        con.commit()
        con.close()

        return {
            "status": "ok",
            "list": {"id": list_id, "name": name},
            "lists": self.get_lists(),
            "items": self.get_items(list_id),
        }

    def update_list(self, list_id, name, items=""):
        """Update a list's name and items.

        Reconciles items by text using a greedy positional match: each textarea
        line, in order, consumes the first not-yet-used existing row with that text
        (inheriting its checked-state); unmatched lines become new unchecked items;
        leftover existing rows are deleted. The textarea's line order drives item
        position — editing a list is also a reorder. An empty result is allowed."""
        name = name.strip()
        if not name:
            raise ValueError("List name is required")

        item_texts = [ln.strip() for ln in items.split("\n") if ln.strip()]

        con = self._connect()
        # Name conflict with a *different* list
        exists = con.execute(
            "SELECT id FROM lists WHERE name = ? AND id != ?", (name, list_id)
        ).fetchone()
        if exists:
            con.close()
            return {"status": "name_exists"}

        # Existing rows in position order — the pool we match against.
        existing = [
            dict(r)
            for r in con.execute(
                "SELECT id, text, checked FROM list_items "
                "WHERE list_id = ? ORDER BY position ASC, id ASC",
                (list_id,),
            ).fetchall()
        ]
        used = [False] * len(existing)

        # Greedy positional match. ops records the final order as ("keep", id) or
        # ("new", text), so positions can be assigned 1..N in textarea order.
        ops = []
        for text in item_texts:
            matched = False
            for i, row in enumerate(existing):
                if not used[i] and row["text"] == text:
                    used[i] = True
                    ops.append(("keep", row["id"]))
                    matched = True
                    break
            if not matched:
                ops.append(("new", text))

        leftover_ids = [existing[i]["id"] for i in range(len(existing)) if not used[i]]

        # Apply: rename, drop removed rows, then assign positions in textarea order.
        # list_items.position has no UNIQUE constraint, so direct reassignment is safe.
        con.execute("UPDATE lists SET name = ? WHERE id = ?", (name, list_id))
        if leftover_ids:
            placeholders = ",".join("?" * len(leftover_ids))
            con.execute(
                f"DELETE FROM list_items WHERE id IN ({placeholders})", leftover_ids
            )
        for pos, (kind, val) in enumerate(ops, start=1):
            if kind == "keep":
                con.execute(
                    "UPDATE list_items SET position = ? WHERE id = ?", (pos, val)
                )
            else:  # new
                con.execute(
                    "INSERT INTO list_items (list_id, text, checked, position) "
                    "VALUES (?, ?, 0, ?)",
                    (list_id, val, pos),
                )

        con.commit()
        con.close()

        return {
            "status": "ok",
            "list": {"id": list_id, "name": name},
            "lists": self.get_lists(),
            "items": self.get_items(list_id),
        }

    def delete_list(self, list_id):
        """Delete a list and its items, then renumber remaining positions to stay dense."""
        con = self._connect()
        con.execute("DELETE FROM list_items WHERE list_id = ?", (list_id,))
        con.execute("DELETE FROM lists WHERE id = ?", (list_id,))

        # Renumber remaining lists 1..N in current position order. Two-pass
        # (negate, then set positive) to avoid mid-update UNIQUE(position) conflicts.
        remaining_ids = [
            r["id"]
            for r in con.execute(
                "SELECT id FROM lists ORDER BY position ASC"
            ).fetchall()
        ]
        con.execute("UPDATE lists SET position = -position")
        for new_pos, lid in enumerate(remaining_ids, start=1):
            con.execute("UPDATE lists SET position = ? WHERE id = ?", (new_pos, lid))

        con.commit()
        con.close()
        return {"status": "deleted", "lists": self.get_lists()}

    def reorder_lists(self, ordered_ids):
        """Apply a new list ordering. `ordered_ids` must be exactly the current set
        of list ids — no missing, no extra, no duplicates."""
        if not isinstance(ordered_ids, list):
            raise ValueError("ordered_ids must be a list")

        con = self._connect()
        current_ids = {r["id"] for r in con.execute("SELECT id FROM lists").fetchall()}
        new_ids = set(ordered_ids)

        if len(ordered_ids) != len(new_ids):
            con.close()
            raise ValueError("ordered_ids contains duplicates")
        if new_ids != current_ids:
            con.close()
            raise ValueError("ordered_ids must match current list ids exactly")

        # Two-pass update to satisfy UNIQUE(position): negate all (still unique
        # since positions were unique), then set the new positive values.
        con.execute("UPDATE lists SET position = -position")
        for new_pos, lid in enumerate(ordered_ids, start=1):
            con.execute("UPDATE lists SET position = ? WHERE id = ?", (new_pos, lid))
        con.commit()
        con.close()
        return {"status": "reordered", "lists": self.get_lists()}

    # -- Items --

    def get_items(self, list_id):
        """Return a list's items in position order."""
        con = self._connect()
        rows = con.execute(
            "SELECT id, text, checked, position FROM list_items "
            "WHERE list_id = ? ORDER BY position ASC, id ASC",
            (list_id,),
        ).fetchall()
        con.close()
        return [dict(r) for r in rows]

    def add_item(self, list_id, text):
        """Append one item to an existing list."""
        text = text.strip()
        if not text:
            raise ValueError("Item text is required")
        con = self._connect()
        next_pos = con.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM list_items WHERE list_id = ?",
            (list_id,),
        ).fetchone()[0]
        con.execute(
            "INSERT INTO list_items (list_id, text, checked, position) "
            "VALUES (?, ?, 0, ?)",
            (list_id, text, next_pos),
        )
        con.commit()
        con.close()
        return {"items": self.get_items(list_id)}

    def set_checked(self, item_id, checked):
        """Toggle a single item's done-state. Frontend updates optimistically and
        fires this async, so the return value is informational."""
        val = 1 if checked else 0
        con = self._connect()
        con.execute(
            "UPDATE list_items SET checked = ? WHERE id = ?", (val, item_id)
        )
        con.commit()
        con.close()
        return {"id": item_id, "checked": val}

    def clear_list(self, list_id):
        """Reset every item in the list back to unchecked (reuse the list)."""
        con = self._connect()
        con.execute(
            "UPDATE list_items SET checked = 0 WHERE list_id = ?", (list_id,)
        )
        con.commit()
        con.close()
        return {"items": self.get_items(list_id)}


if __name__ == "__main__":
    run(
        XList(),
        frontend=str(BASE_DIR / "xlist.html"),
        title="xlist",
        port=8082,
        window={
            "width": 720,
            "height": 640,
            "min_size": (480, 400),
            "background_color": "#0f1117",
            "text_select": True,
        },
    )
