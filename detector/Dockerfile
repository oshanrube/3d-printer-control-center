# Obico failure detector (ml_api) running on the Orange Pi's RK3566 NPU.
#
# Same detector and API as Obico's self-hosted ml_api (GET /p/?img=<url>, GET /hc/),
# but inference runs on the NPU via Rockchip's RKNN Lite runtime, using a model converted
# for the RK3566 (see convert.py). The model file is mounted from the data drive, not
# baked in.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3-pip curl git libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Rockchip NPU runtime. Pinned to the same file and checksum Obico's rk3588 base uses;
# it pairs with rknn-toolkit-lite2 2.3.2 below.
RUN curl -fsSL -o /usr/lib/librknnrt.so \
      https://github.com/airockchip/rknn-toolkit2/raw/59a913d172e7f5ff03c9076e2ec7b1b1288ffd08/rknpu2/runtime/Linux/librknn_api/aarch64/librknnrt.so \
 && echo "d31fc19c85b85f6091b2bd0f6af9d962d5264a4e410bfb536402ec92bac738e8  /usr/lib/librknnrt.so" | sha256sum -c - \
 && chmod 755 /usr/lib/librknnrt.so

# Obico ml_api source, pinned to the commit validated against the bc250 (CPU/ONNX) detector.
ARG OBICO_COMMIT=df8190ef7500459599ebf398c3d1f653754792fd
RUN git init -q /src && cd /src \
 && git remote add origin https://github.com/TheSpaghettiDetective/obico-server.git \
 && git fetch -q --depth 1 origin $OBICO_COMMIT && git checkout -q FETCH_HEAD \
 && cp -r /src/ml_api /app && rm -rf /src

WORKDIR /app
RUN pip install --no-cache-dir -r requirements.txt \
      rknn-toolkit-lite2==2.3.2 opencv-python-headless==4.12.0.88

# Model: mounted at /model_cache/ml_api/rknn/model-weights.rknn (the only backend present,
# so Obico's loader picks RKNN). Listen on localhost only; the Pi's backend is the client.
EXPOSE 3333
CMD ["gunicorn", "--bind", "127.0.0.1:3333", "--workers", "1", "--timeout", "120", "wsgi"]
