"""ros_tracker: ghi config + metrics của notebook để AI Research OS thu thành experiment run.

Một file, chỉ dùng thư viện chuẩn, Python >= 3.8. Xem docs/EXPERIMENT_TRACKING.md.

    from ros_tracker import log_config, log_metric, log_summary, finish
    log_config(lr=3e-4, batch_size=64, model={"name": "resnet18"})
    for epoch in range(10):
        ...
        log_metric(step=epoch, train_loss=loss, val_acc=acc)
    log_summary(test_acc=0.91)
    finish()

Ghi ra hai nơi (server đọc đúng định dạng này, xem apps/web/lib/experiments.ts):
  - file <output_dir>/ros_run.json = {"config": {...}, "metrics": {...}, "history": [{"step": n, ...}]}
    (output_dir = /kaggle/working nếu có, nếu không thì $ROS_OUTPUT_DIR, nếu không thì thư mục hiện tại);
  - mỗi lần log in một dòng "@@ROS_CONFIG {json}" / "@@ROS_METRIC {json}" ra stdout, dùng khi notebook
    bị crash trước khi file được ghi.
Lỗi ghi file không bao giờ làm dừng vòng lặp train: chỉ cảnh báo một lần.
"""
import atexit
import json
import math
import os
import sys
import threading
import time
from collections import deque

__all__ = ["log_config", "log_metric", "log_summary", "finish", "Tracker"]

FILE_NAME = "ros_run.json"
MAX_HISTORY = 5000      # server chỉ giữ 5000 điểm cuối
SAVE_INTERVAL = 5.0     # giây giữa hai lần ghi file (trừ lần đầu và finish())


def _warn(msg):
    try:
        print("[ros_tracker] " + msg, file=sys.stderr, flush=True)
    except Exception:
        pass


def _scalar(v):
    """numpy/torch scalar -> Python scalar (giữ nguyên nếu không chuyển được)."""
    item = getattr(v, "item", None)
    if callable(item) and not isinstance(v, (str, bytes)):
        try:
            return item()
        except Exception:
            pass
    return v


def _clean(v, depth=0):
    """Đưa giá trị config về dạng JSON hợp lệ (NaN/inf thành chuỗi, tuple thành list)."""
    v = _scalar(v)
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    if isinstance(v, dict):
        return {str(k): _clean(x, depth + 1) for k, x in v.items()} if depth < 10 else str(v)
    if isinstance(v, (list, tuple, set)):
        return [_clean(x, depth + 1) for x in v] if depth < 10 else str(v)
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def _dumps(obj):
    return json.dumps(obj, separators=(",", ":"), allow_nan=False, default=str)


class Tracker:
    def __init__(self, output_dir=None):
        self._dir = output_dir
        self._lock = threading.Lock()
        self.config = {}
        self.metrics = {}
        self.history = deque(maxlen=MAX_HISTORY)
        self._last_save = None      # None = chưa ghi lần nào -> lần đầu ghi ngay
        self._dirty = False
        self._io_warned = False
        self._value_warned = set()

    # ---- đường dẫn + ghi file ----
    def path(self):
        if self._dir is None:
            if os.path.isdir("/kaggle/working"):
                self._dir = "/kaggle/working"
            else:
                self._dir = os.environ.get("ROS_OUTPUT_DIR") or os.getcwd()
        return os.path.join(self._dir, FILE_NAME)

    def _save(self, force=False):
        now = time.monotonic()
        if not force and self._last_save is not None and now - self._last_save < SAVE_INTERVAL:
            self._dirty = True
            return
        self._last_save, self._dirty = now, False
        try:
            data = _dumps({"config": self.config, "metrics": self.metrics, "history": list(self.history)})
            path = self.path()
            tmp = os.path.join(os.path.dirname(path), "." + FILE_NAME + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(data)
            os.replace(tmp, path)   # ghi nguyên tử: không bao giờ để lại file JSON dở dang
        except Exception as e:
            if not self._io_warned:
                self._io_warned = True
                _warn("Không ghi được %s (%s). Metrics vẫn được in ra log." % (FILE_NAME, e))

    def _emit(self, kind, payload):
        try:
            print("@@ROS_%s %s" % (kind, _dumps(payload)), flush=True)
        except Exception as e:
            _warn("Không in được dòng @@ROS_%s (%s)." % (kind, e))

    def _number(self, key, v):
        """Trả về float hữu hạn, hoặc None (kèm cảnh báo một lần cho mỗi metric) nếu không hợp lệ."""
        try:
            n = float(_scalar(v))
        except Exception:
            if (key, "type") not in self._value_warned:
                self._value_warned.add((key, "type"))
                _warn("Bỏ qua metric '%s': kiểu %s không phải số." % (key, type(v).__name__))
            return None
        if not math.isfinite(n):
            if (key, "nan") not in self._value_warned:
                self._value_warned.add((key, "nan"))
                _warn("Bỏ qua metric '%s' = %s (NaN/inf). Các lần sau sẽ bỏ qua không báo." % (key, n))
            return None
        return n

    def _numbers(self, raw):
        out = {}
        for k, v in raw.items():
            k = str(k).strip()
            if not k or k == "step":
                continue
            n = self._number(k, v)
            if n is not None:
                out[k] = n
        return out

    # ---- API công khai ----
    def log_config(self, config=None, **kwargs):
        with self._lock:
            update = {}
            if config is not None:
                if not isinstance(config, dict):
                    config = getattr(config, "__dict__", None) or {"value": config}   # argparse.Namespace, ...
                update.update(config)
            update.update(kwargs)
            update = _clean(update)
            self.config.update(update)
            self._emit("CONFIG", update)
            self._save(force=True)

    def log_metric(self, step=None, metrics=None, **kwargs):
        with self._lock:
            values = self._numbers(dict(metrics or {}, **kwargs))
            if not values:
                return
            point = {}
            if step is not None:
                s = self._number("step", step)
                if s is not None:
                    point["step"] = int(s) if s.is_integer() else s
            point.update(values)
            first = not self.metrics          # metric đầu tiên được ghi ngay để file có dữ liệu sớm
            self.metrics.update(values)
            if "step" in point:
                self.history.append(point)
            self._emit("METRIC", point)
            self._save(force=first)

    def log_summary(self, metrics=None, **kwargs):
        self.log_metric(None, metrics, **kwargs)

    def finish(self):
        with self._lock:
            self._save(force=True)

    def _atexit(self):
        if self._dirty:
            self.finish()


_default = Tracker()
atexit.register(_default._atexit)


def log_config(config=None, **kwargs):
    """Gộp config (dict, argparse.Namespace hoặc keyword) vào run; config lồng nhau được giữ nguyên."""
    _default.log_config(config, **kwargs)


def log_metric(step=None, metrics=None, **kwargs):
    """Ghi metrics tại một step: log_metric(step=3, loss=0.2) hoặc log_metric(3, {"val/acc": 0.9})."""
    _default.log_metric(step, metrics, **kwargs)


def log_summary(metrics=None, **kwargs):
    """Metrics cuối cùng không có step (ví dụ test_acc)."""
    _default.log_summary(metrics, **kwargs)


def finish():
    """Ghi file ngay (gọi ở cuối notebook)."""
    _default.finish()


# Chỉ chạy demo khi gọi trực tiếp `python ros_tracker.py`; dán file vào một cell notebook sẽ không chạy demo
# (trong notebook __name__ cũng là "__main__" nhưng không có __file__).
if __name__ == "__main__" and "__file__" in globals():
    import random
    import tempfile
    out = os.environ.get("ROS_OUTPUT_DIR") or tempfile.mkdtemp(prefix="ros_demo_")
    t = Tracker(output_dir=out)
    t.log_config({"model": {"name": "demo-mlp", "layers": [64, 32]}, "optim": {"name": "adam", "lr": 3e-4}}, seed=42, nan_value=float("nan"))
    for step in range(1, 6):
        t.log_metric(step=step, train_loss=1.0 / step + random.random() * 0.01, val_acc=0.5 + step * 0.08)
    t.log_metric(step=6, train_loss=float("nan"), val_acc=0.97)
    t.log_metric(step=7, bad="abc")
    t.log_summary(test_acc=0.95)
    t.finish()
    print("Đã ghi", t.path())
