"""
Convert Obico's ONNX failure-detection model to RKNN for the Orange Pi's RK3566 NPU.

Run (on the Pi, in a throwaway container; needs ~3 GB RAM):
  docker run --rm -v /media/nvme/printer-control-center/models:/work -v $PWD/detector:/src -w /work \
    python:3.10-slim sh -c "pip install -q rknn-toolkit2==2.3.2 && python /src/convert.py"

Matches what Obico's own RKNN backend (ml_api/lib/rknn.py) expects at runtime:
  - input: uint8 RGB, NHWC, 416x416, NOT scaled -> the /255 the ONNX path does in Python
    is folded into the model via std_values=255 (mean 0)
  - FP16, no quantization (like Obico's published rk3588 model "obico_model_no_quant"),
    so detections stay equivalent to the ONNX model
"""
import hashlib
import sys

from rknn.api import RKNN

SRC = 'model-weights-5a6b1be1fa.onnx'
SHA256 = '0a6ebd8e30dbf6a450c50f9c0a5406f04ba7eb1c99fd5996e888c78bb383b9aa'
OUT = 'obico-rk3566-fp16.rknn'

h = hashlib.sha256(open(SRC, 'rb').read()).hexdigest()
if h != SHA256:
    sys.exit(f'checksum mismatch for {SRC}: {h}')

rknn = RKNN(verbose=False)
rknn.config(mean_values=[[0, 0, 0]], std_values=[[255, 255, 255]], target_platform='rk3566')
if rknn.load_onnx(model=SRC, inputs=['input'], input_size_list=[[1, 3, 416, 416]]) != 0:
    # Model's input may not be called "input": retry with the shape taken from the file.
    rknn = RKNN(verbose=False)
    rknn.config(mean_values=[[0, 0, 0]], std_values=[[255, 255, 255]], target_platform='rk3566')
    if rknn.load_onnx(model=SRC) != 0:
        sys.exit('load_onnx failed')
if rknn.build(do_quantization=False) != 0:
    sys.exit('build failed')
if rknn.export_rknn(OUT) != 0:
    sys.exit('export failed')
print(f'OK: wrote {OUT}')
