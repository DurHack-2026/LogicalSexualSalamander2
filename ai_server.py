import base64
import binascii
import ipaddress
import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "generated_models"
MESHY_API = "https://api.meshy.ai/openapi/v1"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_REQUEST_BYTES = 30 * 1024 * 1024
MAX_IKEA_PAGE_BYTES = 10 * 1024 * 1024
TASK_ID_PATTERN = re.compile(r"[A-Za-z0-9-]{8,100}\Z")
MODEL_LOCK = threading.Lock()


def load_local_env():
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip("\"'")
        os.environ.setdefault(key.strip(), value)


load_local_env()
MESHY_API_KEY = os.environ.get("MESHY_API_KEY", "").strip()


class ServiceError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def send_provider_request(method, path, payload=None):
    if not MESHY_API_KEY:
        raise ServiceError("Meshy is not configured. Add MESHY_API_KEY to .env and restart the server.", 503)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/json",
        "Authorization": "Bearer " + MESHY_API_KEY,
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(MESHY_API + path, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=90) as response:
            raw = response.read(2 * 1024 * 1024)
    except HTTPError as error:
        detail = error.read(1024 * 1024).decode("utf-8", errors="replace")
        try:
            error_data = json.loads(detail)
            if isinstance(error_data, dict):
                detail = str(error_data.get("message") or error_data.get("error") or detail)
        except json.JSONDecodeError:
            pass
        raise ServiceError("Meshy returned HTTP {}: {}".format(error.code, detail[:500]))
    except URLError as error:
        raise ServiceError("Could not connect to Meshy: {}".format(error.reason))
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ServiceError("Meshy returned an invalid JSON response: {}".format(error))
    if not isinstance(result, dict):
        raise ServiceError("Meshy returned an unexpected response.")
    return result


def validate_public_https_url(value):
    parsed = urlsplit(value)
    host = parsed.hostname
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        raise ValueError("Image URL must be a public HTTPS URL.")
    host = host.lower()
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise ValueError("Image URL must be publicly accessible.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("Image URL must be publicly accessible.")


def validate_ikea_page_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname.lower() if parsed.hostname else ""
        port = parsed.port
    except ValueError:
        raise ValueError("Enter an HTTPS IKEA product page link.")
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or not (host == "ikea.com" or host.endswith(".ikea.com"))
    ):
        raise ValueError("Enter an HTTPS IKEA product page link.")


class IkeaRedirectBlocked(Exception):
    pass


class IkeaRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        try:
            validate_ikea_page_url(new_url)
        except ValueError:
            raise IkeaRedirectBlocked("IKEA redirected to a non-IKEA page.")
        return super().redirect_request(request, file_pointer, code, message, headers, new_url)


def fetch_ikea_page(url):
    request = Request(url, headers={
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; FurnitureRoomPlanner/1.0)",
    })
    try:
        with build_opener(IkeaRedirectHandler()).open(request, timeout=25) as response:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > MAX_IKEA_PAGE_BYTES:
                        raise ServiceError("IKEA product page is too large to process.", 413)
                except ValueError:
                    raise ServiceError("IKEA returned an invalid page size.")
            content = response.read(MAX_IKEA_PAGE_BYTES + 1)
            if len(content) > MAX_IKEA_PAGE_BYTES:
                raise ServiceError("IKEA product page is too large to process.", 413)
            return content.decode("utf-8", errors="replace")
    except HTTPError as error:
        raise ServiceError("IKEA returned HTTP {} while opening the product page.".format(error.code), 502)
    except IkeaRedirectBlocked as error:
        raise ServiceError(str(error), 502)
    except URLError as error:
        raise ServiceError("Could not connect to IKEA: {}".format(error.reason), 502)
    except OSError as error:
        raise ServiceError("Could not read the IKEA product page: {}".format(error), 502)


def validate_image_source(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Select a furniture image before generating a model.")
    if len(value) > MAX_REQUEST_BYTES:
        raise ValueError("Image is too large to send to Meshy.")
    if not value.startswith("data:"):
        validate_public_https_url(value)
        return value

    header, separator, encoded = value.partition(",")
    mime_type = header[5:].split(";", 1)[0].lower()
    if not separator or mime_type not in ("image/png", "image/jpeg", "image/webp") or not header.endswith(";base64"):
        raise ValueError("Image must be PNG, JPEG, or WebP.")
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Image data is not valid base64.")
    if not image_bytes:
        raise ValueError("Image is empty.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("Image must be 20 MB or smaller.")
    return value


def download_model(task_id, model_url):
    validate_public_https_url(model_url)
    target = MODEL_DIR / (task_id + ".glb")
    with MODEL_LOCK:
        if target.is_file():
            return target
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        temporary = MODEL_DIR / (task_id + ".glb.part")
        request = Request(model_url, headers={"User-Agent": "FurnitureRoomPlanner/1.0"})
        try:
            with urlopen(request, timeout=120) as response:
                total = 0
                with temporary.open("wb") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        output.write(chunk)
            if total < 12:
                raise ServiceError("Meshy returned an incomplete GLB model.")
            with temporary.open("rb") as model_file:
                if model_file.read(4) != b"glTF":
                    raise ServiceError("Meshy returned a file that is not a GLB model.")
            temporary.replace(target)
        except HTTPError as error:
            if temporary.exists():
                temporary.unlink()
            raise ServiceError("Could not download the generated model (HTTP {}).".format(error.code))
        except URLError as error:
            if temporary.exists():
                temporary.unlink()
            raise ServiceError("Could not download the generated model: {}".format(error.reason))
        except (OSError, ServiceError):
            if temporary.exists():
                temporary.unlink()
            raise
    return target


class PlannerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if path in ("/", "/Test.html"):
            return str(ROOT / "Test.html")
        match = re.fullmatch(r"/generated_models/([A-Za-z0-9-]{8,100})\.glb", path)
        if match:
            return str(MODEL_DIR / (match.group(1) + ".glb"))
        return str(ROOT / "__not_found__")

    def guess_type(self, path):
        if path.lower().endswith(".glb"):
            return "model/gltf-binary"
        return super().guess_type(path)

    def send_json(self, status, payload, allow_file_origin=False):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if allow_file_origin:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/ikea-page":
            values = parse_qs(urlsplit(self.path).query).get("url", [])
            if not values:
                self.send_json(400, {"error": "An IKEA product page URL is required."}, allow_file_origin=True)
                return
            try:
                validate_ikea_page_url(values[0])
            except ValueError as error:
                self.send_json(400, {"error": str(error)}, allow_file_origin=True)
                return
            try:
                content = fetch_ikea_page(values[0]).encode("utf-8")
            except ServiceError as error:
                self.send_json(error.status, {"error": str(error)}, allow_file_origin=True)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/api/status":
            self.send_json(200, {
                "provider": "Meshy",
                "configured": bool(MESHY_API_KEY),
            })
            return
        if path == "/api/models":
            models = []
            if MODEL_DIR.is_dir():
                for model_path in MODEL_DIR.iterdir():
                    if not model_path.is_file() or not TASK_ID_PATTERN.fullmatch(model_path.stem) or model_path.suffix.lower() != ".glb":
                        continue
                    stat = model_path.stat()
                    models.append({
                        "taskId": model_path.stem,
                        "modelUrl": "/generated_models/" + model_path.name,
                        "createdAt": int(stat.st_mtime * 1000),
                        "sizeBytes": stat.st_size,
                    })
            models.sort(key=lambda model: model["createdAt"], reverse=True)
            self.send_json(200, {"models": models})
            return

        task_match = re.fullmatch(r"/api/tasks/([A-Za-z0-9-]{8,100})", path)
        if task_match:
            if not MESHY_API_KEY:
                self.send_json(503, {"error": "Meshy is not configured. Add MESHY_API_KEY to .env and restart the server."})
                return
            task_id = task_match.group(1)
            try:
                result = send_provider_request("GET", "/image-to-3d/" + task_id)
                status = str(result.get("status", "")).upper()
                response = {
                    "status": status,
                    "progress": result.get("progress", 0),
                }
                if status == "FAILED":
                    task_error = result.get("task_error") or "Meshy could not generate this model."
                    response["error"] = task_error if isinstance(task_error, str) else json.dumps(task_error)
                elif status == "SUCCEEDED":
                    model_urls = result.get("model_urls")
                    model_url = model_urls.get("glb") if isinstance(model_urls, dict) else None
                    if not model_url:
                        raise ServiceError("Meshy completed the task but returned no GLB model.")
                    download_model(task_id, model_url)
                    response["modelUrl"] = "/generated_models/" + task_id + ".glb"
                self.send_json(200, response)
            except ServiceError as error:
                self.send_json(error.status, {"error": str(error)})
            return

        if path == "/" or path == "/Test.html":
            self.path = "/Test.html"
            super().do_GET()
            return
        model_match = re.fullmatch(r"/generated_models/([A-Za-z0-9-]{8,100})\.glb", path)
        if model_match:
            if not (MODEL_DIR / (model_match.group(1) + ".glb")).is_file():
                self.send_json(404, {"error": "Generated model not found."})
                return
            self.path = path
            super().do_GET()
            return
        self.send_json(404, {"error": "Not found."})

    def do_POST(self):
        if urlsplit(self.path).path != "/api/generate":
            self.send_json(404, {"error": "Not found."})
            return
        if not MESHY_API_KEY:
            self.send_json(503, {"error": "Meshy is not configured. Add MESHY_API_KEY to .env and restart the server."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid request size."})
            return
        if content_length < 1 or content_length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "Request must include an image of 20 MB or smaller."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            image_url = validate_image_source(payload.get("imageUrl") if isinstance(payload, dict) else None)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.send_json(400, {"error": str(error) or "Invalid JSON request."})
            return
        try:
            result = send_provider_request("POST", "/image-to-3d", {
                "image_url": image_url,
                "ai_model": "latest",
                "should_remesh": True,
                "target_polycount": 25000,
                "should_texture": True,
                "target_formats": ["glb"],
            })
        except ServiceError as error:
            self.send_json(error.status, {"error": str(error)})
            return
        task_id = result.get("result")
        if not isinstance(task_id, str) or not TASK_ID_PATTERN.fullmatch(task_id):
            self.send_json(502, {"error": "Meshy returned an invalid task ID."})
            return
        self.send_json(202, {"taskId": task_id})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), PlannerHandler)
    print("Furniture planner: http://{}:{}/Test.html".format(HOST, PORT))
    if not MESHY_API_KEY:
        print("AI generation is disabled until MESHY_API_KEY is set in .env.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping planner server.")
    finally:
        server.server_close()
