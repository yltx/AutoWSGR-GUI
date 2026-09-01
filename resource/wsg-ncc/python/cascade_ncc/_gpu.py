"""Shared wgpu-py plumbing for the three GPU stages.

WebGPU (wgpu-py) backend: one WGSL source is translated at runtime by
wgpu-native's naga compiler to MSL (Metal) / SPIR-V (Vulkan) / HLSL (DX12)
and the compiled pipeline is cached on the device — there is no per-backend
shader source to maintain. The Python host code is fully backend-agnostic.

Buffer-index note: WGSL kernels address their arguments as ``@binding(i)``;
the Python side must bind buffers in exactly that order. That contract lives
in the per-stage ``set_buffers`` calls and the WGSL comments — reordering
either side without the other breaks silently.
"""

from __future__ import annotations

import threading

import numpy as np

try:
    import wgpu
    try:  # wgpu-py <= 0.31
        import wgpu.backends.rs
    except ImportError:
        try:  # wgpu-py >= 0.32
            import wgpu.backends.wgpu_native
        except ImportError:
            import wgpu.backends.auto
except ImportError:  # pragma: no cover - wgpu not installed
    wgpu = None

THREADS = 256  # compile-time @workgroup_size for all kernels

# Every buffer is STORAGE (compute r/w) + COPY_DST (queue.write_buffer upload)
# + COPY_SRC (queue.read_buffer readback). Covers all four use cases.
# Built lazily so the module imports (and the recognizer can fall back to CPU)
# even when wgpu is not installed.
ALL_USAGE = None
if wgpu is not None:
    ALL_USAGE = (
        wgpu.BufferUsage.STORAGE
        | wgpu.BufferUsage.COPY_DST
        | wgpu.BufferUsage.COPY_SRC
    )


class GpuError(RuntimeError):
    """wgpu is unavailable, or a device/shader/pipeline/command failed."""


def require_gpu(component: str) -> None:
    """Raise GpuError unless wgpu is importable on this platform."""
    if wgpu is None:
        raise GpuError(f"{component} requires the 'wgpu' package (pip install wgpu)")


def _request_adapter():
    """request_adapter, using the *_sync variant on wgpu-py >= 0.32."""
    gpu = wgpu.gpu
    if hasattr(gpu, "request_adapter_sync"):
        return gpu.request_adapter_sync(power_preference="high-performance")
    return gpu.request_adapter(power_preference="high-performance")


def _request_device(adapter):
    if hasattr(adapter, "request_device_sync"):
        return adapter.request_device_sync()
    return adapter.request_device()


_shared_device = None
_device_lock = threading.Lock()

# Serializes GPU command submission + working-buffer access across threads.
# The shared device, shared GpuPreprocess, and per-stage working buffers are
# not thread-safe — concurrent recognize() calls must not interleave.
GPU_LOCK = threading.Lock()


def default_device():
    """Return the process-wide default device, created once and shared.

    Multiple codebook recognizers reuse the same device, so the compiled
    pipelines (naga's WGSL -> native translation) and the adapter/device
    overhead are shared rather than duplicated per codebook.
    """
    global _shared_device
    if _shared_device is None:
        with _device_lock:
            if _shared_device is None:
                _shared_device = _create_device()
    return _shared_device


def _create_device():
    """Create one adapter device or raise GpuError."""
    try:
        adapter = _request_adapter()
    except Exception as exc:
        raise GpuError(f"no wgpu adapter: {exc}") from exc
    if adapter is None:
        raise GpuError("no wgpu adapter (no Vulkan/Metal/DX12 device)")
    try:
        return _request_device(adapter)
    except Exception as exc:
        raise GpuError(f"no wgpu device: {exc}") from exc


def compile_module(device, wgsl: str, component: str):
    """Create a shader module from a WGSL source string (naga translates at
    pipeline-creation time to the active backend)."""
    try:
        return device.create_shader_module(code=wgsl)
    except Exception as exc:
        raise GpuError(f"{component}: WGSL compile error: {exc}") from exc


def _bind_group_layout(device, bindings):
    """bindings: per-slot 'read-only-storage' | 'storage' string."""
    entries = [
        {"binding": i, "visibility": wgpu.ShaderStage.COMPUTE,
         "buffer": {"type": t, "has_dynamic_offset": False}}
        for i, t in enumerate(bindings)
    ]
    return device.create_bind_group_layout(entries=entries)


def make_pipeline(device, module, entry: str, component: str, bindings):
    """Compute pipeline for one WGSL entry, with an explicit bind-group layout."""
    bgl = _bind_group_layout(device, bindings)
    layout = device.create_pipeline_layout(bind_group_layouts=[bgl])
    try:
        pipe = device.create_compute_pipeline(
            layout=layout,
            compute={"module": module, "entry_point": entry},
        )
    except Exception as exc:
        raise GpuError(f"{component}: pipeline error: {exc}") from exc
    return pipe, bgl


def make_pipelines(device, module, entries, component: str) -> dict:
    """entries: {kernel_name: [binding-types...]} -> {name: (pipeline, bgl)}."""
    return {name: make_pipeline(device, module, name, component, binds)
            for name, binds in entries.items()}


def create_buffer(device, size: int):
    return device.create_buffer(size=size, usage=ALL_USAGE)


def upload(device, buf, data) -> None:
    """Copy a numpy array or bytes into a buffer (blocks until copied)."""
    device.queue.write_buffer(buf, 0, np.ascontiguousarray(data).tobytes())


def download(device, buf, size: int) -> memoryview:
    """Synchronous readback of the first ``size`` bytes (blocks on GPU)."""
    return device.queue.read_buffer(buf, 0, size)


def _buffer_resource(entry):
    """A plain buffer, or a (buffer, offset[, size]) tuple for offset bindings
    (lets one physical buffer serve several shader arrays at aligned offsets)."""
    if isinstance(entry, tuple):
        buf, offset = entry[0], entry[1]
        res = {"buffer": buf, "offset": offset}
        if len(entry) > 2:
            res["size"] = entry[2]
        return res
    return entry


def make_bind_group(device, bgl, buffers):
    return device.create_bind_group(
        layout=bgl,
        entries=[{"binding": i, "resource": _buffer_resource(b)}
                 for i, b in enumerate(buffers)],
    )


def enqueue(pass_, device, pipeline, bgl, buffers, groups) -> None:
    """Record one kernel into an existing compute pass.

    ORDER OF ``buffers`` MUST MATCH the kernel's ``@binding(i)`` declarations —
    see the binding tables in each gpu_*.py WGSL source. ``groups`` is a 1D
    count or a (x, y, z) tuple for a multi-dimensional dispatch.
    """
    pass_.set_pipeline(pipeline)
    pass_.set_bind_group(0, make_bind_group(device, bgl, buffers))
    if isinstance(groups, tuple):
        pass_.dispatch_workgroups(*groups)
    else:
        pass_.dispatch_workgroups(groups, 1, 1)


def dispatch(device, pipeline, bgl, buffers, groups) -> None:
    """Standalone dispatch: own encoder + pass, submit (no explicit wait)."""
    encoder = device.create_command_encoder()
    pass_ = encoder.begin_compute_pass()
    enqueue(pass_, device, pipeline, bgl, buffers, groups)
    pass_.end()
    device.queue.submit([encoder.finish()])
