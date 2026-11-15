import base64
import binascii
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from trellis.pipelines import TrellisImageTo3DPipeline
from trellis.utils import postprocessing_utils


LOGGER = logging.getLogger("trellis_api")
MODEL_DIR = Path(__file__).resolve().parent / "trellis_api_models"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
TASK_ID_PATTERN = re.compile(r"[0-9a-f-]{36}\Z")
TASKS = {}
TASKS_LOCK = threading.Lock()
PIPELINE = None
WORKER = ThreadPoolExecutor(max_workers=1)
app = FastAPI(title="TRELLIS image-to-3D API")


def set_task(task_id, **values):
    with TASKS_LOCK:
        TASKS[task_id].update(values)


def generate_model(task_id, image):
    set_task(task_id, status="IN_PROGRESS", progress=5)
    try:
        processed_image = PIPELINE.preprocess_image(image)
        outputs = PIPELINE.run(
            processed_image,
            seed=int(time.time()) % (2**31),
            formats=["gaussian", "mesh"],
            preprocess_image=False,
            sparse_structure_sampler_params={"steps": 8, "cfg_strength": 7.5},
            slat_sampler_params={"steps": 8, "cfg_strength": 3.0},
        )
        glb = postprocessing_utils.to_glb(
            outputs["gaussian"][0],
            outputs["mesh"][0],
            # Faster settings: remove 95% of triangles (was 90%) and skip hole filling.
            # For smoother models, change back to simplify=0.9 and fill_holes=True.
            simplify=0.95,
            fill_holes=False,
            texture_size=512,
            verbose=False,
        )
        # glTF treats a missing metallicFactor as fully metallic, which renders black
        # in most viewers. Mark the surface as non-metallic before exporting.
        material = getattr(getattr(glb, "visual", None), "material", None)
        if material is not None and hasattr(material, "metallicFactor"):
            material.metallicFactor = 0.0
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        model_path = MODEL_DIR / (task_id + ".glb")
        glb.export(str(model_path))
        with model_path.open("rb") as model_file:
            if model_file.read(4) != b"glTF":
                raise RuntimeError("TRELLIS produced an invalid GLB file.")
        del outputs, glb
        set_task(
            task_id,
            status="SUCCEEDED",
            progress=100,
            modelUrl="/api/models/" + task_id,
        )
    except Exception as error:
        LOGGER.exception("TRELLIS generation failed for task %s", task_id)
        set_task(task_id, status="FAILED", error=str(error)[:500])
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


@app.on_event("startup")
def load_pipeline():
    global PIPELINE
    PIPELINE = TrellisImageTo3DPipeline.from_pretrained("microsoft/TRELLIS-image-large")
    PIPELINE.cuda()
    LOGGER.info("TRELLIS loaded on %s", torch.cuda.get_device_name(0))


@app.get("/api/status")
def get_status():
    if PIPELINE is None:
        raise HTTPException(status_code=503, detail="TRELLIS has not finished loading.")
    return {
        "provider": "TRELLIS",
        "configured": True,
        "gpu": torch.cuda.get_device_name(0),
    }


@app.post("/api/generate", status_code=202)
def create_task(payload: dict):
    encoded = payload.get("image") if isinstance(payload, dict) else None
    mime_type = payload.get("mimeType") if isinstance(payload, dict) else None
    if mime_type not in ("image/png", "image/jpeg", "image/webp"):
        raise HTTPException(status_code=400, detail="Image must be PNG, JPEG, or WebP.")
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES * 4 // 3 + 8):
        raise HTTPException(status_code=413, detail="Image must be 20 MB or smaller.")
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(status_code=400, detail="Image data is not valid base64.")
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image must be 20 MB or smaller.")
    try:
        image = Image.open(BytesIO(image_bytes)).convert("RGBA")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="Image data could not be decoded.")

    task_id = str(uuid.uuid4())
    with TASKS_LOCK:
        if any(task["status"] in ("PENDING", "IN_PROGRESS") for task in TASKS.values()):
            raise HTTPException(status_code=429, detail="A TRELLIS generation is already running.")
        TASKS[task_id] = {"status": "PENDING", "progress": 0}
    WORKER.submit(generate_model, task_id, image)
    return {"taskId": task_id}


@app.get("/api/tasks/{task_id}")
def get_task(task_id: str):
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise HTTPException(status_code=400, detail="Invalid task ID.")
    with TASKS_LOCK:
        task = TASKS.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="TRELLIS task not found.")
        return dict(task)


@app.get("/api/models/{task_id}")
def get_model(task_id: str):
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise HTTPException(status_code=400, detail="Invalid task ID.")
    model_path = MODEL_DIR / (task_id + ".glb")
    if not model_path.is_file():
        raise HTTPException(status_code=404, detail="Generated model not found.")
    return FileResponse(model_path, media_type="model/gltf-binary", filename=task_id + ".glb")
