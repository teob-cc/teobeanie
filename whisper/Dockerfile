# Teobeanie Whisper: faster-whisper needs glibc (CTranslate2 has no musl wheels), so
# this add-on is Debian-based, beside Teobeanie's Alpine image.
FROM python:3.12-slim-bookworm
ARG BUILD_VERSION=dev
LABEL io.hass.name="Teobeanie Whisper" \
      io.hass.description="Speech to text on the Home Assistant host, for Teobeanie's voice lane" \
      io.hass.type="addon" \
      io.hass.version="${BUILD_VERSION}"
# PyAV 16 dropped an open() argument faster-whisper 1.2.1 still passes (metadata_errors).
RUN pip install --no-cache-dir faster-whisper==1.2.1 "av==15.1.0"
WORKDIR /app
COPY server.py ./
ENV HF_HUB_DISABLE_TELEMETRY=1 PYTHONUNBUFFERED=1
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8200/health')" || exit 1
CMD ["python", "server.py"]
