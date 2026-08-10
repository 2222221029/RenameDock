"""Flask entry point for the NAS/Docker edition."""

from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path
from typing import Any

from flask import Flask, g, jsonify, render_template, request

from nas_renamer_service import (
    HistoryStore,
    PathGuard,
    PresetStore,
    RenameManager,
    Scanner,
    ServiceError,
    preview,
    rule_definitions,
    rule_summary,
)


BASE_DIR = Path(__file__).resolve().parent
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", BASE_DIR / ".renamedock")).resolve()
ACCESS_TOKEN = os.environ.get("RENAMEDOCK_TOKEN") or os.environ.get("NAS_RENAMER_TOKEN", "")
APP_VERSION = "1.1.1"


def read_asset_text(path: Path) -> str:
    """Read UI assets produced on Windows or Linux without crashing the homepage."""
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")

app = Flask(
    __name__,
    static_folder="static",
    static_url_path="/assets/20260810-6",
    template_folder="templates",
)
app.config.update(JSON_AS_ASCII=False, MAX_CONTENT_LENGTH=8 * 1024 * 1024)

guard = PathGuard()
scanner = Scanner(guard)
history = HistoryStore(CONFIG_DIR)
presets = PresetStore(CONFIG_DIR)
manager = RenameManager(guard, history)


@app.before_request
def require_token():
    token = ACCESS_TOKEN
    static_prefix = f"{app.static_url_path}/"
    if not token or request.path in {"/", "/api/health"} or request.path.startswith(static_prefix):
        return None
    supplied = request.headers.get("X-Access-Token", "")
    if not hmac.compare_digest(token, supplied):
        return jsonify({"ok": False, "error": "访问令牌无效"}), 401
    return None


@app.after_request
def security_headers(response):
    nonce = getattr(g, "csp_nonce", "")
    inline_policy = f" 'nonce-{nonce}'" if nonce else ""
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src 'self'{inline_policy}; style-src 'self'{inline_policy}; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'"
    )
    response.headers["X-RenameDock-Version"] = APP_VERSION
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.errorhandler(ServiceError)
def handle_service_error(error: ServiceError):
    return jsonify({"ok": False, "error": str(error)}), 400


@app.errorhandler(404)
def handle_not_found(_error):
    return jsonify({"ok": False, "error": "接口不存在"}), 404


@app.errorhandler(Exception)
def handle_unexpected(error: Exception):
    app.logger.exception("Unhandled request error")
    return jsonify({"ok": False, "error": f"服务器错误：{error}"}), 500


def payload() -> dict[str, Any]:
    return request.get_json(silent=True) or {}


@app.get("/")
def index():
    g.csp_nonce = secrets.token_urlsafe(18)
    return render_template(
        "index.html",
        token_required=bool(ACCESS_TOKEN),
        app_version=APP_VERSION,
        csp_nonce=g.csp_nonce,
        app_style=read_asset_text(BASE_DIR / "static" / "app.css"),
        app_script=read_asset_text(BASE_DIR / "static" / "app.js"),
    )


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "service": "RenameDock", "version": APP_VERSION})


@app.get("/api/bootstrap")
def api_bootstrap():
    definitions = rule_definitions()
    for definition in definitions:
        for field in definition.get("fields", []):
            if "options" in field:
                field["options"] = [list(option) for option in field["options"]]
    return jsonify(
        {
            "ok": True,
            "roots": guard.public_roots(),
            "rule_definitions": definitions,
            "presets": presets.load(),
            "history": history.load(),
        }
    )


@app.post("/api/browse")
def api_browse():
    return jsonify({"ok": True, **scanner.browse(str(payload().get("path", "")))})


@app.post("/api/scan")
def api_scan():
    items = scanner.scan(payload())
    return jsonify({"ok": True, "items": items, "count": len(items)})


@app.post("/api/preview")
def api_preview():
    data = payload()
    paths = data.get("paths") or [item.get("path") for item in data.get("items", [])]
    if not isinstance(paths, list):
        raise ServiceError("文件列表格式错误")
    items = preview(guard, [str(path) for path in paths if path], data.get("rules") or [])
    return jsonify({"ok": True, "items": items})


@app.post("/api/rules/summary")
def api_rule_summary():
    return jsonify({"ok": True, "summary": rule_summary(payload().get("rule") or {})})


@app.post("/api/jobs")
def api_start_job():
    data = payload()
    items = data.get("items")
    if not isinstance(items, list):
        raise ServiceError("执行列表格式错误")
    job = manager.start(items, str(data.get("conflict", "error")))
    return jsonify({"ok": True, "job": job.public()}), 202


@app.get("/api/jobs/<job_id>")
def api_get_job(job_id: str):
    return jsonify({"ok": True, "job": manager.get(job_id).public()})


@app.post("/api/jobs/<job_id>/<action>")
def api_control_job(job_id: str, action: str):
    controls = {"pause": manager.pause, "resume": manager.resume, "cancel": manager.cancel}
    if action not in controls:
        raise ServiceError("未知任务操作")
    return jsonify({"ok": True, "job": controls[action](job_id).public()})


@app.get("/api/history")
def api_history():
    return jsonify({"ok": True, "history": history.load()})


@app.post("/api/history/<batch_id>/undo")
def api_undo(batch_id: str):
    return jsonify({"ok": True, **manager.undo(batch_id)})


@app.get("/api/presets")
def api_presets():
    return jsonify({"ok": True, "presets": presets.load()})


@app.put("/api/presets/<name>")
def api_save_preset(name: str):
    presets.save(name, payload().get("rules") or [])
    return jsonify({"ok": True, "presets": presets.load()})


@app.delete("/api/presets/<name>")
def api_delete_preset(name: str):
    presets.delete(name)
    return jsonify({"ok": True, "presets": presets.load()})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)
