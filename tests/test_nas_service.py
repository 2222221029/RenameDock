import tempfile
import threading
import time
import unittest
from pathlib import Path

from nas_renamer_service import HistoryStore, PathGuard, RenameManager, Scanner, ServiceError, preview


class NasServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "config"
        self.data = self.root / "data"
        self.data.mkdir()
        self.guard = PathGuard([str(self.data)])

    def tearDown(self):
        self.temp.cleanup()

    def test_guard_rejects_escape(self):
        with self.assertRaises(ServiceError):
            self.guard.resolve(self.root)

    def test_scan_filters_and_marks_duplicates(self):
        (self.data / "A01.txt").write_text("same", encoding="utf-8")
        (self.data / "A02.txt").write_text("same", encoding="utf-8")
        (self.data / "photo.jpg").write_bytes(b"jpg")
        items = Scanner(self.guard).scan(
            {"path": str(self.data), "extensions": "txt", "name_regex": "^A", "deduplicate": True}
        )
        self.assertEqual([item["old_name"] for item in items], ["A01.txt", "A02.txt"])
        self.assertEqual(items[1]["duplicate_of"], str(self.data / "A01.txt"))

    def test_classic_and_template_rules_are_ordered(self):
        source = self.data / "hello.txt"
        source.write_text("content", encoding="utf-8")
        items = preview(
            self.guard,
            [str(source)],
            [
                {"type": "Case", "enabled": True, "params": {"mode": "upper"}},
                {"type": "Template", "enabled": True, "params": {"template": "{name}_{n:03d}"}},
            ],
        )
        self.assertEqual(items[0]["new_name"], "HELLO_001.txt")

    def test_missing_optional_media_tag_expands_to_blank(self):
        source = self.data / "plain.txt"
        source.write_text("content", encoding="utf-8")
        items = preview(
            self.guard,
            [str(source)],
            [{"type": "Template", "enabled": True, "params": {"template": "{artist}_{name}"}}],
        )
        self.assertEqual(items[0]["new_name"], "_plain.txt")

    def test_two_phase_swap_and_undo(self):
        first = self.data / "first.txt"
        second = self.data / "second.txt"
        first.write_text("FIRST", encoding="utf-8")
        second.write_text("SECOND", encoding="utf-8")
        manager = RenameManager(self.guard, HistoryStore(self.config))
        job = manager.start(
            [
                {"path": str(first), "new_name": "second.txt", "checked": True},
                {"path": str(second), "new_name": "first.txt", "checked": True},
            ],
            "error",
        )
        deadline = time.time() + 3
        while manager.get(job.id).state in {"queued", "running", "paused"} and time.time() < deadline:
            time.sleep(0.02)
        result = manager.get(job.id)
        self.assertEqual(result.state, "completed", result.error)
        self.assertEqual(first.read_text(encoding="utf-8"), "SECOND")
        self.assertEqual(second.read_text(encoding="utf-8"), "FIRST")
        manager.undo(result.result["batch"]["id"])
        self.assertEqual(first.read_text(encoding="utf-8"), "FIRST")
        self.assertEqual(second.read_text(encoding="utf-8"), "SECOND")

    def test_auto_conflict_keeps_existing_target(self):
        source = self.data / "source.txt"
        target = self.data / "target.txt"
        source.write_text("SOURCE", encoding="utf-8")
        target.write_text("TARGET", encoding="utf-8")
        manager = RenameManager(self.guard, HistoryStore(self.config))
        job = manager.start(
            [{"path": str(source), "new_name": "target.txt", "checked": True}], "auto"
        )
        deadline = time.time() + 3
        while manager.get(job.id).state in {"queued", "running", "paused"} and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(manager.get(job.id).state, "completed")
        self.assertEqual(target.read_text(encoding="utf-8"), "TARGET")
        self.assertEqual((self.data / "target (1).txt").read_text(encoding="utf-8"), "SOURCE")

    def test_cancelled_staging_restores_sources(self):
        source = self.data / "a.txt"
        source.write_text("A", encoding="utf-8")
        pause = threading.Event()
        pause.set()
        cancel = threading.Event()
        cancel.set()
        completed = RenameManager._run_pairs(
            [(source, self.data / "b.txt")], pause, cancel, lambda *_: None
        )
        self.assertEqual(completed, [])
        self.assertTrue(source.exists())


if __name__ == "__main__":
    unittest.main()

